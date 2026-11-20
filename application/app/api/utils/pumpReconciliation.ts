import type { FeedLog, Prisma, PrismaClient, PumpLog } from '@prisma/client';
import { autoPumpFeedNotes, shouldHaveAutoPumpFeed } from '@/src/utils/breastMilkInventory';
import { representablePumpAmount } from '@/src/utils/pump-validation';
import { normalizeVolumeUnit } from '@/src/utils/unit-conversion';
import type { UndoRecord } from '@/src/utils/nursery/undo';
import { careRevision, careSnapshot } from './care-revision';
import { withPhotoIntegrity, PhotoIntegrityError } from './photo-integrity';
import { assertPhotoTargetMove, assertPhotoTargetUnlinked, detachPhotoTargetForDeletion } from './photo-target-mutations';

export class PumpReconciliationConflict extends Error {
  constructor(message = 'This pumping record changed while you were saving. Review the latest pumping and feeding records before trying again.',
    readonly code: 'PUMP_CONFLICT' | 'PUMP_RECONCILIATION_REQUIRED' = 'PUMP_CONFLICT') {
    super(message);
  }
}

const ownershipConflict = () => new PumpReconciliationConflict(
  'The feeding record for this pumping session cannot be identified safely. Review the pumping and feeding history before changing it.',
  'PUMP_RECONCILIATION_REQUIRED',
);
const removedPumpConflict = () => new PumpReconciliationConflict(
  'This pumping record was removed. Review the care history before changing it.', 'PUMP_RECONCILIATION_REQUIRED',
);

function isPumpContention(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('code' in error && ['P2034', 'P1008', 'P2028'].includes(String(error.code))) return true;
  const cause = 'cause' in error ? error.cause : null;
  return !!cause && typeof cause === 'object' && 'originalCode' in cause
    && ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED'].includes(String(cause.originalCode));
}

async function pumpTransaction<T>(db: PrismaClient, familyId: string | null | undefined, action: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    // Share the same first-write ordering as attachments and conditional Undo.
    return await withPhotoIntegrity(db, familyId!, action);
  } catch (error) {
    if (error instanceof PhotoIntegrityError) throw new PumpReconciliationConflict(error.message);
    if (isPumpContention(error)) throw new PumpReconciliationConflict();
    throw error;
  }
}

// Claim every scalar, not only updatedAt: two writers may share a timestamp.
// The caller validated its patch against this exact authenticated snapshot.
function snapshotWhere(pump: PumpLog): Prisma.PumpLogWhereInput {
  return { ...pump };
}

async function ownedFeed(tx: Prisma.TransactionClient, pump: PumpLog, previous?: PumpLog): Promise<FeedLog | null> {
  const owner = previous ?? pump;
  if (pump.familyId !== owner.familyId) throw ownershipConflict();
  const linked = await tx.feedLog.findUnique({ where: { sourcePumpId: pump.id } });
  if (linked) {
    // Match the original child before a validated same-family reassignment.
    // An inconsistent source link must never authorize a cross-child/family edit.
    if (linked.familyId !== owner.familyId || linked.babyId !== owner.babyId) throw ownershipConflict();
    return linked;
  }
  if (!previous || previous.pumpAction !== 'FED' || !previous.totalAmount || previous.totalAmount <= 0) return null;

  // Old automatic feeds predate sourcePumpId. A note prefix alone is not
  // ownership: require the complete original signature and one possible owner.
  const candidates = await tx.feedLog.findMany({ where: {
    sourcePumpId: null, familyId: previous.familyId, babyId: previous.babyId,
    caretakerId: previous.caretakerId, time: previous.startTime,
    type: 'BOTTLE', bottleType: 'Breast Milk', amount: previous.totalAmount,
    unitAbbr: previous.unitAbbr || 'OZ', notes: autoPumpFeedNotes(previous.notes), deletedAt: null,
  }, take: 2 });
  if (!candidates.length) return null;
  if (candidates.length > 1) throw ownershipConflict();
  const otherPossibleOwner = await tx.pumpLog.findFirst({ where: {
    id: { not: pump.id }, familyId: previous.familyId, babyId: previous.babyId,
    caretakerId: previous.caretakerId, startTime: previous.startTime,
    totalAmount: previous.totalAmount, pumpAction: 'FED', notes: previous.notes, deletedAt: null,
    // A missing historical unit means OZ, just as it does in balance math.
    ...(normalizeVolumeUnit(previous.unitAbbr) === 'OZ'
      ? { OR: [{ unitAbbr: null }, { unitAbbr: 'OZ' }] }
      : { unitAbbr: previous.unitAbbr }),
  }, select: { id: true } });
  if (otherPossibleOwner) throw ownershipConflict();
  return candidates[0];
}

async function reconcileFeed(tx: Prisma.TransactionClient, pump: PumpLog, previous?: PumpLog, deleting = false) {
  if (!pump.familyId) throw ownershipConflict();
  if (pump.deletedAt) throw removedPumpConflict();
  const feed = await ownedFeed(tx, pump, previous);
  const settings = deleting ? null : await tx.settings.findFirst({
    where: { familyId: pump.familyId }, select: { enableBreastMilkTracking: true },
  });
  const shouldHaveFeed = !deleting && shouldHaveAutoPumpFeed({
    trackingEnabled: settings?.enableBreastMilkTracking !== false,
    pumpAction: pump.pumpAction, totalAmount: pump.totalAmount,
  });
  if (!shouldHaveFeed) {
    if (feed) {
      const target = { activityType: 'feed', activityId: feed.id };
      if (deleting) await detachPhotoTargetForDeletion(tx, pump.familyId, target);
      else await assertPhotoTargetUnlinked(tx, target);
      await tx.feedLog.delete({ where: { id: feed.id, familyId: feed.familyId, babyId: feed.babyId } });
    }
    return;
  }
  // A separate soft deletion is a conflicting caregiver action, not permission
  // to resurrect a feed during an unrelated pump correction.
  const unit = normalizeVolumeUnit(pump.unitAbbr || 'OZ');
  if (feed?.deletedAt) {
    throw new PumpReconciliationConflict('The feeding record linked to this pumping session was removed. Review the pumping and feeding history before changing it.', 'PUMP_RECONCILIATION_REQUIRED');
  }
  if (!unit || !representablePumpAmount(pump.totalAmount, unit)) {
    throw new PumpReconciliationConflict('This pumping session has an unsupported quantity or unit. Review the care history before changing it.', 'PUMP_RECONCILIATION_REQUIRED');
  }
  const data = {
    time: pump.startTime, type: 'BOTTLE' as const, amount: pump.totalAmount,
    unitAbbr: pump.unitAbbr || 'OZ', bottleType: 'Breast Milk',
    notes: autoPumpFeedNotes(pump.notes), sourcePumpId: pump.id,
    familyId: pump.familyId, babyId: pump.babyId, caretakerId: pump.caretakerId,
  };
  if (feed) {
    await assertPhotoTargetMove(tx, pump.familyId, { activityType: 'feed', activityId: feed.id }, pump.babyId);
    await tx.feedLog.update({ where: { id: feed.id, familyId: feed.familyId, babyId: feed.babyId }, data });
  }
  else await tx.feedLog.create({ data });
}

export async function createPumpWithFeed(db: PrismaClient, data: Prisma.PumpLogUncheckedCreateInput) {
  return pumpTransaction(db, data.familyId, async tx => {
    const pump = await tx.pumpLog.create({ data });
    await reconcileFeed(tx, pump);
    return pump;
  });
}

export async function updatePumpWithFeed(db: PrismaClient, previous: PumpLog, data: Prisma.PumpLogUncheckedUpdateManyInput) {
  return pumpTransaction(db, previous.familyId, async tx => {
    if (previous.deletedAt) throw removedPumpConflict();
    const claimed = await tx.pumpLog.updateMany({ where: snapshotWhere(previous), data: {
      ...data, updatedAt: new Date(Math.max(Date.now(), previous.updatedAt.getTime() + 1)),
    } });
    if (claimed.count !== 1) throw new PumpReconciliationConflict();
    const pump = await tx.pumpLog.findUniqueOrThrow({ where: { id: previous.id } });
    await reconcileFeed(tx, pump, previous);
    return pump;
  });
}

/** Nursery supplies the original linked-feed revision (or explicit absence).
 * Ordinary manual deletes retain their existing conservative reconciliation. */
export async function deletePumpSnapshot(tx: Prisma.TransactionClient, previous: PumpLog, expectedFeed?: UndoRecord | null) {
  if (previous.deletedAt) throw removedPumpConflict();
  // The caller holds the family writer. An attachment or relationship conflict
  // rolls this exact pump claim back together with its feeding record.
  const deleted = await tx.pumpLog.deleteMany({ where: snapshotWhere(previous) });
  if (deleted.count !== 1) throw new PumpReconciliationConflict();
  let feed: FeedLog | null = null;
  if (expectedFeed !== undefined) {
    const linked = await tx.feedLog.findMany({ where: { sourcePumpId: previous.id } });
    if (expectedFeed === null ? linked.length !== 0 : linked.length !== 1
      || linked[0].id !== expectedFeed.id || linked[0].familyId !== previous.familyId || linked[0].babyId !== previous.babyId
      || linked[0].deletedAt !== null || careRevision('feed', linked[0]) !== expectedFeed.revision) throw ownershipConflict();
    feed = linked[0] ?? null;
  }
  if (expectedFeed === undefined) await reconcileFeed(tx, previous, previous, true);
  else if (feed) {
    await assertPhotoTargetUnlinked(tx, { activityType: 'feed', activityId: feed.id });
    const removed = await tx.feedLog.deleteMany({ where: careSnapshot('feed', feed) as Prisma.FeedLogWhereInput });
    if (removed.count !== 1) throw new PumpReconciliationConflict();
  }
}

export async function deletePumpWithFeed(db: PrismaClient, previous: PumpLog) {
  return pumpTransaction(db, previous.familyId, tx => deletePumpSnapshot(tx, previous));
}
