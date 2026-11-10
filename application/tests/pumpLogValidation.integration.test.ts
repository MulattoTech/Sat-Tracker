import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';
import { OZ_TO_ML } from '@/src/utils/unit-conversion';

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient, familyId: 'pump-validation-family' }));
vi.mock('../app/api/db', () => ({ get default() { return state.db; } }));
vi.mock('../app/api/utils/auth', () => ({
  withAuthContext: (handler: Function) => (request: NextRequest) => handler(request, {
    familyId: state.familyId, caretakerId: 'pump-validation-caretaker', caretakerRole: 'ADMIN',
  }),
}));
vi.mock('../app/api/utils/writeProtection', () => ({ checkWritePermission: () => ({ allowed: true }) }));
vi.mock('../src/lib/notifications/activityHook', () => ({ notifyActivityCreated: vi.fn(async () => {}) }));
import { POST, PUT } from '../app/api/pump-log/route';
import { GET as GET_BALANCE } from '../app/api/breast-milk-balance/route';

let directory: string;
const valid = { babyId: 'pump-validation-child', startTime: '2026-10-20T13:00:00Z',
  endTime: '2026-10-20T13:20:00Z', totalAmount: 100, unitAbbr: 'ML', pumpAction: 'UNKNOWN' };
const request = (method: string, body: unknown, id?: string, raw = false) => new NextRequest(
  `http://localhost/api/pump-log${id ? '?id=' + id : ''}`,
  { method, body: raw ? body as string : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } },
);
const create = (body: unknown = valid) => POST(request('POST', body));
const update = (id: string, body: unknown) => PUT(request('PUT', body, id));
const saved = (id: string) => state.db.pumpLog.findUniqueOrThrow({ where: { id } });
const balance = async () => {
  const response = await GET_BALANCE(new NextRequest('http://localhost/api/breast-milk-balance?babyId=pump-validation-child&unit=ML'));
  expect(response.status).toBe(200);
  return (await response.json()).data.balance;
};

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-pump-validation-'));
  const url = 'file:' + path.join(directory, 'synthetic.db');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
  });
  state.db = new PrismaClient({ adapter: createPrismaAdapter(url) });
  await state.db.family.create({ data: { id: state.familyId, slug: 'pump-validation', name: 'Synthetic Family' } });
  await state.db.baby.create({ data: { id: valid.babyId, familyId: state.familyId,
    firstName: 'Synthetic', lastName: 'Child', birthDate: new Date('2026-01-01Z') } });
  await state.db.caretaker.create({ data: { id: 'pump-validation-caretaker', familyId: state.familyId,
    name: 'Synthetic Caregiver', type: 'Parent', loginId: 'validation', securityPin: '123456' } });
  await state.db.settings.create({ data: { familyId: state.familyId, enableBreastMilkTracking: true } });
  await state.db.unit.createMany({ data: [{ unitAbbr: 'ML', unitName: 'Milliliters' }, { unitAbbr: 'OZ', unitName: 'Ounces' }] });
}, 90_000);

beforeEach(async () => {
  state.familyId = 'pump-validation-family';
  await state.db.feedLog.deleteMany();
  await state.db.pumpLog.deleteMany();
});

afterAll(async () => {
  await state.db?.$disconnect();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('canonical pumping input validation on migrated SQLite', () => {
  it.each(['leftAmount', 'rightAmount', 'totalAmount'])('rejects a negative %s before creating stock or a feed', async field => {
    const response = await create({ ...valid, [field]: -10, pumpAction: 'STORED' });
    expect(response.status).toBe(400);
    expect(await state.db.pumpLog.count()).toBe(0);
    expect(await state.db.feedLog.count()).toBe(0);
    expect(await balance()).toBe(0);
  });

  it('rejects a reversed interval before persisting a negative duration', async () => {
    expect((await create({ ...valid, endTime: '2026-10-20T12:59:59Z' })).status).toBe(400);
    expect(await state.db.pumpLog.count()).toBe(0);
  });

  it('requires a real start timestamp rather than substituting the current time', async () => {
    const { startTime, ...missingStart } = valid;
    expect((await create(missingStart)).status).toBe(400);
    expect(await state.db.pumpLog.count()).toBe(0);
  });

  it('rejects a negative correction atomically without removing the owned automatic feed', async () => {
    expect((await create({ ...valid, pumpAction: 'FED' })).status).toBe(200);
    const before = await state.db.pumpLog.findFirstOrThrow();
    const feeds = await state.db.feedLog.findMany();
    expect(feeds).toHaveLength(1);
    expect((await update(before.id, { totalAmount: -10 })).status).toBe(400);
    expect(await saved(before.id)).toEqual(before);
    expect(await state.db.feedLog.findMany()).toEqual(feeds);
  });

  it.each(['12', true, {}, []])('rejects a non-numeric amount %j with a client error', async amount => {
    expect((await create({ ...valid, totalAmount: amount })).status).toBe(400);
    expect(await state.db.pumpLog.count()).toBe(0);
  });

  it('rejects non-finite JSON numbers and overflow when adding finite sides', async () => {
    const raw = JSON.stringify(valid).replace('"totalAmount":100', '"totalAmount":1e400');
    expect((await POST(request('POST', raw, undefined, true))).status).toBe(400);
    expect((await create({ ...valid, totalAmount: undefined, leftAmount: Number.MAX_VALUE, rightAmount: Number.MAX_VALUE })).status).toBe(400);
    expect(await state.db.pumpLog.count()).toBe(0);
  });

  it('rejects a finite amount that would overflow unit conversion or balance rounding', async () => {
    const response = await create({ ...valid, totalAmount: Number.MAX_VALUE, unitAbbr: 'OZ', pumpAction: 'STORED' });
    expect({ status: response.status, balance: await balance() }).toEqual({ status: 400, balance: 0 });
    expect(await state.db.pumpLog.count()).toBe(0);
  });

  it('guards each submitted side, derived totals, and updates from downstream arithmetic overflow', async () => {
    expect((await create({ ...valid, leftAmount: Number.MAX_VALUE })).status).toBe(400);
    const safeSide = Number.MAX_SAFE_INTEGER / 100 * 0.75;
    expect((await create({ ...valid, totalAmount: undefined, leftAmount: safeSide, rightAmount: safeSide, unitAbbr: 'ML' })).status).toBe(400);
    expect((await create({ ...valid, pumpAction: 'FED' })).status).toBe(200);
    const before = await state.db.pumpLog.findFirstOrThrow();
    const feeds = await state.db.feedLog.findMany();
    expect((await update(before.id, { totalAmount: Number.MAX_VALUE })).status).toBe(400);
    expect(await saved(before.id)).toEqual(before);
    expect(await state.db.feedLog.findMany()).toEqual(feeds);
  });

  it('checks historical totals when resolving stock or changing units while preserving unrelated review', async () => {
    const pump = await state.db.pumpLog.create({ data: { familyId: state.familyId, babyId: valid.babyId,
      startTime: new Date(valid.startTime), pumpAction: 'UNKNOWN', totalAmount: Number.MAX_VALUE, unitAbbr: 'ML' } });
    expect((await update(pump.id, { pumpAction: 'STORED' })).status).toBe(400);
    expect((await update(pump.id, { pumpAction: 'FED' })).status).toBe(400);
    expect((await update(pump.id, { unitAbbr: 'OZ' })).status).toBe(400);
    expect(await saved(pump.id)).toEqual(pump);
    expect((await update(pump.id, { notes: 'Needs amount review' })).status).toBe(200);
    expect(await saved(pump.id)).toMatchObject({ totalAmount: pump.totalAmount, pumpAction: 'UNKNOWN', unitAbbr: 'ML' });
    expect(await balance()).toBe(0);
    expect(await state.db.feedLog.count()).toBe(0);
  });

  it('accepts large representable quantities without imposing an arbitrary clinical cap', async () => {
    expect((await create({ ...valid, totalAmount: 1_000_000_000.25, pumpAction: 'STORED' })).status).toBe(200);
    expect(await balance()).toBe(1_000_000_000.25);
  });

  it('rejects two individually finite volumes whose combination would overflow stock', async () => {
    const totalAmount = Number.MAX_VALUE / (OZ_TO_ML * 100) * 0.75;
    const statuses = [];
    for (let index = 0; index < 2; index++) {
      statuses.push((await create({ ...valid, totalAmount, unitAbbr: 'OZ', pumpAction: 'STORED' })).status);
    }
    expect({ statuses, balance: await balance() }).toEqual({ statuses: [400, 400], balance: 0 });
    expect(await state.db.pumpLog.count()).toBe(0);
  });

  it.each([-1, 0.5, 2_147_483_648])('rejects duration %j outside the non-negative Prisma Int contract', async duration => {
    expect((await create({ ...valid, duration })).status).toBe(400);
    expect(await state.db.pumpLog.count()).toBe(0);
  });

  it.each([null, 42, '', 'invalid', '2026-02-30T13:00:00Z', '2026-10-20T24:00:00Z'])('rejects invalid start timestamp %j without inventing history', async startTime => {
    expect((await create({ ...valid, startTime })).status).toBe(400);
    expect(await state.db.pumpLog.count()).toBe(0);
  });

  it.each([null, [], 'not an object'])('rejects invalid request shape %j', async body => {
    expect((await create(body)).status).toBe(400);
    expect(await state.db.pumpLog.count()).toBe(0);
  });

  it('validates partial time corrections against the untouched endpoint without changing the record', async () => {
    expect((await create()).status).toBe(200);
    const before = await state.db.pumpLog.findFirstOrThrow();
    expect((await update(before.id, { endTime: '2026-10-20T12:59:59Z' })).status).toBe(400);
    expect((await update(before.id, { startTime: '2026-10-20T13:20:01Z' })).status).toBe(400);
    expect((await update(before.id, { duration: -5 })).status).toBe(400);
    expect(await saved(before.id)).toEqual(before);
  });

  it('keeps explicit totals authoritative and recomputes only when a side changes without a total', async () => {
    expect((await create({ ...valid, leftAmount: 10.25, rightAmount: 20.5, totalAmount: 50 })).status).toBe(200);
    const pump = await state.db.pumpLog.findFirstOrThrow();
    expect(pump).toMatchObject({ leftAmount: 10.25, rightAmount: 20.5, totalAmount: 50 });
    expect((await update(pump.id, { leftAmount: 5.25 })).status).toBe(200);
    expect(await saved(pump.id)).toMatchObject({ leftAmount: 5.25, rightAmount: 20.5, totalAmount: 25.75 });
    expect((await update(pump.id, { rightAmount: 0, totalAmount: 40 })).status).toBe(200);
    expect(await saved(pump.id)).toMatchObject({ leftAmount: 5.25, rightAmount: 0, totalAmount: 40, pumpAction: 'UNKNOWN' });
    expect(await balance()).toBe(0);
  });

  it('retains unknown quantities and durations while distinguishing an explicit zero', async () => {
    expect((await create({ ...valid, endTime: undefined, totalAmount: null, leftAmount: null, rightAmount: undefined, duration: null })).status).toBe(200);
    const pump = await state.db.pumpLog.findFirstOrThrow();
    expect(pump).toMatchObject({ leftAmount: null, rightAmount: null, totalAmount: null, endTime: null, duration: null, pumpAction: 'UNKNOWN' });
    expect((await update(pump.id, { notes: 'Only review notes' })).status).toBe(200);
    expect(await saved(pump.id)).toMatchObject({ leftAmount: null, rightAmount: null, totalAmount: null, endTime: null, duration: null });
    expect((await update(pump.id, { totalAmount: 0, duration: 0 })).status).toBe(200);
    expect(await saved(pump.id)).toMatchObject({ totalAmount: 0, duration: 0, leftAmount: null, rightAmount: null });
    expect(await state.db.feedLog.count()).toBe(0);
  });

  it('does not derive a known zero from two unknown sides', async () => {
    expect((await create({ ...valid, totalAmount: undefined, leftAmount: null, rightAmount: null })).status).toBe(200);
    const pump = await state.db.pumpLog.findFirstOrThrow();
    expect(pump).toMatchObject({ leftAmount: null, rightAmount: null, totalAmount: null });
    expect((await update(pump.id, { leftAmount: 0 })).status).toBe(200);
    expect(await saved(pump.id)).toMatchObject({ leftAmount: 0, rightAmount: null, totalAmount: 0 });
    expect((await update(pump.id, { leftAmount: null })).status).toBe(200);
    expect(await saved(pump.id)).toMatchObject({ leftAmount: null, rightAmount: null, totalAmount: null });
  });

  it('requires invalid old quantities to be corrected before stock resolution or side-derived totals', async () => {
    const pump = await state.db.pumpLog.create({ data: { familyId: state.familyId, babyId: valid.babyId,
      startTime: new Date(valid.startTime), pumpAction: 'UNKNOWN', totalAmount: -10, leftAmount: -15, rightAmount: 5, unitAbbr: 'ML' } });
    expect((await update(pump.id, { pumpAction: 'STORED' })).status).toBe(400);
    expect((await update(pump.id, { pumpAction: 'FED' })).status).toBe(400);
    expect((await update(pump.id, { rightAmount: 20 })).status).toBe(400);
    expect(await saved(pump.id)).toEqual(pump);
    expect((await update(pump.id, { pumpAction: 'DISCARDED' })).status).toBe(200);
    expect(await balance()).toBe(0);
    expect(await state.db.feedLog.count()).toBe(0);
  });

  it.each([null, ''])('rejects an explicit invalid disposition %j rather than assuming STORED', async pumpAction => {
    expect((await create({ ...valid, pumpAction })).status).toBe(400);
    expect(await state.db.pumpLog.count()).toBe(0);
  });

  it('rejects malformed JSON before database writes', async () => {
    expect((await POST(request('POST', '{', undefined, true))).status).toBe(400);
    expect(await state.db.pumpLog.count()).toBe(0);
  });

  it('uses elapsed rounded minutes across explicit offsets and preserves milliseconds', async () => {
    expect((await create({ ...valid, startTime: '2026-03-08T01:55:10.125-06:00', endTime: '2026-03-08T03:05:20.125-05:00' })).status).toBe(200);
    const pump = await state.db.pumpLog.findFirstOrThrow();
    expect(pump).toMatchObject({ startTime: new Date('2026-03-08T07:55:10.125Z'),
      endTime: new Date('2026-03-08T08:05:20.125Z'), duration: 10 });
    expect((await update(pump.id, { endTime: '2026-03-08T08:16:10.125' })).status).toBe(200);
    expect(await saved(pump.id)).toMatchObject({ startTime: pump.startTime,
      endTime: new Date('2026-03-08T08:16:10.125Z'), duration: 21 });
  });
});
