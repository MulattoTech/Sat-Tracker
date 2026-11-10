import type { PrismaClient, Prisma } from '@prisma/client';
import { bottleInput, JournalError, object, text } from './validation';
import { parseLegacyJournal } from './legacy';
import { requireJournalBaby, JournalActor } from './service';
import { convertVolume } from '@/src/utils/unit-conversion';

const providerId = 'family-bottle-journal';
function sourceKey(familyId: string, sourceId: string) { return { familyId, providerId, sourceEntityType: 'feed', sourceRecordId: sourceId }; }
async function duplicate(db: Prisma.TransactionClient, actor: JournalActor, babyId: string, sourceId: string, bottle: ReturnType<typeof bottleInput>) {
  const imported = await db.externalImportRecord.findUnique({ where: { familyId_providerId_sourceEntityType_sourceRecordId: sourceKey(actor.familyId, sourceId) } });
  if (imported) {
    const target = await db.feedLog.findFirst({ where: { id: imported.targetRecordId, familyId: actor.familyId } });
    if (target && target.babyId !== babyId) throw new JournalError('This source bottle was already imported for another child.', 409);
    return { imported: true, possible: false };
  }
  const sameTime = await db.feedLog.findMany({ where: { familyId: actor.familyId, babyId, time: bottle.time, type: 'BOTTLE', deletedAt: null }, select: { amount: true, unitAbbr: true } });
  const ml = convertVolume(bottle.amount, bottle.unitAbbr, 'ML');
  return { imported: false, possible: sameTime.some(row => row.amount !== null && Math.abs(convertVolume(row.amount, row.unitAbbr || 'OZ', 'ML') - ml) < 0.1) };
}
export async function previewLegacyJournal(db: PrismaClient, actor: JournalActor, babyId: string, content: string, format: string, zone: string) {
  if (!actor.canManage) throw new JournalError('An owner or administrator must import historical records.', 403);
  await requireJournalBaby(db, actor, babyId);
  const preview = parseLegacyJournal(content, format, zone);
  const rows = [];
  for (const row of preview.rows) rows.push({ ...row, ...(row.issue ? { imported: false, possible: false } : await duplicate(db, actor, babyId, row.sourceId, bottleInput(row))) });
  return { ...preview, rows };
}
export async function commitLegacyJournal(db: PrismaClient, actor: JournalActor, babyId: string, value: unknown, confirmed: unknown) {
  if (!actor.canManage) throw new JournalError('An owner or administrator must import historical records.', 403);
  if (confirmed !== true) throw new JournalError('Confirm that every selected bottle has been reviewed.');
  await requireJournalBaby(db, actor, babyId);
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) throw new JournalError('Select between 1 and 500 reviewed bottles.');
  const seen = new Set<string>();
  const rows = value.map(value => {
    const row = object(value), sourceId = text(row.sourceId, 100, 'source bottle ID')!;
    if (seen.has(sourceId)) throw new JournalError('Select each source bottle only once.'); seen.add(sourceId);
    return { sourceId, bottle: bottleInput(row), decision: row.duplicateDecision };
  });
  return db.$transaction(async tx => {
    let created = 0, duplicates = 0, skipped = 0;
    for (const row of rows) {
      const match = await duplicate(tx, actor, babyId, row.sourceId, row.bottle);
      if (match.imported) { duplicates++; continue; }
      if (match.possible && row.decision !== 'keep') {
        if (row.decision === 'skip') { skipped++; continue; }
        throw new JournalError('A matching bottle already exists. Choose skip or explicitly keep both.', 409);
      }
      const feed = await tx.feedLog.create({ data: { ...row.bottle, familyId: actor.familyId, babyId, caretakerId: actor.caretakerId || null } });
      await tx.externalImportRecord.create({ data: { ...sourceKey(actor.familyId, row.sourceId), sourceChildId: babyId, targetEntityType: 'FeedLog', targetRecordId: feed.id } });
      created++;
    }
    return { created, duplicates, skipped };
  }, { timeout: 30_000 });
}
