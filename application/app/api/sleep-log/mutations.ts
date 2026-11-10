import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient, type SleepLog } from '@prisma/client';
import type { AuthResult } from '../utils/auth';
import { requireCareBaby } from '../utils/care-write';
import { SleepWriteError, type SleepRequest, sleepActor } from './request';
import { sleepRevision, sleepSnapshot } from './revision';

// SQLite's adapter may wait up to 5s for an external writer. Keep the complete
// transaction bounded while allowing that writer's commit/rollback to settle.
const serializable = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 };
const providerId = 'sat-tracker-nursery-sleep-v1';
const conflict = () => new SleepWriteError('Another sleep change is being saved. Keep this action and reload the current sleep state.', 'SLEEP_BUSY');
function serializationFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('code' in error && ['P2034', 'P1008', 'P2028'].includes(String(error.code))) return true;
  // Prisma's JS SQLite adapter exposes lock contention as a driver cause,
  // rather than a Prisma error code. Other adapter failures remain server errors.
  const cause = 'cause' in error ? error.cause : null;
  return Boolean(cause && typeof cause === 'object' && 'originalCode' in cause
    && ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED'].includes(String(cause.originalCode)));
}
const same = (actual: unknown, expected: unknown) => expected instanceof Date
  ? actual instanceof Date && actual.getTime() === expected.getTime() : (actual ?? null) === (expected ?? null);

/** Only an explicit Nursery start participates in single-active arbitration.
 * Historical/manual creates keep their existing semantics. Serializable protects
 * the empty-active predicate on PostgreSQL as well as SQLite. */
export async function createNurserySleep(
  db: PrismaClient, auth: AuthResult, request: Extract<SleepRequest, { action: 'start' }>,
  data: Prisma.SleepLogUncheckedCreateInput,
): Promise<{ row: SleepLog; created: boolean }> {
  const familyId = auth.familyId!, babyId = data.babyId;
  const id = 'nursery-sleep-' + createHash('sha256').update(JSON.stringify([familyId, sleepActor(auth), request.requestId])).digest('hex');
  const receiptKey = { familyId, providerId, sourceEntityType: 'sleep', sourceRecordId: request.requestId };
  const replay = async (tx: Prisma.TransactionClient) => {
    const receipt = await tx.externalImportRecord.findUnique({ where: { familyId_providerId_sourceEntityType_sourceRecordId: receiptKey } });
    if (!receipt) return null;
    if (receipt.targetRecordId !== id || receipt.sourceChildId !== babyId || receipt.targetEntityType !== 'SleepLog') {
      throw new SleepWriteError('This sleep request belongs to another caregiver or child. Review the care log.', 'SLEEP_REQUEST_CHANGED');
    }
    const row = await tx.sleepLog.findFirst({ where: { id, familyId, babyId, deletedAt: null } });
    if (!row || row.createdAt.getTime() !== row.updatedAt.getTime()
      || !['babyId', 'familyId', 'caretakerId', 'startTime', 'endTime', 'duration', 'type', 'location', 'quality', 'notes']
        .every(key => same(row[key as keyof SleepLog], data[key as keyof Prisma.SleepLogUncheckedCreateInput]))) {
      throw new SleepWriteError('This sleep request was already saved and changed or removed. Review the care log before starting another sleep.', 'SLEEP_REQUEST_CHANGED');
    }
    if (await tx.sleepLog.count({ where: { familyId, babyId, endTime: null, deletedAt: null } }) !== 1) {
      throw new SleepWriteError('More than one sleep is active. Review the care log before changing a timer.', 'SLEEP_ACTIVE_CONFLICT');
    }
    return { row, created: false };
  };
  try {
    // Replay is read-only and needs no long-lived transaction/read lock. Its
    // returned revision still guards every later mutation of this record.
    const existing = await replay(db);
    if (existing) return existing;
    return await db.$transaction(async tx => {
      // Write before reading the active predicate. Two deferred SQLite readers
      // upgrading to writers can deadlock at COMMIT and leave a held lock in
      // the adapter. PostgreSQL still arbitrates the predicate at Serializable.
      const now = new Date();
      const row = await tx.sleepLog.create({ data: { ...data, id, createdAt: now, updatedAt: now } });
      await requireCareBaby(tx, babyId, familyId);
      if (await tx.sleepLog.count({ where: { familyId, babyId, endTime: null, deletedAt: null } }) !== 1) {
        throw new SleepWriteError('A sleep is already active. Reload and review it before starting another sleep.', 'SLEEP_ACTIVE_CONFLICT');
      }
      // The durable receipt survives a later care-record deletion. A late retry
      // cannot recreate a sleep that a caregiver intentionally removed.
      await tx.externalImportRecord.create({ data: { ...receiptKey, sourceChildId: babyId, targetEntityType: 'SleepLog', targetRecordId: id } });
      return { row, created: true };
    }, serializable);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      // A concurrent duplicate may have committed while this request waited.
      // Validate it after rollback, without opening another transaction.
      try { const existing = await replay(db); if (existing) return existing; }
      catch (readError) { if (!serializationFailure(readError)) throw readError; }
      throw conflict();
    }
    if (serializationFailure(error)) throw conflict();
    throw error;
  }
}

export function assertSleepRevision(request: SleepRequest | null, row: SleepLog) {
  if (request && request.action !== 'start' && request.expectedRevision !== sleepRevision(row)) throw new SleepWriteError();
}

export async function updateSleepSnapshot(
  db: PrismaClient, previous: SleepLog, data: Prisma.SleepLogUncheckedUpdateManyInput, request: SleepRequest | null,
): Promise<SleepLog> {
  assertSleepRevision(request, previous);
  if (request?.action === 'wake' && previous.endTime !== null) throw new SleepWriteError();
  if (request?.action === 'undo-wake' && previous.endTime === null) throw new SleepWriteError();
  try {
    return await db.$transaction(async tx => {
      const claimed = await tx.sleepLog.updateMany({ where: sleepSnapshot(previous), data: {
        ...data, updatedAt: new Date(Math.max(Date.now(), previous.updatedAt.getTime() + 1)),
      } });
      if (claimed.count !== 1) throw new SleepWriteError();
      if (typeof data.babyId === 'string' && data.babyId !== previous.babyId) await requireCareBaby(tx, data.babyId, previous.familyId!);
      // The claimed Wake is now ended; Undo-Wake is now active. Check the
      // resulting predicate before commit, rolling the claim back on conflict.
      if (request?.action === 'wake' && await tx.sleepLog.count({ where: {
        familyId: previous.familyId, babyId: previous.babyId, endTime: null, deletedAt: null,
      } }) !== 0) throw new SleepWriteError('More than one sleep is active or the timer changed. Review the care log before waking it.', 'SLEEP_ACTIVE_CONFLICT');
      if (request?.action === 'undo-wake' && await tx.sleepLog.count({ where: {
        familyId: previous.familyId, babyId: previous.babyId, endTime: null, deletedAt: null,
      } }) !== 1) throw new SleepWriteError('Another sleep is active. Review the care log before reopening this sleep.', 'SLEEP_ACTIVE_CONFLICT');
      return tx.sleepLog.findUniqueOrThrow({ where: { id: previous.id } });
    }, serializable);
  } catch (error) { if (serializationFailure(error)) throw conflict(); throw error; }
}

export async function deleteSleepSnapshot(db: PrismaClient, previous: SleepLog, request: SleepRequest | null) {
  assertSleepRevision(request, previous);
  if (request?.action === 'undo-start' && previous.endTime !== null) throw new SleepWriteError();
  try {
    await db.$transaction(async tx => {
      const claimed = await tx.sleepLog.deleteMany({ where: sleepSnapshot(previous) });
      if (claimed.count !== 1) throw new SleepWriteError();
    }, serializable);
  } catch (error) { if (serializationFailure(error)) throw conflict(); throw error; }
}
