import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
vi.mock('../app/api/db', () => ({ get default() { return state.db; } }));
vi.mock('../src/lib/notifications/activityHook', () => ({
  notifyActivityCreated: vi.fn(async () => {}), resetTimerNotificationState: vi.fn(async () => {}),
}));
// Exercise the real API-key wrapper, token hashing, scopes, and baby/family checks.
import { POST } from '../app/api/hooks/v1/babies/[babyId]/activities/route';
import { PUT } from '../app/api/hooks/v1/babies/[babyId]/activities/[activityId]/route';

const familyId = 'hook-pump-family';
const babyId = 'hook-pump-child';
const start = '2026-10-20T13:00:00Z';
let directory: string;
let token: string;

async function key(overrides: Record<string, unknown> = {}) {
  const value = 'st_live_synthetic_' + randomUUID();
  await state.db.apiKey.create({ data: {
    name: 'Synthetic pumping qualification', keyPrefix: value.slice(0, 16),
    keyHash: createHash('sha256').update(value).digest('hex'), familyId,
    scopes: JSON.stringify(['read', 'write']), ...overrides,
  } });
  return value;
}

function request(method: string, body: unknown, id?: string, credential: string | null = token, child = babyId) {
  return new NextRequest(`http://localhost/api/hooks/v1/babies/${child}/activities${id ? '/' + id : ''}`, {
    method, body: JSON.stringify(body), headers: {
      'Content-Type': 'application/json', ...(credential ? { Authorization: 'Bearer ' + credential } : {}),
    },
  });
}
const post = (body: Record<string, unknown>, credential: string | null = token, child = babyId) => POST(
  request('POST', { type: 'pump', action: 'log', time: start, ...body }, undefined, credential, child),
  { params: Promise.resolve({ babyId: child }) },
);
const put = (id: string, body: Record<string, unknown>, credential: string | null = token, child = babyId) => PUT(
  request('PUT', { type: 'pump', ...body }, id, credential, child),
  { params: Promise.resolve({ babyId: child, activityId: id }) },
);
const seedPump = (data: Record<string, unknown> = {}) => state.db.pumpLog.create({ data: {
  familyId, babyId, startTime: new Date(start), endTime: new Date('2026-10-20T13:20:00Z'),
  duration: 20, leftAmount: 40, rightAmount: 60, totalAmount: 100, unitAbbr: 'ML', pumpAction: 'UNKNOWN', ...data,
} });
const careRows = async () => ({
  pumps: await state.db.pumpLog.findMany({ orderBy: { id: 'asc' } }),
  feeds: await state.db.feedLog.findMany({ orderBy: { id: 'asc' } }),
});

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-hook-pump-'));
  const url = 'file:' + path.join(directory, 'synthetic.db');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
  });
  state.db = new PrismaClient({ adapter: createPrismaAdapter(url) });
  await state.db.family.createMany({ data: [
    { id: familyId, slug: 'hook-pump', name: 'Synthetic Family' },
    { id: 'hook-pump-other-family', slug: 'hook-pump-other', name: 'Other Synthetic Family' },
  ] });
  await state.db.baby.createMany({ data: [
    { id: babyId, familyId, firstName: 'Synthetic', lastName: 'Child', birthDate: new Date('2026-01-01Z') },
    { id: 'hook-pump-sibling', familyId, firstName: 'Synthetic', lastName: 'Sibling', birthDate: new Date('2026-01-01Z') },
    { id: 'hook-pump-other-child', familyId: 'hook-pump-other-family', firstName: 'Other', lastName: 'Child', birthDate: new Date('2026-01-01Z') },
  ] });
  await state.db.unit.createMany({ data: [
    { unitAbbr: 'ML', unitName: 'Milliliters' }, { unitAbbr: 'OZ', unitName: 'Ounces' },
    { unitAbbr: 'KG', unitName: 'Kilograms' },
  ] });
}, 90_000);

beforeEach(async () => {
  await state.db.feedLog.deleteMany();
  await state.db.pumpLog.deleteMany();
  await state.db.apiKey.deleteMany();
  token = await key();
});

afterAll(async () => {
  await state.db?.$disconnect();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('pumping hooks through real API-key auth and migrated SQLite', () => {
  it('rejects a negative logged volume without writing care records', async () => {
    const before = await careRows();
    const response = await post({ totalAmount: -3, unitAbbr: 'ML' });
    expect(response.status).toBe(400);
    expect(await careRows()).toEqual(before);
  });

  it('rejects ending a timer before its start without changing the active record', async () => {
    await seedPump({ endTime: null, duration: null });
    const before = await careRows();
    const response = await post({ action: 'end', time: '2026-10-20T12:59:59Z' });
    expect(response.status).toBe(400);
    expect(await careRows()).toEqual(before);
  });

  it('rejects a negative partial correction without changing care records', async () => {
    const pump = await seedPump();
    const before = await careRows();
    const response = await put(pump.id, { totalAmount: '-3' });
    expect(response.status).toBe(400);
    expect(await careRows()).toEqual(before);
  });

  it.each(['start', 'end', 'log'])('validates every supplied numeric field for POST %s, even when the action ignores it', async action => {
    await seedPump({ endTime: null, duration: null });
    const before = await careRows();
    for (const invalid of [
      { leftAmount: '-1' }, { rightAmount: -2 }, { totalAmount: '1e400' },
      { totalAmount: Number.MAX_VALUE }, { duration: -1 }, { duration: '0.5' }, { duration: 2_147_483_648 },
    ]) {
      const response = await post({ action, time: '2026-10-20T13:20:00Z', ...invalid });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('duration' in invalid ? 'INVALID_DURATION' : 'INVALID_AMOUNT');
      expect(await careRows()).toEqual(before);
    }
  });

  it('rejects individually representable sides whose sum exceeds safe inventory precision', async () => {
    const side = Number.MAX_SAFE_INTEGER / 100 * 0.75;
    expect((await post({ leftAmount: side, rightAmount: side, unitAbbr: 'ML' })).status).toBe(400);
    expect(await state.db.pumpLog.count()).toBe(0);
  });

  it.each([null, 42, false, '', '2026-02-30T13:00:00Z', '2026-10-20T24:00:00Z'])('rejects explicit invalid POST time %j rather than substituting now or normalizing it', async time => {
    expect((await post({ time })).status).toBe(400);
    expect(await state.db.pumpLog.count()).toBe(0);
  });

  it('keeps omitted POST time as now and omitted quantities and duration unknown', async () => {
    const earliest = Date.now();
    expect((await post({ time: undefined })).status).toBe(200);
    const pump = await state.db.pumpLog.findFirstOrThrow();
    expect(pump.startTime.getTime()).toBeGreaterThanOrEqual(earliest);
    expect(pump.startTime.getTime()).toBeLessThanOrEqual(Date.now());
    expect(pump).toMatchObject({ duration: null, leftAmount: null, rightAmount: null, totalAmount: null, pumpAction: 'STORED' });
  });

  it('accepts numeric strings, lowercase enum and unit, and an explicit zero total and duration', async () => {
    expect((await post({ duration: '0', leftAmount: '1.25', rightAmount: '2.5', totalAmount: '0', unitAbbr: 'ml', pumpAction: 'discarded' })).status).toBe(200);
    const pump = await state.db.pumpLog.findFirstOrThrow();
    expect(pump).toMatchObject({ duration: 0, leftAmount: 1.25, rightAmount: 2.5, totalAmount: 0, unitAbbr: 'ML', pumpAction: 'DISCARDED' });
    expect(pump.endTime).toEqual(pump.startTime);
    expect(await state.db.feedLog.count()).toBe(0);
  });

  it('derives POST totals from known sides when the total is null, while retaining a non-null explicit total', async () => {
    expect((await post({ duration: '20', leftAmount: '0', rightAmount: '2.5', totalAmount: null, unitAbbr: 'oz' })).status).toBe(200);
    const derived = await state.db.pumpLog.findFirstOrThrow();
    expect(derived).toMatchObject({ leftAmount: 0, rightAmount: 2.5, totalAmount: 2.5, duration: 20, unitAbbr: 'OZ' });
    expect(derived.endTime?.toISOString()).toBe('2026-10-20T13:20:00.000Z');
    expect((await post({ leftAmount: '2', rightAmount: '3', totalAmount: '9' })).status).toBe(200);
    expect(await state.db.pumpLog.findFirstOrThrow({ where: { id: { not: derived.id } } })).toMatchObject({ totalAmount: 9 });
  });

  it('keeps omitted end fields, original source ownership, and UNKNOWN disposition on an active imported record', async () => {
    const pump = await seedPump({ endTime: null, duration: null, notes: 'Synthetic imported source' });
    const response = await post({ action: 'end', time: '2026-10-20T13:25:00Z' });
    expect(response.status).toBe(200);
    expect(await state.db.pumpLog.findUniqueOrThrow({ where: { id: pump.id } })).toMatchObject({
      id: pump.id, familyId, babyId, startTime: pump.startTime, notes: pump.notes,
      endTime: new Date('2026-10-20T13:25:00Z'), duration: 25,
      leftAmount: 40, rightAmount: 60, totalAmount: 100, unitAbbr: 'ML', pumpAction: 'UNKNOWN',
    });
    expect(await state.db.feedLog.count()).toBe(0);
  });

  it('retains the other side and unit on a partial timer-end quantity while deriving the total', async () => {
    const pump = await seedPump({ endTime: null, duration: null });
    expect((await post({ action: 'end', time: '2026-10-20T13:20:00Z', leftAmount: '0', pumpAction: 'discarded' })).status).toBe(200);
    expect(await state.db.pumpLog.findUniqueOrThrow({ where: { id: pump.id } })).toMatchObject({
      leftAmount: 0, rightAmount: 60, totalAmount: 60, unitAbbr: 'ML', pumpAction: 'DISCARDED',
    });
  });

  it.each([
    ['2026-03-08T01:55:00-05:00', '2026-03-08T03:05:00-04:00'],
    ['2026-11-01T01:55:00-04:00', '2026-11-01T01:05:00-05:00'],
  ])('ends an offset-defined timer using elapsed time across a DST transition', async (startTime, endTime) => {
    expect((await post({ action: 'start', time: startTime })).status).toBe(200);
    expect((await post({ action: 'end', time: endTime })).status).toBe(200);
    expect(await state.db.pumpLog.findFirstOrThrow()).toMatchObject({ startTime: new Date(startTime), endTime: new Date(endTime), duration: 10 });
  });

  it('validates PUT timestamps against the untouched endpoint before writing', async () => {
    const pump = await seedPump();
    const before = await careRows();
    for (const correction of [
      { endTime: '2026-10-20T12:59:59Z' }, { startTime: '2026-10-20T13:20:01Z' },
      { time: '2026-10-20T13:20:01Z' }, { endTime: '2026-02-30T13:00:00Z' },
      { startTime: null }, { endTime: null }, { endTime: 42 },
    ]) {
      expect((await put(pump.id, correction)).status).toBe(400);
      expect(await careRows()).toEqual(before);
    }
  });

  it('uses UTC for unzoned hook times independently of the host timezone', async () => {
    const originalTimezone = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      expect((await post({ time: '2026-10-20T13:00:00.125', duration: '20' })).status).toBe(200);
      const pump = await state.db.pumpLog.findFirstOrThrow();
      expect(pump.startTime.toISOString()).toBe('2026-10-20T13:00:00.125Z');
      expect((await put(pump.id, { time: '2026-10-20T09:10:00.250-04:00' })).status).toBe(200);
      expect((await state.db.pumpLog.findUniqueOrThrow({ where: { id: pump.id } })).startTime.toISOString()).toBe('2026-10-20T13:10:00.250Z');
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });

  it('keeps PUT quantities and duration independent unless explicitly supplied, including null clearing', async () => {
    const pump = await seedPump({ totalAmount: 77 });
    expect((await put(pump.id, { leftAmount: '0', startTime: '2026-10-20T13:10:00Z', time: 'ignored alias' })).status).toBe(200);
    expect(await state.db.pumpLog.findUniqueOrThrow({ where: { id: pump.id } })).toMatchObject({
      leftAmount: 0, rightAmount: 60, totalAmount: 77, duration: 20, startTime: new Date('2026-10-20T13:10:00Z'), pumpAction: 'UNKNOWN',
    });
    expect((await put(pump.id, { totalAmount: null, duration: null })).status).toBe(200);
    expect(await state.db.pumpLog.findUniqueOrThrow({ where: { id: pump.id } })).toMatchObject({ totalAmount: null, duration: null, leftAmount: 0, rightAmount: 60 });
  });

  it('checks numeric PUT bounds and leaves a linked feeding row unchanged after invalid corrections', async () => {
    const pump = await seedPump({ pumpAction: 'FED' });
    await state.db.feedLog.create({ data: { babyId, familyId, time: new Date(start), type: 'BOTTLE', amount: 100, unitAbbr: 'ML', notes: 'Synthetic linked feed', sourcePumpId: pump.id } });
    const before = await careRows();
    for (const correction of [
      { leftAmount: -1 }, { rightAmount: '1e400' }, { totalAmount: Number.MAX_VALUE },
      { duration: -1 }, { duration: '0.5' }, { duration: 2_147_483_648 }, { pumpAction: null },
    ]) {
      expect((await put(pump.id, correction)).status).toBe(400);
      expect(await careRows()).toEqual(before);
    }
  });

  it('allows unrelated review of historical UNKNOWN records without rewriting invalid old measurements', async () => {
    const pump = await seedPump({ totalAmount: Number.MAX_VALUE, duration: -1, leftAmount: -2 });
    expect((await put(pump.id, { notes: 'Needs source review' })).status).toBe(200);
    expect(await state.db.pumpLog.findUniqueOrThrow({ where: { id: pump.id } })).toMatchObject({
      totalAmount: pump.totalAmount, duration: -1, leftAmount: -2, pumpAction: 'UNKNOWN', notes: 'Needs source review',
    });
    const before = await careRows();
    for (const correction of [{ unitAbbr: 'OZ' }, { pumpAction: 'stored' }, { pumpAction: 'fed' }]) {
      expect((await put(pump.id, correction)).status).toBe(400);
      expect(await careRows()).toEqual(before);
    }
  });

  it('restricts pumping to volume units even when weight units are configured', async () => {
    const pump = await seedPump();
    const before = await careRows();
    expect((await post({ action: 'start', unitAbbr: 'kg' })).status).toBe(400);
    expect((await post({ unitAbbr: 'kg', totalAmount: 1 })).status).toBe(400);
    expect((await put(pump.id, { unitAbbr: 'kg' })).status).toBe(400);
    expect(await careRows()).toEqual(before);
  });

  it.each([
    ['missing', 401], ['unknown', 401], ['revoked', 401], ['expired', 401], ['read-only', 403],
    ['restricted baby', 403], ['other family', 404],
  ])('rejects %s credentials on POST and PUT without changing care rows', async (kind, status) => {
    const pump = await seedPump();
    const before = await careRows();
    let credential: string | null;
    switch (kind) {
      case 'missing': credential = null; break;
      case 'unknown': credential = 'st_live_synthetic_not_persisted'; break;
      case 'revoked': credential = await key({ revoked: true }); break;
      case 'expired': credential = await key({ expiresAt: new Date('2000-01-01Z') }); break;
      case 'read-only': credential = await key({ scopes: JSON.stringify(['read']) }); break;
      case 'restricted baby': credential = await key({ babyId: 'hook-pump-sibling' }); break;
      default: credential = await key({ familyId: 'hook-pump-other-family' });
    }
    expect((await post({ totalAmount: 50 }, credential)).status).toBe(status);
    expect((await put(pump.id, { totalAmount: 50 }, credential)).status).toBe(status);
    expect(await careRows()).toEqual(before);
  });

  it('does not update an activity owned by another family or end a mismatched-family timer', async () => {
    const pump = await seedPump({ familyId: 'hook-pump-other-family', endTime: null, duration: null });
    const before = await careRows();
    expect((await put(pump.id, { totalAmount: 50 })).status).toBe(404);
    expect((await post({ action: 'end', time: '2026-10-20T13:20:00Z' })).status).toBe(400);
    expect(await careRows()).toEqual(before);
  });
});
