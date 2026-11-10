import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient, PumpLog } from '@prisma/client';
import type { AuthResult } from '../utils/auth';
import { journalScope } from '@/src/lib/bottle-journal/outbox-identity';
import { autoPumpFeedNotes, shouldHaveAutoPumpFeed } from '@/src/utils/breastMilkInventory';

const PROVIDER = 'sat-tracker-nursery-pump-v1';

export class PumpRequestError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

export interface PumpRequestIdentity { requestId: string; familyId: string; babyId: string; pumpId: string }

/** Optional for older callers. A recoverable nursery submission always supplies
 * both fields; middleware, never the supplied scope, establishes its owner. */
export function pumpRequestIdentity(body: { requestId?: unknown; expectedScope?: unknown; babyId: string }, auth: AuthResult): PumpRequestIdentity | null {
  if (body.requestId === undefined && body.expectedScope === undefined) return null;
  if (typeof body.requestId !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(body.requestId)
    || typeof body.expectedScope !== 'string') throw new PumpRequestError('A valid pumping request ID and caregiver scope are required.', 400);
  const actor = auth.isAccountAuth && auth.accountId ? `account:${auth.accountId}` : auth.caretakerId ? `caretaker:${auth.caretakerId}` : null;
  if (!auth.familyId || !actor || auth.isSetupAuth || auth.isSysAdmin
    || body.expectedScope !== journalScope(auth.familyId, actor, body.babyId)) {
    throw new PumpRequestError('The signed-in caregiver or child changed. Sign in as the original caregiver before retrying this pumping session.');
  }
  return { familyId: auth.familyId, babyId: body.babyId, requestId: body.requestId,
    pumpId: 'nursery-' + createHash('sha256').update(JSON.stringify([auth.familyId, actor, body.requestId])).digest('hex') };
}

function sameValue(actual: unknown, expected: unknown) {
  return expected instanceof Date ? actual instanceof Date && actual.getTime() === expected.getTime() : (actual ?? null) === (expected ?? null);
}

/** ExternalImportRecord is also the journal's durable create receipt. Its row is
 * deliberately retained after care-record deletion so late retries cannot
 * resurrect a deleted event. No credentials or raw request bodies are stored. */
export async function createPumpOnce(
  db: PrismaClient, identity: PumpRequestIdentity | null, data: Prisma.PumpLogUncheckedCreateInput,
  trackingEnabled: boolean, create: (tx: Prisma.TransactionClient) => Promise<PumpLog>,
): Promise<{ pumpLog: PumpLog; created: boolean }> {
  if (!identity) return { pumpLog: await db.$transaction(create), created: true };
  const receiptWhere = { familyId: identity.familyId, providerId: PROVIDER, sourceEntityType: 'pump', sourceRecordId: identity.requestId };
  const replay = async (tx: Prisma.TransactionClient) => {
    const receipt = await tx.externalImportRecord.findUnique({ where: { familyId_providerId_sourceEntityType_sourceRecordId: receiptWhere } });
    if (!receipt) return null;
    if (receipt.targetRecordId !== identity.pumpId || receipt.sourceChildId !== identity.babyId || receipt.targetEntityType !== 'PumpLog') {
      throw new PumpRequestError('This pumping request belongs to a different caregiver or child. Review the saved session before retrying.');
    }
    const pump = await tx.pumpLog.findFirst({ where: { id: identity.pumpId, familyId: identity.familyId, babyId: identity.babyId, deletedAt: null } });
    if (!pump || !['startTime', 'endTime', 'duration', 'leftAmount', 'rightAmount', 'totalAmount', 'unitAbbr', 'pumpAction', 'notes', 'caretakerId']
      .every(key => sameValue(pump[key as keyof PumpLog], data[key as keyof Prisma.PumpLogUncheckedCreateInput]))) {
      throw new PumpRequestError('This pumping request was already saved and has different values or was removed. Review the care log before making another entry.');
    }
    const feeds = await tx.feedLog.findMany({ where: { sourcePumpId: pump.id } });
    const requiresFeed = shouldHaveAutoPumpFeed({ trackingEnabled, pumpAction: pump.pumpAction, totalAmount: pump.totalAmount });
    if (feeds.length > 1 || (requiresFeed && feeds.length !== 1)
      || feeds.some(feed => pump.pumpAction !== 'FED' || feed.deletedAt !== null || feed.familyId !== pump.familyId || feed.babyId !== pump.babyId
        || feed.caretakerId !== pump.caretakerId || feed.type !== 'BOTTLE' || feed.bottleType !== 'Breast Milk' || feed.amount !== pump.totalAmount
        || feed.unitAbbr !== (pump.unitAbbr || 'OZ') || feed.time.getTime() !== pump.startTime.getTime() || feed.notes !== autoPumpFeedNotes(pump.notes))) {
      throw new PumpRequestError('The feeding record linked to this pumping session changed. Review the care log before retrying.');
    }
    return { pumpLog: pump, created: false };
  };
  try {
    return await db.$transaction(async tx => {
      const existing = await replay(tx);
      if (existing) return existing;
      const pumpLog = await create(tx);
      await tx.externalImportRecord.create({ data: { ...receiptWhere, sourceChildId: identity.babyId,
        targetEntityType: 'PumpLog', targetRecordId: pumpLog.id } });
      return { pumpLog, created: true };
    });
  } catch (error) {
    // An overlapping create may win the unique ID/receipt race. Observe it only
    // after our whole transaction rolled back; never retry the write blindly.
    if (error && typeof error === 'object' && 'code' in error && ['P2002', 'P2034', 'P1008'].includes(String(error.code))) {
      const existing = await db.$transaction(replay);
      if (existing) return existing;
      throw new PumpRequestError('This pumping session is being saved. Keep the session and retry after the other request finishes.');
    }
    throw error;
  }
}
