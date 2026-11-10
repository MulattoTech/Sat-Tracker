import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { PrismaClient, type Prisma, type PumpLog } from '@prisma/client';
import { NextRequest } from 'next/server';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';
import { autoPumpFeedNotes } from '@/src/utils/breastMilkInventory';

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient, gate: null as (() => Promise<void>) | null }));
vi.mock('../app/api/db', () => ({ get default() { return state.db; } }));
vi.mock('../app/api/utils/api-logger', () => ({ logApiCall: vi.fn(async () => {}), getClientInfo: () => ({}) }));
vi.mock('../src/lib/notifications/activityHook', () => ({ notifyActivityCreated: vi.fn(async () => {}) }));
import { PUT, DELETE } from '../app/api/pump-log/route';

const familyId = 'pump-owner-family', babyId = 'pump-owner-child', caretakerId = 'pump-owner-caregiver';
const startTime = new Date('2026-10-20T13:00:00Z');
let actual: PrismaClient, directory: string, secret: string, previousSecret: string | undefined;
const token = (family = familyId) => jwt.sign({ id: caretakerId, familyId: family, role: 'ADMIN', type: 'parent' }, secret, { expiresIn: '10m' });
const request = (method: string, id: string, body?: unknown, auth = token()) => new NextRequest(`http://localhost/api/pump-log?id=${id}`, {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
});
const update = (id: string, data: Record<string, unknown> = { notes: 'Reviewed pump' }, auth = token()) => PUT(request('PUT', id, data, auth));
const remove = (id: string, auth = token()) => DELETE(request('DELETE', id, undefined, auth));
const mutate = (method: string, id: string) => method === 'PUT' ? update(id) : remove(id);
const seedPump = (data: Record<string, unknown> = {}) => actual.pumpLog.create({ data: {
  familyId, babyId, caretakerId, startTime, endTime: new Date('2026-10-20T13:20:00Z'),
  duration: 20, totalAmount: 100, unitAbbr: 'ML', pumpAction: 'FED', notes: 'Original pump', ...data,
} });
const seedFeed = (pump: PumpLog, data: Record<string, unknown> = {}) => actual.feedLog.create({ data: {
  familyId: pump.familyId, babyId: pump.babyId, caretakerId: pump.caretakerId, time: pump.startTime,
  type: 'BOTTLE', bottleType: 'Breast Milk', amount: pump.totalAmount, unitAbbr: pump.unitAbbr || 'OZ',
  notes: autoPumpFeedNotes(pump.notes), sourcePumpId: pump.id, ...data,
} });
const careRows = async () => ({ pumps: await actual.pumpLog.findMany({ orderBy: { id: 'asc' } }),
  feeds: await actual.feedLog.findMany({ orderBy: { id: 'asc' } }), adjustments: await actual.breastMilkAdjustment.findMany() });

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-pump-ownership-'));
  const url = 'file:' + path.join(directory, 'synthetic.db');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
  });
  previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = secret = randomBytes(32).toString('hex');
  actual = new PrismaClient({ adapter: createPrismaAdapter(url) });
  state.db = new Proxy(actual, { get(target, property) {
    if (property === '$transaction') return async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
      await state.gate?.();
      return target.$transaction(callback);
    };
    const member = Reflect.get(target, property);
    return typeof member === 'function' ? member.bind(target) : member;
  } });
  await actual.family.createMany({ data: [familyId, 'pump-owner-other-family'].map(id => ({ id, slug: id, name: 'Synthetic Family' })) });
  await actual.baby.createMany({ data: [
    { id: babyId, familyId }, { id: 'pump-owner-sibling', familyId },
    { id: 'pump-owner-other-child', familyId: 'pump-owner-other-family' },
  ].map(child => ({ ...child, firstName: 'Synthetic', lastName: 'Child', birthDate: new Date('2026-01-01Z') })) });
  await actual.caretaker.createMany({ data: [caretakerId, 'pump-owner-other-caregiver'].map((id, index) => ({
    id, familyId, name: 'Synthetic Caregiver', type: 'Parent', role: 'ADMIN', loginId: `owner${index}`, securityPin: '123456',
  })) });
  await actual.settings.create({ data: { familyId, enableBreastMilkTracking: true } });
  await actual.unit.createMany({ data: [{ unitAbbr: 'ML', unitName: 'Milliliters' }, { unitAbbr: 'OZ', unitName: 'Ounces' }] });
}, 90_000);

beforeEach(async () => {
  state.gate = null;
  await actual.feedLog.deleteMany();
  await actual.pumpLog.deleteMany();
  await actual.breastMilkAdjustment.deleteMany();
  await actual.baby.updateMany({ data: { deletedAt: null } });
});

afterAll(async () => {
  await actual?.$disconnect();
  if (directory) rmSync(directory, { recursive: true, force: true });
  if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
});

describe('canonical pump feed ownership with real JWT auth and migrated SQLite', () => {
  it.each(['PUT', 'DELETE'])('%s leaves a different session with only the same time and amount untouched', async method => {
    const pump = await seedPump();
    const unrelated = await seedFeed(pump, { sourcePumpId: null, notes: autoPumpFeedNotes('Another session') });
    expect((await mutate(method, pump.id)).status).toBe(200);
    expect(await actual.feedLog.findUnique({ where: { id: unrelated.id } })).toEqual(unrelated);
    if (method === 'PUT') expect(await actual.feedLog.count({ where: { sourcePumpId: pump.id } })).toBe(1);
  });

  it.each(['PUT', 'DELETE'].flatMap(method => [
    { method, difference: 'caregiver', feedPatch: { caretakerId: 'pump-owner-other-caregiver' } },
    { method, difference: 'missing caregiver', feedPatch: { caretakerId: null } },
    { method, difference: 'volume unit', feedPatch: { unitAbbr: 'OZ' } },
  ]))('$method does not claim a different $difference as a legacy owner', async ({ method, feedPatch }) => {
    const pump = await seedPump();
    const unrelated = await seedFeed(pump, { sourcePumpId: null, ...feedPatch });
    expect((await mutate(method, pump.id)).status).toBe(200);
    expect(await actual.feedLog.findUnique({ where: { id: unrelated.id } })).toEqual(unrelated);
  });

  it.each(['PUT', 'DELETE'])('%s does not infer ownership from a missing historical total', async method => {
    const pump = await seedPump({ totalAmount: null });
    const unrelated = await seedFeed(pump, { sourcePumpId: null, amount: 75 });
    expect((await mutate(method, pump.id)).status).toBe(200);
    expect(await actual.feedLog.findMany()).toEqual([unrelated]);
  });

  it.each(['PUT', 'DELETE'])('%s rejects two indistinguishable legacy feeds atomically', async method => {
    const pump = await seedPump();
    await seedFeed(pump, { sourcePumpId: null });
    await seedFeed(pump, { sourcePumpId: null });
    const before = await careRows();
    const response = await mutate(method, pump.id);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'PUMP_RECONCILIATION_REQUIRED', error: expect.stringContaining('cannot be identified safely') });
    expect(await careRows()).toEqual(before);
  });

  it.each(['PUT', 'DELETE'])('%s rejects a legacy feed with two possible pump owners including default ounces', async method => {
    const pump = await seedPump({ unitAbbr: 'OZ' });
    await seedPump({ unitAbbr: null });
    await seedFeed(pump, { sourcePumpId: null });
    const before = await careRows();
    expect((await mutate(method, pump.id)).status).toBe(409);
    expect(await careRows()).toEqual(before);
  });

  it('does not resurrect an independently soft-deleted owned feed', async () => {
    const pump = await seedPump();
    await seedFeed(pump, { deletedAt: startTime });
    const before = await careRows();
    const response = await update(pump.id);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'PUMP_RECONCILIATION_REQUIRED', error: expect.stringContaining('was removed') });
    expect(await careRows()).toEqual(before);
  });

  it.each(['PUT', 'DELETE'].flatMap(method => [
    { method, scope: 'child', feedPatch: { babyId: 'pump-owner-sibling' } },
    { method, scope: 'family', feedPatch: { familyId: 'pump-owner-other-family', babyId: 'pump-owner-other-child' } },
  ]))('$method refuses an inconsistent cross-$scope source link without changing care', async ({ method, feedPatch }) => {
    const pump = await seedPump();
    await seedFeed(pump, feedPatch);
    const before = await careRows();
    expect((await mutate(method, pump.id)).status).toBe(409);
    expect(await careRows()).toEqual(before);
  });

  it.each(['PUT', 'DELETE'])('%s does not mutate an already soft-deleted pump', async method => {
    const pump = await seedPump({ deletedAt: startTime });
    await seedFeed(pump);
    const before = await careRows();
    expect([404, 409]).toContain((await mutate(method, pump.id)).status);
    expect(await careRows()).toEqual(before);
  });

  it.each([false, true])('keeps a winning correction when a stale deletion runs later, shared timestamp: %s', async sameTimestamp => {
    const pump = await seedPump();
    await seedFeed(pump);
    let release!: () => void, arrived!: () => void;
    const atGate = new Promise<void>(resolve => { arrived = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    state.gate = async () => { state.gate = null; arrived(); await blocked; };
    const staleDelete = remove(pump.id);
    try {
      await atGate;
      expect((await update(pump.id, { totalAmount: 125, notes: 'Winning correction' })).status).toBe(200);
      if (sameTimestamp) await actual.pumpLog.update({ where: { id: pump.id }, data: { updatedAt: pump.updatedAt } });
      const winner = await careRows();
      release();
      const response = await staleDelete;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'PUMP_CONFLICT' });
      expect(await careRows()).toEqual(winner);
    } finally { release(); await staleDelete; }
  });

  it.each([false, true])('preserves supported same-family child correction and moves only its owned feed, legacy: %s', async legacy => {
    const pump = await seedPump();
    const feed = await seedFeed(pump, legacy ? { sourcePumpId: null } : {});
    const unrelated = await seedFeed(pump, { sourcePumpId: null, babyId: 'pump-owner-sibling', notes: autoPumpFeedNotes('Another session') });
    expect((await update(pump.id, { babyId: 'pump-owner-sibling' })).status).toBe(200);
    expect(await actual.pumpLog.findUniqueOrThrow({ where: { id: pump.id } })).toMatchObject({ babyId: 'pump-owner-sibling' });
    expect(await actual.feedLog.findUniqueOrThrow({ where: { id: feed.id } })).toMatchObject({ sourcePumpId: pump.id, babyId: 'pump-owner-sibling', caretakerId });
    expect(await actual.feedLog.findUniqueOrThrow({ where: { id: unrelated.id } })).toEqual(unrelated);
  });

  it('removes only the original owned feed when correcting both child and disposition', async () => {
    const pump = await seedPump();
    await seedFeed(pump);
    const unrelated = await seedFeed(pump, { sourcePumpId: null, babyId: 'pump-owner-sibling' });
    expect((await update(pump.id, { babyId: 'pump-owner-sibling', pumpAction: 'STORED' })).status).toBe(200);
    expect(await actual.feedLog.findMany()).toEqual([unrelated]);
  });

  it('rejects foreign child reassignment and anonymous, expired, or other-family corrections and deletions', async () => {
    const pump = await seedPump();
    await seedFeed(pump);
    const before = await careRows();
    expect((await update(pump.id, { babyId: 'pump-owner-other-child' })).status).toBe(404);
    const expired = jwt.sign({ id: caretakerId, familyId, role: 'ADMIN' }, secret, { expiresIn: -1 });
    for (const [auth, status] of [['', 401], [expired, 401], [token('pump-owner-other-family'), 404]] as const) {
      expect((await update(pump.id, { notes: 'Unauthorized' }, auth)).status).toBe(status);
      expect((await remove(pump.id, auth)).status).toBe(status);
      expect(await careRows()).toEqual(before);
    }
  });

  it('rejects reassignment to a soft-deleted child that is unavailable in the care history', async () => {
    const pump = await seedPump();
    await seedFeed(pump);
    await actual.baby.update({ where: { id: 'pump-owner-sibling' }, data: { deletedAt: startTime } });
    const before = await careRows();
    expect((await update(pump.id, { babyId: 'pump-owner-sibling' })).status).toBe(404);
    expect(await careRows()).toEqual(before);
  });
});
