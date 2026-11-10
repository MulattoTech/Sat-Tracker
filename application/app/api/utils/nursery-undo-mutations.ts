import { Prisma, type PrismaClient, type FoodLog, type FoodEnjoyment } from '@prisma/client';
import type { AuthResult } from './auth';
import type { NurseryUndo } from '@/src/utils/nursery/undo';
import { assertNurseryScope, assertUndoRow, NurseryUndoError } from './nursery-undo';
import { careSnapshot } from './care-revision';
import { deletePumpSnapshot, PumpReconciliationConflict } from './pumpReconciliation';

const serializable = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 };
function isContention(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('code' in error && ['P2034', 'P1008', 'P2028'].includes(String(error.code))) return true;
  const cause = 'cause' in error ? error.cause : null;
  return !!cause && typeof cause === 'object' && 'originalCode' in cause
    && ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED'].includes(String(cause.originalCode));
}
export function nurseryMutationError(error: unknown): never {
  if (isContention(error)) throw new NurseryUndoError('Another care change is being saved. Keep this Undo and retry or review the care log.', 409, 'NURSERY_UNDO_BUSY');
  if (error instanceof PumpReconciliationConflict) throw new NurseryUndoError();
  throw error;
}

export async function requireUndoBaby(tx: Prisma.TransactionClient, auth: AuthResult, undo: NurseryUndo) {
  assertNurseryScope(auth, undo.babyId, undo.scope);
  if (!await tx.baby.findFirst({ where: { id: undo.babyId, familyId: auth.familyId!, deletedAt: null }, select: { id: true } })) {
    throw new NurseryUndoError('This child is no longer available. Nothing was undone. Review the care log.', 404, 'NURSERY_UNDO_MISSING');
  }
}

const missing = () => new NurseryUndoError('This entry is no longer available. Undo was not confirmed. Review the care log.', 404, 'NURSERY_UNDO_MISSING');

/** The original one/two-record action is one transaction. No fresh revision is
 * adopted on conflict, and a missing row never means this Undo succeeded. */
export async function undoNurseryRows(db: PrismaClient, auth: AuthResult, undo: NurseryUndo) {
  assertNurseryScope(auth, undo.babyId, undo.scope);
  try {
    const where = { id: undo.records[0].id, familyId: auth.familyId!, babyId: undo.babyId };
    // Read the candidate in autocommit, then claim it as the transaction's first
    // statement. This avoids SQLite's read-to-write lock upgrade. Every later
    // child/group check is protected by that writer and rolls the claim back.
    const transact = (claim: (tx: Prisma.TransactionClient) => Promise<void>) => db.$transaction(async tx => {
      await claim(tx);
      await requireUndoBaby(tx, auth, undo);
    }, serializable);
    if (undo.kind === 'pump') {
      const row = await db.pumpLog.findFirst({ where });
      if (!row) throw missing();
      assertUndoRow(undo, row);
      await transact(tx => deletePumpSnapshot(tx, row, undo.feed!));
    } else if (undo.kind === 'diaper') {
      const row = await db.diaperLog.findFirst({ where });
      if (!row) throw missing();
      assertUndoRow(undo, row);
      await transact(async tx => {
        if ((await tx.diaperLog.deleteMany({ where: careSnapshot('diaper', row) as Prisma.DiaperLogWhereInput })).count !== 1) throw new NurseryUndoError();
      });
    } else if (undo.kind === 'food') {
      const row = await db.foodLog.findFirst({ where });
      if (!row) throw missing();
      assertUndoRow(undo, row);
      await transact(async tx => {
        if ((await tx.foodLog.updateMany({ where: careSnapshot('food', row) as Prisma.FoodLogWhereInput,
          data: { deletedAt: new Date(), updatedAt: new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1)) } })).count !== 1) throw new NurseryUndoError();
      });
    } else {
      const sessionWhere = { sessionId: undo.sessionId!, familyId: auth.familyId!, babyId: undo.babyId };
      const found = undo.kind === 'breast'
        ? await db.feedLog.findMany({ where: sessionWhere })
        : await db.feedLog.findMany({ where });
      if (!found.length) throw missing();
      if (found.length !== undo.records.length) throw new NurseryUndoError();
      const rows = undo.records.map((expected, index) => {
        const row = found.find(value => value.id === expected.id);
        if (!row || row.familyId !== auth.familyId || row.sourcePumpId !== null
          || row.type !== (undo.kind === 'breast' ? 'BREAST' : 'BOTTLE')) throw new NurseryUndoError();
        assertUndoRow(undo, row, index);
        return row;
      });
      if (undo.kind === 'breast' && (rows.some(row => row.side !== 'LEFT' && row.side !== 'RIGHT')
        || new Set(rows.map(row => row.side)).size !== rows.length)) throw new NurseryUndoError();
      await transact(async tx => {
        for (const [index, row] of rows.entries()) {
          if ((await tx.feedLog.deleteMany({ where: careSnapshot('feed', row) as Prisma.FeedLogWhereInput })).count !== 1) throw new NurseryUndoError();
          if (index === 0 && undo.kind === 'breast') {
            const remaining = await tx.feedLog.findMany({ where: sessionWhere });
            if (remaining.length !== rows.length - 1 || remaining.some(value => !rows.slice(1).some(expected => expected.id === value.id))) throw new NurseryUndoError();
          }
        }
      });
    }
  } catch (error) { nurseryMutationError(error); }
}

/** Nursery's optional enjoyment remains part of the same original action. A
 * peer correction cannot be adopted as a new baseline by this small PUT. */
export async function updateNurseryFood(db: PrismaClient, auth: AuthResult, undo: NurseryUndo, enjoyment: FoodEnjoyment): Promise<FoodLog> {
  if (undo.kind !== 'food') throw new NurseryUndoError('Invalid Undo request. Review the care log.', 400, 'NURSERY_UNDO_INVALID');
  try {
    assertNurseryScope(auth, undo.babyId, undo.scope);
    const row = await db.foodLog.findFirst({ where: { id: undo.records[0].id, familyId: auth.familyId!, babyId: undo.babyId } });
    if (!row) throw missing();
    assertUndoRow(undo, row);
    return await db.$transaction(async tx => {
      const changed = await tx.foodLog.updateMany({ where: careSnapshot('food', row) as Prisma.FoodLogWhereInput,
        data: { enjoyment, updatedAt: new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1)) } });
      if (changed.count !== 1) throw new NurseryUndoError();
      await requireUndoBaby(tx, auth, undo);
      return tx.foodLog.findUniqueOrThrow({ where: { id: row.id } });
    }, serializable);
  } catch (error) { return nurseryMutationError(error); }
}
