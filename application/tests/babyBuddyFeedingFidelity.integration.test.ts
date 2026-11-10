import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';
import { buildBabyBuddyImportRecords } from '@/src/lib/importers/baby-buddy';
import { executeExternalImport } from '@/src/lib/importers/execute';
import type { ExternalImportRecord } from '@/src/types/external-import';

let db: PrismaClient;
let directory: string;
const header = 'id,child_id,start,end,type,method,amount,notes';
const records = (...rows: string[]) => buildBabyBuddyImportRecords([
  { name: 'Feeding.csv', content: [header, ...rows].join('\n') },
], { feedingUnit: 'ML' });
const run = (entries: readonly ExternalImportRecord[], familyId = 'feed-family', timezone = 'America/Chicago') =>
  db.$transaction(tx => executeExternalImport(tx, {
    familyId, caretakerId: 'feed-caretaker', records: entries,
    configuration: { sourceTimezone: timezone, childDestinations: { '7': { mode: 'existing', targetBabyId: 'feed-child' } } },
  }));

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-feed-fidelity-'));
  const url = 'file:' + path.join(directory, 'synthetic.db');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
  });
  db = new PrismaClient({ adapter: createPrismaAdapter(url) });
  await db.family.createMany({ data: [
    { id: 'feed-family', slug: 'feed-synthetic', name: 'Synthetic Family' },
    { id: 'feed-other-family', slug: 'feed-other-synthetic', name: 'Other Synthetic Family' },
  ] });
  await db.baby.create({ data: { id: 'feed-child', familyId: 'feed-family', firstName: 'Synthetic', lastName: 'Child', birthDate: new Date('2026-01-01T00:00:00Z') } });
  await db.caretaker.create({ data: { id: 'feed-caretaker', familyId: 'feed-family', name: 'Synthetic Caregiver', type: 'Parent', loginId: 'feed-synthetic-caregiver', securityPin: '123456' } });
  await db.unit.create({ data: { unitAbbr: 'ML', unitName: 'Milliliters' } });
}, 90_000);

afterAll(async () => {
  await db?.$disconnect();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('Baby Buddy feeding fidelity on migrated SQLite', () => {
  it('persists bottle, breast, and solid-food endpoints, exact elapsed seconds and source identity', async () => {
    const entries = records(
      'offset-fold,7,2026-11-01 01:55:10-05:00,2026-11-01 01:05:20-06:00,formula,bottle,90,Synthetic offset source',
      'spring-naive,7,2026-03-08 01:55:10,2026-03-08 03:05:20,breast milk,left breast,,Synthetic spring source',
      'midnight,7,2026-10-20 23:59:30,2026-10-21 00:14:45,solid food,parent fed,,Synthetic midnight source',
    );
    const result = await run(entries);
    expect(result).toMatchObject({ created: 3, duplicates: 0 });
    const expected = [
      ['offset-fold', 'BOTTLE', '2026-11-01T06:55:10Z', '2026-11-01T07:05:20Z', 610, 90],
      ['spring-naive', 'BREAST', '2026-03-08T07:55:10Z', '2026-03-08T08:05:20Z', 610, null],
      ['midnight', 'SOLIDS', '2026-10-21T04:59:30Z', '2026-10-21T05:14:45Z', 915, null],
    ] as const;
    const original = [];
    for (const [sourceRecordId, type, start, end, feedDuration, amount] of expected) {
      const provenance = await db.externalImportRecord.findFirstOrThrow({ where: { sourceRecordId } });
      expect(provenance).toMatchObject({ familyId: 'feed-family', providerId: 'baby-buddy', sourceEntityType: 'feeding', sourceChildId: '7', targetEntityType: 'FeedLog' });
      const saved = await db.feedLog.findUniqueOrThrow({ where: { id: provenance.targetRecordId } });
      expect(saved).toMatchObject({ familyId: 'feed-family', babyId: 'feed-child', caretakerId: 'feed-caretaker',
        type, startTime: new Date(start), endTime: new Date(end), time: new Date(end), feedDuration, amount });
      expect(saved.notes).toContain('Synthetic');
      original.push(saved);
    }
    const replay = await run(entries);
    expect(replay).toMatchObject({ created: 0, duplicates: 3 });
    expect(replay.records.map(row => row.targetRecordId)).toEqual(result.records.map(row => row.targetRecordId));
    for (const saved of original) expect(await db.feedLog.findUniqueOrThrow({ where: { id: saved.id } })).toEqual(saved);
    expect(await db.feedLog.count()).toBe(3);
    expect(await db.externalImportRecord.count()).toBe(3);
  });

  it.each([
    ['gap', '2026-03-08 02:15:00', '2026-03-08 03:15:00', 'does not exist'],
    ['fold', '2026-11-01 01:15:00', '2026-11-01 02:15:00', 'ambiguous'],
    ['reverse', '2026-10-20 12:00:00Z', '2026-10-20 11:59:59Z', 'non-negative'],
  ])('rolls back the whole batch for %s instead of partially creating events or provenance', async (id, start, end, error) => {
    const before = { feeds: await db.feedLog.count(), imports: await db.externalImportRecord.count() };
    await expect(run(records(
      `rollback-${id}-valid,7,2026-10-20 08:00:00,2026-10-20 08:10:00,formula,bottle,90,Synthetic first row`,
      `rollback-${id}-invalid,7,${start},${end},formula,bottle,90,Synthetic second row`,
    ))).rejects.toThrow(error);
    expect(await db.feedLog.count()).toBe(before.feeds);
    expect(await db.externalImportRecord.count()).toBe(before.imports);
  });

  it('rejects another family child before any write', async () => {
    await expect(run(records('denied,7,2026-10-20 08:00:00,2026-10-20 08:10:00,formula,bottle,90,Synthetic'), 'feed-other-family'))
      .rejects.toThrow('not found in this family');
    expect(await db.feedLog.count({ where: { familyId: 'feed-other-family' } })).toBe(0);
    expect(await db.externalImportRecord.count({ where: { sourceRecordId: 'denied' } })).toBe(0);
  });

  it('does not silently rewrite a previously imported bottle with missing timing on replay', async () => {
    const old = await db.feedLog.create({ data: { familyId: 'feed-family', babyId: 'feed-child',
      time: new Date('2026-10-20T13:10:00Z'), type: 'BOTTLE', amount: 90, unitAbbr: 'ML', notes: 'Original old import' } });
    await db.externalImportRecord.create({ data: { familyId: 'feed-family', providerId: 'baby-buddy', sourceEntityType: 'feeding',
      sourceRecordId: 'legacy-bottle', sourceChildId: '7', targetEntityType: 'FeedLog', targetRecordId: old.id } });
    const result = await run(records('legacy-bottle,7,2026-10-20 08:00:00,2026-10-20 08:10:00,formula,bottle,90,Synthetic corrected import'));
    expect(result).toMatchObject({ created: 0, duplicates: 1, records: [{ targetRecordId: old.id, status: 'duplicate' }] });
    expect(await db.feedLog.findUniqueOrThrow({ where: { id: old.id } })).toEqual(old);
    expect(old.startTime).toBeNull(); expect(old.endTime).toBeNull(); expect(old.feedDuration).toBeNull();
  });
});
