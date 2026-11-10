// Real SQLite corrections with deterministic overlap between the two reads
// and their write transactions. No production or browser resources are used.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient, type Prisma, type PumpLog } from '@prisma/client';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';
import { convertIntegerDatetimes } from '../scripts/convert-sqlite-datetimes-core';

type Snapshot = ReturnType<typeof snapshot>;
type Gate = ReturnType<typeof makeGate>;
const state = vi.hoisted(() => ({
  db: null as unknown as PrismaClient,
  gate: null as Gate | null,
  familyId: 'pump-race-family',
}));
vi.mock('../app/api/db', () => ({ get default() { return state.db; } }));
// Model the trusted authentication result for two separate caregivers. The
// actual authentication middleware is deliberately outside this race test.
vi.mock('../app/api/utils/auth', () => ({
  withAuthContext: (handler: Function) => (request: NextRequest) => {
    const caretakerId = request.headers.get('x-synthetic-caregiver');
    if (!['pump-race-caregiver-a', 'pump-race-caregiver-b'].includes(caretakerId ?? '')) {
      throw new Error('The harness requires one of its two synthetic caregivers.');
    }
    return handler(request, { familyId: state.familyId, caretakerId, caretakerRole: 'ADMIN' });
  },
}));
vi.mock('../app/api/utils/writeProtection', () => ({ checkWritePermission: () => ({ allowed: true }) }));
vi.mock('../src/lib/notifications/activityHook', () => ({ notifyActivityCreated: vi.fn(async () => {}) }));
import { POST, PUT } from '../app/api/pump-log/route';
import { GET as GET_BALANCE } from '../app/api/breast-milk-balance/route';

let actual: PrismaClient;
let directory: string;
const babyId = 'pump-race-child';

function snapshot(row: PumpLog) {
  return {
    id: row.id, familyId: row.familyId, babyId: row.babyId, caretakerId: row.caretakerId,
    startTime: row.startTime.toISOString(), endTime: row.endTime?.toISOString() ?? null,
    duration: row.duration, leftAmount: row.leftAmount, rightAmount: row.rightAmount,
    totalAmount: row.totalAmount, unitAbbr: row.unitAbbr, pumpAction: row.pumpAction, notes: row.notes,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

function makeGate() {
  const releases: (() => void)[] = [];
  const listeners = new Set<() => void>();
  const reads: Snapshot[] = [];
  return {
    reads,
    async enter() {
      await new Promise<void>(resolve => {
        releases.push(resolve);
        for (const listener of listeners) listener();
      });
    },
    async reached(count: number) {
      if (releases.length >= count) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Only ${releases.length} transactions reached the gate; expected ${count}.`)); }, 5_000);
        const check = () => {
          if (releases.length >= count) { clearTimeout(timer); listeners.delete(check); resolve(); }
        };
        listeners.add(check);
        check();
      });
    },
    release(index: number) { releases[index]?.(); },
    releaseAll() { releases.forEach(release => release()); },
  };
}

function instrument(db: PrismaClient): PrismaClient {
  const pumpLog = new Proxy(db.pumpLog, {
    get(model, property) {
      const member = Reflect.get(model, property);
      if (property === 'findFirst') return async (...args: unknown[]) => {
        const row = await Reflect.apply(member, model, args) as PumpLog | null;
        if (state.gate && row) state.gate.reads.push(snapshot(row));
        return row;
      };
      return typeof member === 'function' ? member.bind(model) : member;
    },
  });
  return new Proxy(db, {
    get(target, property) {
      if (property === 'pumpLog') return pumpLog;
      if (property === '$transaction') return async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        // Both real reads and validation have already completed here. Only the
        // scheduling is controlled; transaction callbacks and writes are real.
        const gate = state.gate;
        if (gate) await gate.enter();
        return target.$transaction(callback);
      };
      const member = Reflect.get(target, property);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
}

function request(method: 'POST' | 'PUT', body: unknown, id?: string, caregiver = 'a') {
  return new NextRequest(`http://localhost/api/pump-log${id ? '?id=' + id : ''}`, {
    method, body: JSON.stringify(body), headers: {
      'Content-Type': 'application/json', 'x-synthetic-caregiver': 'pump-race-caregiver-' + caregiver,
    },
  });
}

async function seed(pumpAction: 'UNKNOWN' | 'STORED' | 'FED') {
  const response = await POST(request('POST', {
    babyId, startTime: '2026-10-20T13:00:00Z', endTime: '2026-10-20T14:00:00Z',
    leftAmount: 10, rightAmount: 20, totalAmount: 30, unitAbbr: 'ML', pumpAction,
  }));
  expect(response.status).toBe(200);
  return actual.pumpLog.findUniqueOrThrow({ where: { id: (await response.json()).data.id } });
}

async function controlledRace(pump: PumpLog, firstPatch: unknown, secondPatch: unknown, sameTimestamp = false) {
  const gate = makeGate();
  state.gate = gate;
  const inFlight: Promise<Response>[] = [];
  try {
    const first = PUT(request('PUT', firstPatch, pump.id, 'a'));
    inFlight.push(first);
    await gate.reached(1);
    const second = PUT(request('PUT', secondPatch, pump.id, 'b'));
    inFlight.push(second);
    await gate.reached(2);
    // Neither request has begun its write transaction; both saw the real old row.
    expect(gate.reads).toEqual([snapshot(pump), snapshot(pump)]);
    expect(snapshot(await actual.pumpLog.findUniqueOrThrow({ where: { id: pump.id } }))).toEqual(snapshot(pump));
    gate.release(0);
    const firstResponse = await first;
    if (sameTimestamp) {
      // Other writers can share millisecond timestamps. Matching the changed
      // business fields must still reject the old snapshot in that case.
      await actual.pumpLog.update({ where: { id: pump.id }, data: { updatedAt: pump.updatedAt } });
    }
    const afterFirst = snapshot(await actual.pumpLog.findUniqueOrThrow({ where: { id: pump.id } }));
    const feedsAfterFirst = await actual.feedLog.findMany({ orderBy: { id: 'asc' } });
    gate.release(1);
    const secondResponse = await second;
    const afterSecond = snapshot(await actual.pumpLog.findUniqueOrThrow({ where: { id: pump.id } }));
    return {
      original: snapshot(pump), requests: [firstPatch, secondPatch],
      authenticatedCaregivers: ['pump-race-caregiver-a', 'pump-race-caregiver-b'],
      readsBeforeAnyWrite: gate.reads, statuses: [firstResponse.status, secondResponse.status],
      responses: [await firstResponse.json(), await secondResponse.json()], afterFirst, afterSecond,
      feedsAfterFirst, feedsAfterSecond: await actual.feedLog.findMany({ orderBy: { id: 'asc' } }),
    };
  } finally {
    gate.releaseAll();
    await Promise.allSettled(inFlight);
    state.gate = null;
  }
}

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-pump-race-'));
  const url = 'file:' + path.join(directory, 'synthetic.db');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
  });
  actual = new PrismaClient({ adapter: createPrismaAdapter(url) });
  state.db = instrument(actual);
  await actual.family.create({ data: { id: state.familyId, slug: 'pump-race', name: 'Synthetic Race Family' } });
  await actual.baby.create({ data: { id: babyId, familyId: state.familyId, firstName: 'Synthetic', lastName: 'Child', birthDate: new Date('2026-01-01Z') } });
  await actual.caretaker.createMany({ data: ['a', 'b'].map(suffix => ({
    id: 'pump-race-caregiver-' + suffix, familyId: state.familyId, name: 'Synthetic Caregiver ' + suffix,
    type: 'Parent', role: 'ADMIN', loginId: 'race-' + suffix, securityPin: '123456',
  })) });
  await actual.settings.create({ data: { familyId: state.familyId, enableBreastMilkTracking: true } });
  await actual.unit.createMany({ data: [{ unitAbbr: 'ML', unitName: 'Milliliters' }, { unitAbbr: 'OZ', unitName: 'Ounces' }] });
}, 90_000);

beforeEach(async () => {
  await actual.feedLog.deleteMany();
  await actual.pumpLog.deleteMany();
});

afterAll(async () => {
  await actual?.$disconnect();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('canonical partial-PUT conflicts on migrated SQLite', () => {
  it.each(['STORED', 'FED'] as const)('rejects a sequentially stale %s form without changing the completed correction', async pumpAction => {
    const opened = await seed(pumpAction);
    const revision = opened.updatedAt.toISOString();
    const first = await PUT(request('PUT', { leftAmount: 40, expectedUpdatedAt: revision }, opened.id, 'a'));
    expect(first.status).toBe(200);
    const winner = await actual.pumpLog.findUniqueOrThrow({ where: { id: opened.id } });
    const winningFeeds = await actual.feedLog.findMany({ orderBy: { id: 'asc' } });
    // The second request does not start until the first has fully completed.
    const stale = await PUT(request('PUT', { rightAmount: 50, expectedUpdatedAt: revision }, opened.id, 'b'));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ success: false, error: expect.stringMatching(/changed.*review/i) });
    expect(await actual.pumpLog.findUniqueOrThrow({ where: { id: opened.id } })).toEqual(winner);
    expect(await actual.feedLog.findMany({ orderBy: { id: 'asc' } })).toEqual(winningFeeds);
    const balance = await GET_BALANCE(new NextRequest(`http://localhost/api/breast-milk-balance?babyId=${babyId}&unit=ML`, {
      headers: { 'x-synthetic-caregiver': 'pump-race-caregiver-a' },
    }));
    expect((await balance.json()).data.balance).toBe(pumpAction === 'STORED' ? 60 : 0);
    const reviewed = await PUT(request('PUT', { rightAmount: 50, expectedUpdatedAt: winner.updatedAt.toISOString() }, opened.id, 'b'));
    expect(reviewed.status).toBe(200);
    expect(await actual.pumpLog.findUniqueOrThrow({ where: { id: opened.id } })).toMatchObject({ leftAmount: 40, rightAmount: 50, totalAmount: 90 });
  });

  it('keeps the client revision check and overlapping-request claim independent', async () => {
    const opened = await seed('FED');
    const expectedUpdatedAt = opened.updatedAt.toISOString();
    const result = await controlledRace(opened, { leftAmount: 40, expectedUpdatedAt }, { rightAmount: 50, expectedUpdatedAt });
    expect(result.statuses).toEqual([200, 409]);
    expect(result.afterSecond).toEqual(result.afterFirst);
    expect(result.feedsAfterSecond).toEqual(result.feedsAfterFirst);
  });

  it('rejects malformed present revisions without mutation and retains legacy omitted-revision compatibility', async () => {
    const pump = await seed('FED');
    const feeds = await actual.feedLog.findMany({ orderBy: { id: 'asc' } });
    for (const expectedUpdatedAt of [null, '', 1, [], {}, 'not-a-date', '2026-02-30T00:00:00.000Z', pump.updatedAt.toISOString().replace('Z', '+00:00')]) {
      const response = await PUT(request('PUT', { totalAmount: 80, expectedUpdatedAt }, pump.id));
      expect(response.status, JSON.stringify(expectedUpdatedAt)).toBe(400);
      expect(await actual.pumpLog.findUniqueOrThrow({ where: { id: pump.id } })).toEqual(pump);
      expect(await actual.feedLog.findMany({ orderBy: { id: 'asc' } })).toEqual(feeds);
    }
    expect((await PUT(request('PUT', { notes: 'Legacy caller' }, pump.id))).status).toBe(200);
  });

  it('does not disclose revision conflicts across families', async () => {
    const pump = await seed('UNKNOWN');
    const originalFamily = state.familyId;
    try {
      state.familyId = 'different-synthetic-family';
      const response = await PUT(request('PUT', { totalAmount: 99, expectedUpdatedAt: 'invalid' }, pump.id));
      expect(response.status).toBe(404);
      expect(await response.json()).not.toHaveProperty('data');
      expect(await actual.pumpLog.findUniqueOrThrow({ where: { id: pump.id } })).toEqual(pump);
    } finally { state.familyId = originalFamily; }
  });

  it.each([false, true])('rejects a stale endpoint correction without changing the winner or feed (same timestamp: %s)', async sameTimestamp => {
    const result = await controlledRace(await seed('FED'),
      { startTime: '2026-10-20T13:50:00Z' }, { endTime: '2026-10-20T13:10:00Z' }, sameTimestamp);
    expect(result.statuses).toEqual([200, 409]);
    expect(result.responses[1]).toMatchObject({ success: false, error: expect.stringMatching(/changed.*review/i) });
    expect(result.afterFirst).toMatchObject({ startTime: '2026-10-20T13:50:00.000Z', endTime: '2026-10-20T14:00:00.000Z', duration: 10 });
    expect(result.afterSecond).toEqual(result.afterFirst);
    expect(result.feedsAfterSecond).toEqual(result.feedsAfterFirst);
    expect(result.feedsAfterSecond).toHaveLength(1);
    expect(result.feedsAfterSecond[0]).toMatchObject({ sourcePumpId: result.afterSecond.id,
      time: new Date('2026-10-20T13:50:00Z'), amount: 30, familyId: state.familyId });
    // A deliberate retry reads fresh state and is rejected by interval validation.
    const retry = await PUT(request('PUT', { endTime: '2026-10-20T13:10:00Z' }, result.afterSecond.id, 'b'));
    expect(retry.status).toBe(400);
    expect(snapshot(await actual.pumpLog.findUniqueOrThrow({ where: { id: result.afterSecond.id } }))).toEqual(result.afterFirst);
  });

  it.each(['STORED', 'FED'] as const)('rejects a stale side-derived total for a %s pump and supports an explicit refreshed retry', async pumpAction => {
    const result = await controlledRace(await seed(pumpAction), { leftAmount: 40 }, { rightAmount: 50 });
    expect(result.statuses).toEqual([200, 409]);
    expect(result.afterSecond).toEqual(result.afterFirst);
    expect(result.afterSecond).toMatchObject({ leftAmount: 40, rightAmount: 20, totalAmount: 60, pumpAction });
    expect(result.feedsAfterSecond).toEqual(result.feedsAfterFirst);
    const feeds = await actual.feedLog.findMany({ where: { sourcePumpId: result.afterSecond.id } });
    const response = await GET_BALANCE(new NextRequest(`http://localhost/api/breast-milk-balance?babyId=${babyId}&unit=ML`, {
      headers: { 'x-synthetic-caregiver': 'pump-race-caregiver-a' },
    }));
    expect(response.status).toBe(200);
    const stockBalance = (await response.json()).data.balance;
    if (pumpAction === 'STORED') { expect(stockBalance).toBe(60); expect(feeds).toHaveLength(0); }
    else { expect(stockBalance).toBe(0); expect(feeds).toHaveLength(1); expect(feeds[0].amount).toBe(60); }

    const retry = await PUT(request('PUT', { rightAmount: 50 }, result.afterSecond.id, 'b'));
    expect(retry.status).toBe(200);
    const afterRetry = await actual.pumpLog.findUniqueOrThrow({ where: { id: result.afterSecond.id } });
    expect(afterRetry).toMatchObject({ leftAmount: 40, rightAmount: 50, totalAmount: 90 });
    const retriedFeeds = await actual.feedLog.findMany({ where: { sourcePumpId: result.afterSecond.id } });
    if (pumpAction === 'FED') {
      expect(retriedFeeds).toHaveLength(1);
      expect(retriedFeeds[0]).toMatchObject({ id: feeds[0].id, amount: 90 });
    } else {
      const retriedBalance = await GET_BALANCE(new NextRequest(`http://localhost/api/breast-milk-balance?babyId=${babyId}&unit=ML`, {
        headers: { 'x-synthetic-caregiver': 'pump-race-caregiver-a' },
      }));
      expect((await retriedBalance.json()).data.balance).toBe(90);
      expect(retriedFeeds).toHaveLength(0);
    }
  });

  it.each([{}, { totalAmount: 30, pumpAction: 'UNKNOWN', startTime: '2026-10-20T13:00:00Z', endTime: '2026-10-20T14:00:00Z' }])('keeps unchanged UNKNOWN corrections valid and preserves all care fields (%j)', async patch => {
    const pump = await seed('UNKNOWN');
    const response = await PUT(request('PUT', patch, pump.id));
    expect(response.status).toBe(200);
    const { updatedAt: beforeUpdated, ...before } = snapshot(pump);
    const { updatedAt: afterUpdated, ...after } = snapshot(await actual.pumpLog.findUniqueOrThrow({ where: { id: pump.id } }));
    expect(after).toEqual(before);
    expect(Date.parse(afterUpdated)).toBeGreaterThan(Date.parse(beforeUpdated));
    expect(await actual.feedLog.count()).toBe(0);
  });

  it('matches legacy SQLite dates after the established startup conversion', async () => {
    const pump = await seed('UNKNOWN');
    const legacy = new Database(path.join(directory, 'synthetic.db'));
    try {
      legacy.prepare('UPDATE "PumpLog" SET "startTime"=?, "endTime"=?, "createdAt"=?, "updatedAt"=? WHERE "id"=?')
        .run(pump.startTime.getTime(), pump.endTime!.getTime(), pump.createdAt.getTime(), pump.updatedAt.getTime(), pump.id);
      convertIntegerDatetimes(legacy);
    } finally { legacy.close(); }
    const response = await PUT(request('PUT', { notes: 'Reviewed historical record' }, pump.id));
    expect(response.status).toBe(200);
    expect(await actual.pumpLog.findUniqueOrThrow({ where: { id: pump.id } })).toMatchObject({
      startTime: pump.startTime, endTime: pump.endTime, duration: 60, totalAmount: 30,
      pumpAction: 'UNKNOWN', notes: 'Reviewed historical record',
    });
    expect(await actual.feedLog.count()).toBe(0);
  });
});
