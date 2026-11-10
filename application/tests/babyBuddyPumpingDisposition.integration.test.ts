import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';
import { buildBabyBuddyImportRecords } from '@/src/lib/importers/baby-buddy';
import { executeExternalImport } from '@/src/lib/importers/execute';
import { autoPumpFeedNotes } from '@/src/utils/breastMilkInventory';

const state = vi.hoisted(() => ({
  db: null as unknown as PrismaClient,
  familyId: 'pump-family',
}));
vi.mock('../app/api/db', () => ({ get default() { return state.db; } }));
vi.mock('../app/api/utils/auth', () => ({
  withAuthContext: (handler: Function) => (request: NextRequest) => handler(request, {
    familyId: state.familyId, caretakerId: 'pump-caretaker', caretakerRole: 'ADMIN',
  }),
}));
vi.mock('../app/api/utils/writeProtection', () => ({ checkWritePermission: () => ({ allowed: true }) }));
vi.mock('../src/lib/notifications/activityHook', () => ({ notifyActivityCreated: vi.fn(async () => {}) }));
import { GET, POST, PUT, DELETE } from '../app/api/pump-log/route';
import { GET as GET_BALANCE } from '../app/api/breast-milk-balance/route';

let directory: string;
const header = 'id,child_id,start,end,amount,notes';
const sourceRow = 'source-pump,7,2026-10-20 08:00:10,2026-10-20 08:20:20,100,Original source note';
const request = (method: string, id?: string, body?: unknown) => new NextRequest(
  `http://localhost/api/pump-log${id ? '?id=' + id : ''}`,
  { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) },
);
const run = (rows = [sourceRow], sourceTimezone = 'America/Chicago') => state.db.$transaction(tx => executeExternalImport(tx, {
  familyId: 'pump-family', caretakerId: 'pump-caretaker',
  records: buildBabyBuddyImportRecords([{ name: 'Pumping.csv', content: [header, ...rows].join('\n') }], { pumpingUnit: 'ML' }),
  configuration: { sourceTimezone, childDestinations: { '7': { mode: 'existing', targetBabyId: 'pump-child' } } },
}));
const saved = (id: string) => state.db.pumpLog.findUniqueOrThrow({ where: { id } });
const update = (id: string, body: unknown) => PUT(request('PUT', id, body));
const balance = async () => {
  const response = await GET_BALANCE(new NextRequest('http://localhost/api/breast-milk-balance?babyId=pump-child&unit=ML'));
  expect(response.status).toBe(200);
  return (await response.json()).data.balance;
};
const sourceFields = ({ pumpAction, updatedAt, ...record }: Awaited<ReturnType<typeof saved>>) => record;

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-pump-disposition-'));
  const url = 'file:' + path.join(directory, 'synthetic.db');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
  });
  state.db = new PrismaClient({ adapter: createPrismaAdapter(url) });
  await state.db.family.createMany({ data: [
    { id: 'pump-family', slug: 'pump-synthetic', name: 'Synthetic Family' },
    { id: 'pump-other-family', slug: 'pump-other-synthetic', name: 'Other Synthetic Family' },
  ] });
  await state.db.baby.createMany({ data: [
    { id: 'pump-child', familyId: 'pump-family', firstName: 'Synthetic', lastName: 'Child', birthDate: new Date('2026-01-01Z') },
    { id: 'pump-other-child', familyId: 'pump-other-family', firstName: 'Other', lastName: 'Child', birthDate: new Date('2026-01-01Z') },
  ] });
  await state.db.caretaker.create({ data: { id: 'pump-caretaker', familyId: 'pump-family', name: 'Synthetic Caregiver', type: 'Parent', loginId: 'pump-synthetic', securityPin: '123456' } });
  await state.db.settings.create({ data: { familyId: 'pump-family', enableBreastMilkTracking: true } });
  await state.db.unit.create({ data: { unitAbbr: 'ML', unitName: 'Milliliters' } });
}, 90_000);

beforeEach(async () => {
  state.familyId = 'pump-family';
  await state.db.feedLog.deleteMany();
  await state.db.pumpLog.deleteMany();
  await state.db.externalImportRecord.deleteMany();
});

afterAll(async () => {
  await state.db?.$disconnect();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('Baby Buddy pumping disposition on migrated SQLite and canonical API', () => {
  it('calculates new imported pumping duration from actual instants across spring DST', async () => {
    const id = (await run(['spring-pump,7,2026-03-08 01:55:10,2026-03-08 03:05:20,100,Synthetic spring source'])).records[0].targetRecordId;
    expect(await saved(id)).toMatchObject({
      startTime: new Date('2026-03-08T07:55:10Z'), endTime: new Date('2026-03-08T08:05:20Z'),
      duration: 10, totalAmount: 100, unitAbbr: 'ML', pumpAction: 'UNKNOWN',
    });
    expect(await balance()).toBe(0);
    expect(await state.db.feedLog.count()).toBe(0);
  });

  it('persists unresolved sessions, zero amounts and provenance without inflating existing stock or inventing feeds', async () => {
    await state.db.pumpLog.create({ data: { familyId: 'pump-family', babyId: 'pump-child', startTime: new Date('2026-10-20Z'), totalAmount: 20, unitAbbr: 'ML', pumpAction: 'STORED' } });
    const before = await balance();
    const result = await run([sourceRow, 'source-zero,7,2026-10-20 09:00:10,2026-10-20 09:20:20,0,Stored in freezer is only a source note']);
    expect(result).toMatchObject({ created: 2, duplicates: 0 });
    const pump = await saved(result.records[0].targetRecordId);
    expect(pump).toMatchObject({ familyId: 'pump-family', babyId: 'pump-child', caretakerId: 'pump-caretaker',
      startTime: new Date('2026-10-20T13:00:10Z'), endTime: new Date('2026-10-20T13:20:20Z'),
      duration: 20, totalAmount: 100, unitAbbr: 'ML', leftAmount: null, rightAmount: null,
      pumpAction: 'UNKNOWN', notes: 'Original source note' });
    expect(await saved(result.records[1].targetRecordId)).toMatchObject({ totalAmount: 0, pumpAction: 'UNKNOWN', notes: 'Stored in freezer is only a source note' });
    expect(await state.db.externalImportRecord.findFirstOrThrow({ where: { sourceRecordId: 'source-pump' } }))
      .toMatchObject({ familyId: 'pump-family', providerId: 'baby-buddy', sourceEntityType: 'pumping', sourceChildId: '7', targetEntityType: 'PumpLog', targetRecordId: pump.id });
    expect(await balance()).toBe(before);
    expect(await state.db.feedLog.count()).toBe(0);
    const response = await GET(request('GET', pump.id));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ pumpAction: 'UNKNOWN', totalAmount: 100, startTime: pump.startTime.toISOString() });
  });

  it('replays to the same target without undoing an explicit stored correction', async () => {
    const result = await run();
    const id = result.records[0].targetRecordId;
    expect((await update(id, { pumpAction: 'STORED' })).status).toBe(200);
    const original = await saved(id);
    const replay = await run();
    expect(replay).toMatchObject({ created: 0, duplicates: 1, records: [{ targetRecordId: id, status: 'duplicate' }] });
    expect(await saved(id)).toEqual(original);
    expect(await balance()).toBe(100);
    expect(await state.db.pumpLog.count()).toBe(1);
    expect(await state.db.externalImportRecord.count()).toBe(1);
  });

  it('preserves previously imported STORED history on reimport', async () => {
    const result = await run();
    const old = await state.db.pumpLog.update({ where: { id: result.records[0].targetRecordId }, data: { pumpAction: 'STORED', notes: 'Previously imported by old version' } });
    expect(await run()).toMatchObject({ created: 0, duplicates: 1 });
    expect(await saved(old.id)).toEqual(old);
  });

  it('explicit corrections change inventory exactly once and synchronize only the owned feed', async () => {
    const id = (await run()).records[0].targetRecordId;
    const original = await saved(id);
    for (const [action, expectedBalance, expectedFeeds] of [
      ['STORED', 100, 0], ['FED', 0, 1], ['FED', 0, 1], ['UNKNOWN', 0, 0], ['DISCARDED', 0, 0],
    ] as const) {
      expect((await update(id, { pumpAction: action })).status).toBe(200);
      expect(await balance()).toBe(expectedBalance);
      expect(await state.db.feedLog.count()).toBe(expectedFeeds);
      expect(sourceFields(await saved(id))).toEqual(sourceFields(original));
      if (expectedFeeds) expect(await state.db.feedLog.findFirstOrThrow()).toMatchObject({ sourcePumpId: id, amount: 100, unitAbbr: 'ML' });
    }
  });

  it('replay and unrelated edits preserve old imported duration, unknown action and missing sides', async () => {
    const rows = ['source-pump,7,2026-03-08 01:55:10,2026-03-08 03:05:20,100,Original source note'];
    const id = (await run(rows)).records[0].targetRecordId;
    // Model a retained historical import from before elapsed-time correction.
    const original = await state.db.pumpLog.update({ where: { id }, data: { duration: 70 } });
    expect(await run(rows)).toMatchObject({ created: 0, duplicates: 1, records: [{ targetRecordId: id }] });
    expect(await saved(id)).toEqual(original);
    expect((await update(id, { notes: 'Caregiver review note' })).status).toBe(200);
    expect(await saved(id)).toMatchObject({ pumpAction: 'UNKNOWN', startTime: original.startTime, endTime: original.endTime,
      duration: 70, totalAmount: 100, leftAmount: null, rightAmount: null, notes: 'Caregiver review note' });
    expect(await balance()).toBe(0);
    expect(await state.db.feedLog.count()).toBe(0);
  });

  it.each([
    ['fall', '2026-11-01 00:55:10', '2026-11-01 02:05:20', '2026-11-01T05:55:10Z', '2026-11-01T08:05:20Z', 130],
    ['offset-fold', '2026-11-01 01:55:10-05:00', '2026-11-01 01:05:20-06:00', '2026-11-01T06:55:10Z', '2026-11-01T07:05:20Z', 10],
    ['midnight', '2026-10-20 23:59:30', '2026-10-21 00:14:45', '2026-10-21T04:59:30Z', '2026-10-21T05:14:45Z', 15],
    ['fractional', '2026-10-20T08:00:00.500Z', '2026-10-20T08:00:30.500Z', '2026-10-20T08:00:00.500Z', '2026-10-20T08:00:30.500Z', 1],
    ['zero', '2026-10-20 08:00:00', '2026-10-20 08:00:00', '2026-10-20T13:00:00Z', '2026-10-20T13:00:00Z', 0],
  ])('persists %s endpoints and rounded elapsed minutes without inventing stock', async (sourceRecordId, start, end, utcStart, utcEnd, duration) => {
    const rows = [`${sourceRecordId},7,${start},${end},100,Synthetic timing source`];
    const result = await run(rows);
    const id = result.records[0].targetRecordId;
    const original = await saved(id);
    expect(original).toMatchObject({ startTime: new Date(utcStart), endTime: new Date(utcEnd), duration,
      familyId: 'pump-family', babyId: 'pump-child', caretakerId: 'pump-caretaker',
      totalAmount: 100, unitAbbr: 'ML', pumpAction: 'UNKNOWN', notes: 'Synthetic timing source' });
    expect(await state.db.externalImportRecord.findFirstOrThrow({ where: { sourceRecordId } }))
      .toMatchObject({ familyId: 'pump-family', providerId: 'baby-buddy', sourceEntityType: 'pumping', sourceChildId: '7', targetRecordId: id });
    expect(await run(rows)).toMatchObject({ created: 0, duplicates: 1, records: [{ targetRecordId: id }] });
    expect(await saved(id)).toEqual(original);
    expect(await balance()).toBe(0);
    expect(await state.db.feedLog.count()).toBe(0);
  });

  it.each([
    ['gap', '2026-03-08 02:15:00', '2026-03-08 03:15:00', 'does not exist'],
    ['fold', '2026-11-01 01:15:00', '2026-11-01 02:15:00', 'ambiguous'],
    ['reversed-second', '2026-10-20 12:00:00', '2026-10-20 11:59:59', 'before start'],
    ['reversed-offset', '2026-10-20 12:00:00Z', '2026-10-20 12:30:00+01:00', 'before start'],
    ['calendar', '2026-02-30 12:00:00', '2026-03-02 12:10:00', 'calendar date'],
  ])('rejects %s atomically without changing pumps, provenance, feeds or inventory', async (id, start, end, error) => {
    await state.db.pumpLog.create({ data: { familyId: 'pump-family', babyId: 'pump-child', startTime: new Date('2026-10-20Z'), totalAmount: 20, unitAbbr: 'ML', pumpAction: 'STORED' } });
    const original = await state.db.pumpLog.findMany();
    await expect(run([sourceRow, `${id},7,${start},${end},100,Synthetic invalid row`])).rejects.toThrow(error);
    expect(await state.db.pumpLog.findMany()).toEqual(original);
    expect(await state.db.externalImportRecord.count()).toBe(0);
    expect(await state.db.feedLog.count()).toBe(0);
    expect(await balance()).toBe(20);
  });

  it('accepts explicit source offsets independently of the configured timezone', async () => {
    const id = (await run(['offset-zone,7,2026-11-01 01:55:10-05:00,2026-11-01 01:05:20-06:00,100,Synthetic offset source'], 'Asia/Tokyo')).records[0].targetRecordId;
    expect(await saved(id)).toMatchObject({ startTime: new Date('2026-11-01T06:55:10Z'), endTime: new Date('2026-11-01T07:05:20Z'), duration: 10 });
  });

  it('unknown edits, resolutions and deletion leave another session legacy feed untouched', async () => {
    const id = (await run()).records[0].targetRecordId;
    const pump = await saved(id);
    const legacy = await state.db.feedLog.create({ data: { familyId: 'pump-family', babyId: 'pump-child',
      time: pump.startTime, type: 'BOTTLE', bottleType: 'Breast Milk', amount: 100, unitAbbr: 'ML', notes: autoPumpFeedNotes('Another real session') } });
    for (const body of [{ notes: 'Only this pump note changes' }, { pumpAction: 'FED' }, { pumpAction: 'UNKNOWN' }]) {
      expect((await update(id, body)).status).toBe(200);
      expect(await state.db.feedLog.findUniqueOrThrow({ where: { id: legacy.id } })).toEqual(legacy);
    }
    expect((await DELETE(request('DELETE', id))).status).toBe(200);
    expect(await state.db.feedLog.findMany()).toEqual([legacy]);
  });

  it('still adopts and removes legacy feeds for a previously FED pump', async () => {
    const id = (await run()).records[0].targetRecordId;
    const pump = await state.db.pumpLog.update({ where: { id }, data: { pumpAction: 'FED' } });
    const legacy = await state.db.feedLog.create({ data: { familyId: 'pump-family', babyId: 'pump-child',
      caretakerId: pump.caretakerId, time: pump.startTime, type: 'BOTTLE', bottleType: 'Breast Milk',
      amount: 100, unitAbbr: 'ML', notes: autoPumpFeedNotes(pump.notes) } });
    expect((await update(id, { notes: 'Updated owned session' })).status).toBe(200);
    expect(await state.db.feedLog.findMany()).toMatchObject([{ id: legacy.id, sourcePumpId: id, notes: autoPumpFeedNotes('Updated owned session') }]);
    expect((await update(id, { pumpAction: 'UNKNOWN' })).status).toBe(200);
    expect(await state.db.feedLog.count()).toBe(0);
  });

  it('accepts canonical UNKNOWN for new manual records and rejects invalid actions without writing', async () => {
    const body = { babyId: 'pump-child', startTime: '2026-10-20T13:00:10Z', totalAmount: 100, unitAbbr: 'ML', pumpAction: 'UNKNOWN' };
    expect((await POST(request('POST', undefined, body))).status).toBe(200);
    const pump = await state.db.pumpLog.findFirstOrThrow();
    expect(pump).toMatchObject({ pumpAction: 'UNKNOWN', endTime: null, duration: null });
    expect((await POST(request('POST', undefined, { ...body, pumpAction: 'FROZEN' }))).status).toBe(400);
    expect((await update(pump.id, { pumpAction: 'FROZEN' })).status).toBe(400);
    expect(await state.db.pumpLog.count()).toBe(1);
    expect(await saved(pump.id)).toEqual(pump);
    expect(await balance()).toBe(0);
    expect(await state.db.feedLog.count()).toBe(0);
  });

  it('refuses cross-family reads, corrections, reassignments, deletion and stock queries', async () => {
    const id = (await run()).records[0].targetRecordId;
    const original = await saved(id);
    expect((await update(id, { babyId: 'pump-other-child', pumpAction: 'STORED' })).status).toBe(404);
    state.familyId = 'pump-other-family';
    expect((await GET(request('GET', id))).status).toBe(404);
    expect((await update(id, { pumpAction: 'STORED', familyId: 'pump-family' })).status).toBe(404);
    expect((await DELETE(request('DELETE', id))).status).toBe(404);
    expect((await GET_BALANCE(new NextRequest('http://localhost/api/breast-milk-balance?babyId=pump-child'))).status).toBe(404);
    expect(await saved(id)).toEqual(original);
    expect(await state.db.feedLog.count()).toBe(0);
  });
});
