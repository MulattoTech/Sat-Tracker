import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PrismaClient, type Prisma, type PumpLog } from '@prisma/client';
import { NextRequest } from 'next/server';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';
import { autoPumpFeedNotes, calculateBreastMilkBalance } from '@/src/utils/breastMilkInventory';

type Gate = ReturnType<typeof makeGate>;
const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient, gate: null as Gate | null }));
vi.mock('../app/api/db', () => ({ get default() { return state.db; } }));
vi.mock('../src/lib/notifications/activityHook', () => ({
  notifyActivityCreated: vi.fn(async () => {}), resetTimerNotificationState: vi.fn(async () => {}),
}));
vi.mock('../app/api/utils/auth', () => ({
  withAuthContext: (handler: Function) => (request: NextRequest) => handler(request, {
    familyId: 'hook-sync-family', caretakerId: 'hook-sync-caregiver', caretakerRole: 'ADMIN',
  }),
}));
vi.mock('../app/api/utils/writeProtection', () => ({ checkWritePermission: () => ({ allowed: true }) }));
// Hook requests retain the real API-key auth, hash lookup, scopes and child checks.
import { POST } from '../app/api/hooks/v1/babies/[babyId]/activities/route';
import { PUT, DELETE } from '../app/api/hooks/v1/babies/[babyId]/activities/[activityId]/route';
import { POST as manualPost, PUT as manualPut, DELETE as manualDelete } from '../app/api/pump-log/route';

const familyId = 'hook-sync-family';
const babyId = 'hook-sync-child';
const caretakerId = 'hook-sync-caregiver';
const start = '2026-10-20T13:00:00Z';
let actual: PrismaClient;
let directory: string;
let token: string;

async function key(data: Record<string, unknown> = {}) {
  const value = 'st_live_synthetic_' + randomUUID();
  await actual.apiKey.create({ data: {
    name: 'Synthetic hook reconciliation', keyPrefix: value.slice(0, 16),
    keyHash: createHash('sha256').update(value).digest('hex'), familyId,
    scopes: JSON.stringify(['read', 'write']), ...data,
  } });
  return value;
}

function request(method: string, body?: unknown, id?: string, credential: string | null = token, child = babyId) {
  return new NextRequest(`http://localhost/api/hooks/v1/babies/${child}/activities${id ? '/' + id + '?type=pump' : ''}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers: {
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
const remove = (id: string, credential: string | null = token, child = babyId) => DELETE(
  request('DELETE', undefined, id, credential, child), { params: Promise.resolve({ babyId: child, activityId: id }) },
);
const seedPump = (data: Record<string, unknown> = {}) => actual.pumpLog.create({ data: {
  familyId, babyId, caretakerId, startTime: new Date(start), endTime: new Date('2026-10-20T13:20:00Z'),
  duration: 20, totalAmount: 100, unitAbbr: 'ML', pumpAction: 'FED', notes: 'Synthetic pump', ...data,
} });
const seedFeed = (pump: PumpLog, data: Record<string, unknown> = {}) => actual.feedLog.create({ data: {
  familyId: pump.familyId, babyId: pump.babyId, caretakerId: pump.caretakerId,
  time: pump.startTime, type: 'BOTTLE', bottleType: 'Breast Milk', amount: pump.totalAmount,
  unitAbbr: pump.unitAbbr ?? 'OZ', notes: autoPumpFeedNotes(pump.notes), sourcePumpId: pump.id, ...data,
} });
const careRows = async () => ({
  pumps: await actual.pumpLog.findMany({ orderBy: { id: 'asc' } }),
  feeds: await actual.feedLog.findMany({ orderBy: { id: 'asc' } }),
  adjustments: await actual.breastMilkAdjustment.findMany({ orderBy: { id: 'asc' } }),
});
const balance = async () => calculateBreastMilkBalance({
  pumpLogs: await actual.pumpLog.findMany({ where: { familyId, babyId, deletedAt: null } }),
  feedLogs: await actual.feedLog.findMany({ where: { familyId, babyId, deletedAt: null } }),
  adjustments: await actual.breastMilkAdjustment.findMany({ where: { familyId, babyId, deletedAt: null } }), targetUnit: 'ML',
});
const canonicalRequest = (method: string, body?: unknown, id?: string) => new NextRequest(
  `http://localhost/api/pump-log${id ? '?id=' + id : ''}`, { method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  },
);

function makeGate() {
  const releases: (() => void)[] = [];
  let onArrival: () => void = () => {};
  return {
    enter: () => new Promise<void>(resolve => { releases.push(resolve); onArrival(); }),
    reached: (count: number) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Expected ${count} transactions; saw ${releases.length}`)), 5_000);
      onArrival = () => { if (releases.length >= count) { clearTimeout(timer); resolve(); } };
      onArrival();
    }),
    release: (index: number) => releases[index]?.(),
    releaseAll: () => releases.forEach(release => release()),
  };
}

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-hook-sync-'));
  const url = 'file:' + path.join(directory, 'synthetic.db');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
  });
  actual = new PrismaClient({ adapter: createPrismaAdapter(url) });
  state.db = new Proxy(actual, { get(target, property) {
    if (property === '$transaction') return async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
      if (state.gate) await state.gate.enter();
      return target.$transaction(callback);
    };
    const member = Reflect.get(target, property);
    return typeof member === 'function' ? member.bind(target) : member;
  } });
  await actual.family.createMany({ data: [
    { id: familyId, slug: 'hook-sync', name: 'Synthetic Family' },
    { id: 'hook-sync-other-family', slug: 'hook-sync-other', name: 'Other Synthetic Family' },
  ] });
  await actual.baby.createMany({ data: [
    { id: babyId, familyId, firstName: 'Synthetic', lastName: 'Child', birthDate: new Date('2026-01-01Z') },
    { id: 'hook-sync-sibling', familyId, firstName: 'Synthetic', lastName: 'Sibling', birthDate: new Date('2026-01-01Z') },
    { id: 'hook-sync-other-child', familyId: 'hook-sync-other-family', firstName: 'Other', lastName: 'Child', birthDate: new Date('2026-01-01Z') },
  ] });
  await actual.caretaker.create({ data: { id: caretakerId, familyId, name: 'Synthetic Caregiver', type: 'Parent', loginId: 'sync-parent', securityPin: '123456' } });
  await actual.settings.create({ data: { familyId, enableBreastMilkTracking: true } });
  await actual.unit.createMany({ data: [{ unitAbbr: 'ML', unitName: 'Milliliters' }, { unitAbbr: 'OZ', unitName: 'Ounces' }] });
}, 90_000);

beforeEach(async () => {
  state.gate = null;
  await actual.feedLog.deleteMany();
  await actual.pumpLog.deleteMany();
  await actual.breastMilkAdjustment.deleteMany();
  await actual.apiKey.deleteMany();
  await actual.settings.updateMany({ where: { familyId }, data: { enableBreastMilkTracking: true } });
  token = await key();
});

afterAll(async () => {
  await actual?.$disconnect();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('atomic pumping hook feed ownership on migrated SQLite', () => {
  it('logs an explicitly FED quantity as one owned feed without consuming stored milk', async () => {
    const response = await post({ pumpAction: 'fed', totalAmount: '90', unitAbbr: 'ml', duration: 20 });
    expect(response.status).toBe(200);
    const pump = await actual.pumpLog.findFirstOrThrow();
    expect(await actual.feedLog.findMany()).toMatchObject([{
      sourcePumpId: pump.id, familyId, babyId, time: new Date(start), amount: 90, unitAbbr: 'ML', bottleType: 'Breast Milk',
    }]);
    expect(await balance()).toBe(0);
  });

  it('starts without inventing a feed and creates one owned feed when the timer ends FED', async () => {
    expect((await post({ action: 'start', totalAmount: 100, pumpAction: 'FED' })).status).toBe(200);
    const pump = await actual.pumpLog.findFirstOrThrow();
    expect(pump).toMatchObject({ totalAmount: null, endTime: null });
    expect(await actual.feedLog.count()).toBe(0);
    expect((await post({ action: 'end', time: '2026-10-20T13:20:00Z', pumpAction: 'FED', totalAmount: 100, unitAbbr: 'ML' })).status).toBe(200);
    const feed = await actual.feedLog.findFirstOrThrow();
    expect(feed).toMatchObject({ sourcePumpId: pump.id, amount: 100, time: pump.startTime });
    const beforeRetry = await careRows();
    expect((await post({ action: 'end', time: '2026-10-20T13:20:00Z' })).status).toBe(400);
    expect(await careRows()).toEqual(beforeRetry);
  });

  it('synchronizes quantity, time, unit and notes repeatedly without duplicating its feed', async () => {
    const pump = await seedPump();
    const feed = await seedFeed(pump);
    const change = { totalAmount: '3', unitAbbr: 'oz', time: '2026-10-20T13:10:00Z', notes: 'Corrected synthetic pump' };
    for (let n = 0; n < 2; n++) expect((await put(pump.id, change)).status).toBe(200);
    expect(await actual.feedLog.findMany()).toMatchObject([{ id: feed.id, sourcePumpId: pump.id, amount: 3, unitAbbr: 'OZ',
      time: new Date(change.time), notes: autoPumpFeedNotes(change.notes), caretakerId }]);
    expect(await balance()).toBe(0);
  });

  it('changes dispositions without duplicate inventory effects or changing unrelated care', async () => {
    const pump = await seedPump({ pumpAction: 'UNKNOWN' });
    const unrelated = await seedFeed(pump, { sourcePumpId: null, amount: 12, notes: 'An independently logged bottle' });
    const adjustment = await actual.breastMilkAdjustment.create({ data: { familyId, babyId, time: new Date(start), amount: 25, unitAbbr: 'ML', reason: 'Synthetic balance' } });
    for (const [pumpAction, expectedBalance, feedCount] of [
      ['UNKNOWN', 13, 1], ['STORED', 113, 1], ['FED', 13, 2], ['FED', 13, 2], ['DISCARDED', 13, 1], ['UNKNOWN', 13, 1],
    ] as const) {
      expect((await put(pump.id, { pumpAction })).status).toBe(200);
      expect(await balance()).toBe(expectedBalance);
      expect(await actual.feedLog.count()).toBe(feedCount);
      expect(await actual.feedLog.findUniqueOrThrow({ where: { id: unrelated.id } })).toEqual(unrelated);
      expect(await actual.breastMilkAdjustment.findMany()).toEqual([adjustment]);
    }
  });

  it.each([null, 0])('does not infer a feeding quantity from FED with total %s', async totalAmount => {
    expect((await post({ pumpAction: 'FED', totalAmount, unitAbbr: 'ML' })).status).toBe(200);
    expect(await actual.feedLog.count()).toBe(0);
  });

  it('honors disabled tracking and does not resolve historical UNKNOWN notes', async () => {
    await actual.settings.updateMany({ where: { familyId }, data: { enableBreastMilkTracking: false } });
    expect((await post({ pumpAction: 'FED', totalAmount: 80, unitAbbr: 'ML' })).status).toBe(200);
    expect(await actual.feedLog.count()).toBe(0);
    const pump = await seedPump({ pumpAction: 'UNKNOWN' });
    expect((await put(pump.id, { notes: 'Imported, needs source review' })).status).toBe(200);
    expect(await actual.pumpLog.findUniqueOrThrow({ where: { id: pump.id } })).toMatchObject({ pumpAction: 'UNKNOWN' });
    expect(await actual.feedLog.count()).toBe(0);
  });

  it('never adopts another legacy feed while resolving an UNKNOWN historical pump', async () => {
    const pump = await seedPump({ pumpAction: 'UNKNOWN' });
    const legacy = await seedFeed(pump, { sourcePumpId: null });
    expect((await put(pump.id, { notes: pump.notes })).status).toBe(200);
    expect(await actual.feedLog.findMany()).toEqual([legacy]);
    expect((await put(pump.id, { pumpAction: 'fed' })).status).toBe(200);
    expect(await actual.feedLog.findUniqueOrThrow({ where: { id: legacy.id } })).toEqual(legacy);
    expect(await actual.feedLog.count()).toBe(2);
    expect((await remove(pump.id)).status).toBe(200);
    expect(await actual.feedLog.findMany()).toEqual([legacy]);
  });

  it('advances the revision even when an unchanged correction is made in the same millisecond', async () => {
    const pump = await seedPump(); await seedFeed(pump);
    const now = vi.spyOn(Date, 'now').mockReturnValue(pump.updatedAt.getTime());
    try {
      expect((await put(pump.id, { totalAmount: 100 })).status).toBe(200);
      expect((await actual.pumpLog.findUniqueOrThrow({ where: { id: pump.id } })).updatedAt.getTime()).toBe(pump.updatedAt.getTime() + 1);
    } finally { now.mockRestore(); }
  });

  it('adopts an unambiguous existing legacy feed and deletes only the owned row', async () => {
    const pump = await seedPump();
    const legacy = await seedFeed(pump, { sourcePumpId: null });
    const unrelated = await seedFeed(pump, { sourcePumpId: null, notes: autoPumpFeedNotes('Different session') });
    expect((await put(pump.id, { totalAmount: 75 })).status).toBe(200);
    expect(await actual.feedLog.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({ sourcePumpId: pump.id, amount: 75 });
    expect((await remove(pump.id)).status).toBe(200);
    expect(await actual.pumpLog.count()).toBe(0);
    expect(await actual.feedLog.findMany()).toEqual([unrelated]);
    expect((await remove(pump.id)).status).toBe(404);
  });

  it('refuses ambiguous legacy ownership without changing either record', async () => {
    const pump = await seedPump();
    await seedFeed(pump, { sourcePumpId: null });
    await seedFeed(pump, { sourcePumpId: null });
    const before = await careRows();
    expect((await put(pump.id, { totalAmount: 75 })).status).toBe(409);
    expect((await remove(pump.id)).status).toBe(409);
    expect(await careRows()).toEqual(before);
  });

  it('refuses to adopt a legacy feed that also matches a different pumping session', async () => {
    const pump = await seedPump();
    await seedPump();
    await seedFeed(pump, { sourcePumpId: null });
    const before = await careRows();
    expect((await put(pump.id, { totalAmount: 75 })).status).toBe(409);
    expect((await remove(pump.id)).status).toBe(409);
    expect(await careRows()).toEqual(before);
  });

  it.each([['OZ', null], [null, 'OZ']])('treats %s and %s as competing ounce owners of one legacy feed', async (unit, otherUnit) => {
    const pump = await seedPump({ unitAbbr: unit });
    await seedPump({ unitAbbr: otherUnit });
    await seedFeed(pump, { sourcePumpId: null });
    const before = await careRows();
    expect((await put(pump.id, { totalAmount: 75 })).status).toBe(409);
    expect((await remove(pump.id)).status).toBe(409);
    expect(await careRows()).toEqual(before);
  });

  it('does not revive a soft-deleted owned feed on an unrelated correction', async () => {
    const pump = await seedPump();
    await seedFeed(pump, { deletedAt: new Date(start) });
    const before = await careRows();
    expect((await put(pump.id, { notes: 'Review without restoring a feed' })).status).toBe(409);
    expect(await careRows()).toEqual(before);
    expect((await remove(pump.id)).status).toBe(200);
    expect(await actual.feedLog.count()).toBe(0);
  });

  it.each(['hook-sync-other-child', 'hook-sync-sibling'])('refuses mismatched linked-feed ownership for %s atomically', async child => {
    const pump = await seedPump();
    await seedFeed(pump, { babyId: child, familyId: child === 'hook-sync-sibling' ? familyId : 'hook-sync-other-family' });
    const before = await careRows();
    expect((await put(pump.id, { totalAmount: 75 })).status).toBe(409);
    expect((await remove(pump.id)).status).toBe(409);
    expect(await careRows()).toEqual(before);
  });

  it('does not edit, end, or delete soft-deleted pumping records', async () => {
    const pump = await seedPump({ deletedAt: new Date(start), endTime: null });
    await seedFeed(pump);
    const before = await careRows();
    expect((await put(pump.id, { totalAmount: 75 })).status).toBe(404);
    expect((await remove(pump.id)).status).toBe(404);
    expect((await post({ action: 'end', time: '2026-10-20T13:20:00Z' })).status).toBe(400);
    expect(await careRows()).toEqual(before);
  });

  it('keeps hook-created and canonical-created pumps interoperable without duplicate feeds', async () => {
    const canonical = await manualPost(canonicalRequest('POST', { babyId, startTime: start, totalAmount: 60, unitAbbr: 'ML', pumpAction: 'FED' }));
    const pumpId = (await canonical.json()).data.id;
    const originalFeed = await actual.feedLog.findUniqueOrThrow({ where: { sourcePumpId: pumpId } });
    expect((await put(pumpId, { totalAmount: 65 })).status).toBe(200);
    expect((await manualPut(canonicalRequest('PUT', { totalAmount: 70 }, pumpId))).status).toBe(200);
    expect(await actual.feedLog.findMany()).toMatchObject([{ id: originalFeed.id, amount: 70 }]);
    expect((await remove(pumpId)).status).toBe(200);
    expect((await post({ totalAmount: 80, unitAbbr: 'ML', pumpAction: 'FED' })).status).toBe(200);
    const hooked = await actual.pumpLog.findFirstOrThrow();
    expect((await manualDelete(canonicalRequest('DELETE', undefined, hooked.id))).status).toBe(200);
    expect(await actual.feedLog.count()).toBe(0);
  });

  it.each(['INSERT', 'UPDATE', 'DELETE'] as const)('rolls back the pump when its feed %s fails', async operation => {
    const pump = operation === 'INSERT' ? null : await seedPump();
    if (pump) await seedFeed(pump);
    const before = await careRows();
    const sql = new Database(path.join(directory, 'synthetic.db'));
    try {
      sql.exec(`CREATE TRIGGER synthetic_feed_failure BEFORE ${operation} ON FeedLog BEGIN SELECT RAISE(ABORT, 'Synthetic feed failure'); END`);
      const response = operation === 'INSERT' ? await post({ totalAmount: 123, unitAbbr: 'ML', pumpAction: 'FED' }) :
        operation === 'UPDATE' ? await put(pump!.id, { totalAmount: 123 }) : await remove(pump!.id);
      expect(response.status).toBe(500);
      expect(await careRows()).toEqual(before);
    } finally { sql.exec('DROP TRIGGER IF EXISTS synthetic_feed_failure'); sql.close(); }
  });

  it.each(['update', 'same-time update', 'delete', 'end'] as const)('rejects an overlapping stale %s and preserves the winning pump and feed', async operation => {
    const pump = await seedPump(operation === 'end' ? { endTime: null, duration: null } : {});
    await seedFeed(pump);
    const gate = makeGate();
    state.gate = gate;
    const inFlight: Promise<Response>[] = [];
    try {
      const first = put(pump.id, { totalAmount: 80 }); inFlight.push(first);
      await gate.reached(1);
      const second = operation.includes('update') ? put(pump.id, { totalAmount: 90 }) :
        operation === 'delete' ? remove(pump.id) : post({ action: 'end', time: '2026-10-20T13:20:00Z', totalAmount: 90 });
      inFlight.push(second);
      await gate.reached(2);
      gate.release(0);
      expect((await first).status).toBe(200);
      if (operation === 'same-time update') {
        // Model a different writer that shares the original timestamp: the
        // changed business fields must still reject the old server snapshot.
        await actual.pumpLog.update({ where: { id: pump.id }, data: { updatedAt: pump.updatedAt } });
      }
      const winner = await careRows();
      if (operation !== 'same-time update') expect(winner.pumps[0].updatedAt.getTime()).toBeGreaterThan(pump.updatedAt.getTime());
      gate.release(1);
      expect((await second).status).toBe(409);
      expect(await careRows()).toEqual(winner);
    } finally { gate.releaseAll(); await Promise.allSettled(inFlight); state.gate = null; }
  });

  it.each(['missing', 'read-only', 'restricted', 'other family'])('denies %s credentials without changing any care rows', async kind => {
    const pump = await seedPump(); await seedFeed(pump);
    const credential = kind === 'missing' ? null : await key(kind === 'read-only' ? { scopes: '["read"]' } :
      kind === 'restricted' ? { babyId: 'hook-sync-sibling' } : { familyId: 'hook-sync-other-family' });
    const before = await careRows();
    const status = kind === 'missing' ? 401 : kind === 'other family' ? 404 : 403;
    expect((await post({ totalAmount: 80, pumpAction: 'FED' }, credential)).status).toBe(status);
    expect((await put(pump.id, { totalAmount: 80 }, credential)).status).toBe(status);
    expect((await remove(pump.id, credential)).status).toBe(status);
    expect(await careRows()).toEqual(before);
  });
});
