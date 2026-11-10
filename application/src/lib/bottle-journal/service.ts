import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { bottleInput, BottleInput, journalTotals, journalWindow, JournalError, number, text } from './validation';
import { journalScope } from './outbox-identity';
import { makeScopedNurseryUndo } from '@/app/api/utils/nursery-undo';

export interface JournalActor { familyId: string; caretakerId?: string | null; canManage?: boolean; actorKey?: string }
export async function requireJournalBaby(db: PrismaClient, actor: JournalActor, babyId: string) {
  const baby = await db.baby.findFirst({ where: { id: babyId, familyId: actor.familyId, deletedAt: null } });
  if (!baby) throw new JournalError('Child not found in this family.', 404);
  return baby;
}
export async function getJournal(db: PrismaClient, actor: JournalActor, babyId: string, day: string, zone: string, now = new Date()) {
  const baby = await requireJournalBaby(db, actor, babyId);
  const bounds = journalWindow(day, zone, now);
  const rows = await db.feedLog.findMany({ where: { familyId: actor.familyId, babyId, type: 'BOTTLE', deletedAt: null,
    OR: [{ time: { gte: bounds.dayStart, lt: bounds.dayEnd } }, { time: { gte: bounds.rollingStart, lte: now } }] },
    include: { caretaker: { select: { name: true } } }, orderBy: [{ time: 'desc' }, { id: 'asc' }], take: 2001 });
  if (rows.length > 2000) throw new JournalError('Too many entries for this day. Use reports to review this data.', 422);
  return { babyId, day, timeZone: zone, canManage: Boolean(actor.canManage),
    targetMl: baby.dailyIntakeTargetMl, totals: journalTotals(rows, bounds, baby.dailyIntakeTargetMl),
    rows: rows.filter(row => row.time >= bounds.dayStart && row.time < bounds.dayEnd).map(row => ({ ...row, caretakerName: row.sourceCaregiverName || row.caretaker?.name || null, caretaker: undefined })) };
}
function sameBottle(existing: Record<string, unknown>, data: BottleInput, babyId: string) {
  if (existing.babyId !== babyId || existing.deletedAt) return false;
  return Object.entries(data).every(([key, value]) => key === 'time'
    ? new Date(existing.time as Date).getTime() === data.time.getTime()
    : (existing[key] ?? null) === value);
}
export async function saveBottle(db: PrismaClient, actor: JournalActor, babyId: string, value: unknown, requestId: unknown, expectedUpdatedAt?: unknown) {
  await requireJournalBaby(db, actor, babyId);
  const data = bottleInput(value);
  const id = text(requestId, 36, 'request ID')!;
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)) throw new JournalError('Invalid request ID.');
  return db.$transaction(async tx => {
    const existing = await tx.feedLog.findUnique({ where: { id } });
    if (expectedUpdatedAt === undefined) {
      // The create receipt outlives canonical feed deletion. Read it before
      // treating a missing feed as a fresh request; a late delivery must never
      // recreate a removed bottle or retry forever on the receipt's unique key.
      const receipt = await tx.externalImportRecord.findUnique({ where: {
        familyId_providerId_sourceEntityType_sourceRecordId: {
          familyId: actor.familyId, providerId: 'sat-tracker-journal', sourceEntityType: 'feed', sourceRecordId: id,
        },
      } });
      if (receipt && (receipt.targetRecordId !== id || receipt.targetEntityType !== 'FeedLog' || receipt.sourceChildId !== babyId)) {
        throw new JournalError('This request has a different saved receipt. Review saved history before retrying or discarding the local pending copy.', 409);
      }
      if (receipt && (!existing || existing.deletedAt || existing.familyId !== actor.familyId || existing.babyId !== babyId || existing.type !== 'BOTTLE')) {
        throw new JournalError('This bottle was already saved and later changed or removed. Review saved history before discarding the local pending copy.', 409);
      }
    }
    // An intentional edit is authorized by the current family/child and exact
    // revision, independently of the original create receipt's provenance.
    if (existing && (existing.familyId !== actor.familyId || existing.babyId !== babyId || existing.type !== 'BOTTLE' || existing.deletedAt)) throw new JournalError('Bottle not found.', 404);
    if (expectedUpdatedAt !== undefined) {
      if (!existing) throw new JournalError('Bottle not found.', 404);
      if (expectedUpdatedAt !== existing.updatedAt.toISOString()) throw new JournalError('This bottle changed on another device. Refresh before editing again.', 409);
      const updatedAt = new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1));
      const updated = await tx.feedLog.updateMany({ where: { id, familyId: actor.familyId, babyId, updatedAt: existing.updatedAt }, data: { ...data, updatedAt } });
      if (updated.count !== 1) throw new JournalError('This bottle changed on another device. Refresh before editing again.', 409);
      return { id, created: false, updated: true };
    }
    if (existing) {
      if (!sameBottle(existing as unknown as Record<string, unknown>, data, babyId)) throw new JournalError('This request was already saved with different values. Refresh the journal before trying again.', 409);
      return { id, created: false, updated: false };
    }
    const row = await tx.feedLog.create({ data: { ...data, id, familyId: actor.familyId, babyId, caretakerId: actor.caretakerId || null } });
    await tx.externalImportRecord.create({ data: { id: randomUUID(), familyId: actor.familyId, providerId: 'sat-tracker-journal', sourceEntityType: 'feed', sourceRecordId: id, sourceChildId: babyId, targetEntityType: 'FeedLog', targetRecordId: id } });
    return { id, created: true, updated: false,
      ...(actor.actorKey ? { undo: makeScopedNurseryUndo('bottle', journalScope(actor.familyId, actor.actorKey, babyId), [row]) } : {}) };
  });
}
export async function setJournalTarget(db: PrismaClient, actor: JournalActor, babyId: string, value: unknown) {
  if (!actor.canManage) throw new JournalError('An owner or administrator must set the intake target.', 403);
  await requireJournalBaby(db, actor, babyId);
  const target = number(value, 10_000, 'intake target', true);
  if (target === 0) throw new JournalError('Use a positive target or leave it blank.');
  await db.baby.update({ where: { id: babyId }, data: { dailyIntakeTargetMl: target } });
  return { targetMl: target };
}
