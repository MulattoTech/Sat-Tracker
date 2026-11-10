import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { Prisma, type DiaperLog, type DiaperType, type FoodLog, type PrismaClient } from '@prisma/client';
import type { AuthResult } from './auth';
import { CareWriteError, requireCareBaby } from './care-write';
import { assertNurseryScope, makeScopedNurseryUndo } from './nursery-undo';
import { careRevision } from './care-revision';
import type { NurseryUndo } from '@/src/utils/nursery/undo';
import { buildFoodLogFoodFields } from '@/src/utils/foodLogUtils';

type CommonRequest = { requestId: string; scope: string; babyId: string; time: string };
export type QuickDiaperRequest = CommonRequest & { kind: 'diaper'; type: DiaperType };
export type QuickFoodRequest = CommonRequest & { kind: 'food'; foodId: string };
export type QuickCareRequest = QuickDiaperRequest | QuickFoodRequest;
const providerId = 'sat-tracker-nursery-quick-care-v1';
const serializable = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 };
const changedMessage = 'This saved care action changed or was removed. Review the care log before dismissing the saved action.';

export class QuickCareWriteError extends CareWriteError {
  constructor(message = changedMessage, readonly code = 'QUICK_CARE_CHANGED', status = 409) { super(message, status); }
  response() { return NextResponse.json({ success: false, error: this.message, code: this.code }, { status: this.status }); }
}

/** Optional identity applies only to the narrow Nursery quick actions. Legacy
 * manual and scope-only requests retain their original route validation. */
export function readQuickCareRequest(raw: Record<string, unknown>, kind: 'diaper', auth: AuthResult): QuickDiaperRequest | null;
export function readQuickCareRequest(raw: Record<string, unknown>, kind: 'food', auth: AuthResult): QuickFoodRequest | null;
export function readQuickCareRequest(raw: Record<string, unknown>, kind: 'diaper' | 'food', auth: AuthResult): QuickCareRequest | null {
  if (!Object.hasOwn(raw, 'requestId')) return null;
  const keys = ['requestId', 'nurseryScope', 'babyId', 'time', kind === 'diaper' ? 'type' : 'foodId'];
  if (Object.keys(raw).length !== keys.length || keys.some(key => !Object.hasOwn(raw, key))
    || typeof raw.requestId !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(raw.requestId)
    || typeof raw.nurseryScope !== 'string' || raw.nurseryScope.length > 1000
    || typeof raw.babyId !== 'string' || !raw.babyId || raw.babyId.length > 200
    || typeof raw.time !== 'string' || !Number.isFinite(Date.parse(raw.time)) || new Date(raw.time).toISOString() !== raw.time) {
    throw new QuickCareWriteError('Invalid saved care action.', 'QUICK_CARE_INVALID', 400);
  }
  assertNurseryScope(auth, raw.babyId, raw.nurseryScope);
  const common = { requestId: raw.requestId.toLowerCase(), scope: raw.nurseryScope, babyId: raw.babyId, time: raw.time };
  let request: QuickCareRequest;
  if (kind === 'diaper') {
    if (typeof raw.type !== 'string' || !['WET', 'DIRTY', 'BOTH', 'DRY'].includes(raw.type)) throw new QuickCareWriteError('Invalid diaper type.', 'QUICK_CARE_INVALID', 400);
    request = { ...common, kind, type: raw.type as DiaperType };
  } else {
    if (typeof raw.foodId !== 'string' || !raw.foodId || raw.foodId.length > 200) throw new QuickCareWriteError('Invalid food.', 'QUICK_CARE_INVALID', 400);
    request = { ...common, kind, foodId: raw.foodId };
  }
  // Metadata cannot reach Prisma or legacy scalar validation.
  delete raw.requestId;
  return request;
}

function contention(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('code' in error && ['P2034', 'P1008', 'P2028'].includes(String(error.code))) return true;
  const cause = 'cause' in error ? error.cause : null;
  return !!cause && typeof cause === 'object' && 'originalCode' in cause
    && ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED'].includes(String(cause.originalCode));
}
const busy = () => new QuickCareWriteError('Another care action is being saved. Keep this saved action and retry.', 'QUICK_CARE_BUSY');
type Stamps = 'id' | 'createdAt' | 'updatedAt';

/** Explicit complete initial scalars let the receipt reconstruct the original
 * revision, independently of the current row. Added model scalars must also be
 * initialized here: the model type and generated revision inventory both guard
 * this boundary. No current row supplies a missing original field. */
function initialDiaper(auth: AuthResult, request: QuickDiaperRequest): Omit<DiaperLog, Stamps> {
  return { familyId: auth.familyId!, babyId: request.babyId, caretakerId: auth.caretakerId ?? null,
    time: new Date(request.time), type: request.type, condition: null, color: null, blowout: false,
    creamApplied: false, notes: null, deletedAt: null };
}
function initialFood(auth: AuthResult, request: QuickFoodRequest): Omit<FoodLog, Stamps> {
  const foods = buildFoodLogFoodFields([{ foodId: request.foodId, hadReaction: false, reactionDescription: null }]);
  return { familyId: auth.familyId!, babyId: request.babyId, caretakerId: auth.caretakerId ?? null,
    time: new Date(request.time), foodId: foods.foodId, foods: foods.foods,
    amount: null, unitAbbr: null, enjoyment: null, hadReaction: false, reactionDescription: null,
    notes: null, feedLogId: null, deletedAt: null };
}
type Result<Row> = { row: Row; undo: NurseryUndo; created: boolean };
export function createNurseryQuickCare(db: PrismaClient, auth: AuthResult, request: QuickDiaperRequest): Promise<Result<DiaperLog>>;
export function createNurseryQuickCare(db: PrismaClient, auth: AuthResult, request: QuickFoodRequest): Promise<Result<FoodLog>>;
export async function createNurseryQuickCare(db: PrismaClient, auth: AuthResult, request: QuickCareRequest): Promise<Result<DiaperLog | FoodLog>> {
  assertNurseryScope(auth, request.babyId, request.scope);
  const familyId = auth.familyId!, kind = request.kind;
  const initial = request.kind === 'diaper' ? initialDiaper(auth, request) : initialFood(auth, request);
  // UUID distinguishes deliberate repeated care. The payload and authenticated
  // actor are also bound so an old UUID cannot adopt a later edited row.
  const id = `nursery-${kind}-` + createHash('sha256').update(JSON.stringify([request.scope, request.requestId, initial])).digest('hex');
  const key = { familyId, providerId, sourceEntityType: kind, sourceRecordId: request.requestId };
  const targetEntityType = kind === 'diaper' ? 'DiaperLog' : 'FoodLog';
  const references = async (tx: Prisma.TransactionClient) => {
    await requireCareBaby(tx, request.babyId, familyId);
    if (request.kind === 'food' && !await tx.food.findFirst({
      where: { id: request.foodId, familyId, deletedAt: null }, select: { id: true },
    })) throw new CareWriteError('Food not found in this family.', 404);
  };
  const replay = async (): Promise<Result<DiaperLog | FoodLog> | null> => {
    const receipt = await db.externalImportRecord.findUnique({ where: { familyId_providerId_sourceEntityType_sourceRecordId: key } });
    if (!receipt) return null;
    if (receipt.sourceChildId !== request.babyId || receipt.targetEntityType !== targetEntityType || receipt.targetRecordId !== id) throw new QuickCareWriteError();
    const original = { ...initial, id, createdAt: receipt.importedAt, updatedAt: receipt.importedAt };
    const row = kind === 'diaper' ? await db.diaperLog.findUnique({ where: { id } }) : await db.foodLog.findUnique({ where: { id } });
    if (!row || careRevision(kind, row) !== careRevision(kind, original)) throw new QuickCareWriteError();
    await references(db);
    // This descriptor is the original snapshot, not a newly adopted revision.
    return { row, undo: makeScopedNurseryUndo(kind, request.scope, [original])!, created: false };
  };
  try {
    // Read-only replay must not hold a deferred SQLite transaction while a
    // competing create is waiting to commit.
    const existing = await replay(); if (existing) return existing;
    await references(db);
    return await db.$transaction(async tx => {
      const now = new Date();
      // Write first: two SQLite readers upgrading to writers can deadlock at
      // COMMIT and poison their adapter. Every relationship is rechecked after
      // the insert, before committing either the record or its durable receipt.
      const row = request.kind === 'diaper'
        ? await tx.diaperLog.create({ data: { ...initialDiaper(auth, request), id, createdAt: now, updatedAt: now } })
        : await tx.foodLog.create({ data: { ...initialFood(auth, request), id, createdAt: now, updatedAt: now } });
      await references(tx);
      await tx.externalImportRecord.create({ data: { ...key, sourceChildId: request.babyId, targetEntityType,
        targetRecordId: id, importedAt: now } });
      return { row, undo: makeScopedNurseryUndo(kind, request.scope, [row])!, created: true };
    }, serializable);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      // The winning request is inspected only after our transaction rolled
      // back. No automatic write retry or reconstruction of missing care.
      try { const existing = await replay(); if (existing) return existing; }
      catch (readError) { if (!contention(readError)) throw readError; }
      throw busy();
    }
    if (contention(error)) throw busy();
    throw error;
  }
}
