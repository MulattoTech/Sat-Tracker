import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';
import { getJournal, saveBottle, setJournalTarget } from '@/src/lib/bottle-journal/service';
import { commitLegacyJournal, previewLegacyJournal } from '@/src/lib/bottle-journal/legacy-service';

let db: PrismaClient, directory: string;
const actor = { familyId: 'journal-a', canManage: true }, other = { familyId: 'journal-b', canManage: true };
const bottle = { time: '2026-10-20T13:15:00Z', amount: 90, offeredAmount: 120, unitAbbr: 'ML', bottleType: 'Formula', formulaKcalOz: 22, formulaName: 'Synthetic formula', bottleLabel: 'Synthetic label', notes: 'Synthetic notes' };
beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-tracker-journal-'));
  const url = `file:${path.join(directory, 'synthetic.db')}`;
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000 });
  db = new PrismaClient({ adapter: createPrismaAdapter(url) });
  for (const id of ['journal-a', 'journal-b']) await db.family.create({ data: { id, slug: id, name: 'Synthetic test family' } });
  for (const [id, familyId] of [['child-a', 'journal-a'], ['child-a2', 'journal-a'], ['child-b', 'journal-b']]) await db.baby.create({ data: { id, familyId, firstName: 'Synthetic', lastName: 'Fixture', birthDate: new Date('2026-01-01T00:00:00Z') } });
  for (const unitAbbr of ['ML', 'OZ']) await db.unit.create({ data: { unitAbbr, unitName: unitAbbr } });
}, 90_000);
afterAll(async () => { await db?.$disconnect(); if (directory) rmSync(directory, { recursive: true, force: true }); });

describe('One canonical journal database', () => {
  it('saves once across retries, exposes the same FeedLog and rejects changed retry payloads', async () => {
    const id = randomUUID();
    expect(await saveBottle(db, actor, 'child-a', bottle, id)).toMatchObject({ created: true });
    expect(await saveBottle(db, actor, 'child-a', bottle, id)).toMatchObject({ created: false });
    expect(await db.feedLog.count({ where: { id } })).toBe(1);
    expect(await db.feedLog.findUniqueOrThrow({ where: { id } })).toMatchObject({ amount: 90, offeredAmount: 120, formulaKcalOz: 22, familyId: 'journal-a' });
    await expect(saveBottle(db, actor, 'child-a', { ...bottle, amount: 91 }, id)).rejects.toThrow('different values');
  });
  it('rejects cross-family reads, creates, edits and target changes', async () => {
    await expect(getJournal(db, other, 'child-a', '2026-10-20', 'UTC')).rejects.toThrow('not found');
    await expect(saveBottle(db, other, 'child-a', bottle, randomUUID())).rejects.toThrow('not found');
    await expect(setJournalTarget(db, other, 'child-a', 500)).rejects.toThrow('not found');
    await expect(setJournalTarget(db, { ...actor, canManage: false }, 'child-a', 500)).rejects.toThrow('administrator');
  });
  it('detects a stale edit and preserves the newer value', async () => {
    const id = randomUUID(); await saveBottle(db, actor, 'child-a', bottle, id);
    const original = await db.feedLog.findUniqueOrThrow({ where: { id } });
    await saveBottle(db, actor, 'child-a', { ...bottle, amount: 95 }, id, original.updatedAt.toISOString());
    await expect(saveBottle(db, actor, 'child-a', { ...bottle, amount: 96 }, id, original.updatedAt.toISOString())).rejects.toThrow('another device');
    expect((await db.feedLog.findUniqueOrThrow({ where: { id } })).amount).toBe(95);
  });
  it('counts preexisting and imported feeds in the same daily and rolling totals', async () => {
    await setJournalTarget(db, actor, 'child-a2', 500);
    await db.feedLog.create({ data: { familyId: actor.familyId, babyId: 'child-a2', type: 'BOTTLE', time: new Date(bottle.time), amount: 30, unitAbbr: 'ML' } });
    const rows = [{ ...bottle, sourceId: 'legacy-1' }];
    await expect(commitLegacyJournal(db, actor, 'child-a2', rows, false)).rejects.toThrow('Confirm');
    expect(await commitLegacyJournal(db, actor, 'child-a2', rows, true)).toEqual({ created: 1, duplicates: 0, skipped: 0 });
    expect(await commitLegacyJournal(db, actor, 'child-a2', rows, true)).toEqual({ created: 0, duplicates: 1, skipped: 0 });
    const journal = await getJournal(db, actor, 'child-a2', '2026-10-20', 'America/Chicago', new Date('2026-10-20T20:00:00Z'));
    expect(journal.totals).toMatchObject({ dailyMl: 120, rollingMl: 120, targetMl: 500 });
    expect(journal.rows).toHaveLength(2);
    await expect(commitLegacyJournal(db, actor, 'child-a', rows, true)).rejects.toThrow('another child');
  });
  it('requires an explicit decision for a matching legacy bottle and commits selected rows atomically', async () => {
    const rows = [{ ...bottle, sourceId: 'legacy-duplicate' }];
    await expect(commitLegacyJournal(db, actor, 'child-a2', rows, true)).rejects.toThrow('matching bottle');
    expect(await commitLegacyJournal(db, actor, 'child-a2', rows.map(row => ({ ...row, duplicateDecision: 'skip' })), true)).toMatchObject({ created: 0, skipped: 1 });
    const before = await db.feedLog.count();
    await expect(commitLegacyJournal(db, actor, 'child-a2', [{ ...bottle, time: '2026-10-20T15:00:00Z', sourceId: 'should-roll-back' }, ...rows], true)).rejects.toThrow('matching bottle');
    expect(await db.feedLog.count()).toBe(before);
    await expect(previewLegacyJournal(db, other, 'child-a2', '{"version":2,"feedings":[]}', 'json', 'UTC')).rejects.toThrow('not found');
  });
});
