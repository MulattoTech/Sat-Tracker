import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { PrismaClient, type ActiveBreastFeed } from '@prisma/client';
import { NextRequest } from 'next/server';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';

type Gate = ReturnType<typeof readGate>;
const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient, gate: null as Gate | null,
  notify: vi.fn(async () => {}), resetTimer: vi.fn(async () => {}) }));
vi.mock('../app/api/db', () => ({ get default() { return state.db; } }));
vi.mock('../app/api/utils/api-logger', () => ({ logApiCall: vi.fn(async () => {}), getClientInfo: () => ({}) }));
vi.mock('../src/lib/notifications/activityHook', () => ({ notifyActivityCreated: state.notify, resetTimerNotificationState: state.resetTimer }));
import { POST, PUT, DELETE } from '../app/api/active-breastfeed/route';
import { POST as hookPost } from '../app/api/hooks/v1/babies/[babyId]/activities/route';

const familyId = 'breastfeed-atomic-family', babyId = 'breastfeed-atomic-child';
const starter = 'breastfeed-atomic-starter', ender = 'breastfeed-atomic-ender';
let actual: PrismaClient, directory: string, secret: string, previousSecret: string | undefined;
let hookToken: string;
const token = (caretakerId = ender, family = familyId) => jwt.sign({ id: caretakerId, familyId: family, role: 'ADMIN', type: 'parent' }, secret, { expiresIn: '10m' });
const request = (method: string, id: string, action?: string, body?: unknown, auth = token()) => new NextRequest(
  `http://localhost/api/active-breastfeed?id=${id}${action ? '&action=' + action : ''}`, {
    method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  },
);
const finish = (id: string, auth = token()) => DELETE(request('DELETE', id, undefined, { leftDuration: 120, rightDuration: 60 }, auth));
const change = (id: string, action: string, auth = token()) => PUT(request('PUT', id, action, undefined, auth));
const hookFinish = () => hookPost(new NextRequest(`http://localhost/api/hooks/v1/babies/${babyId}/activities`, {
  method: 'POST', headers: { Authorization: `Bearer ${hookToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'feed', feedType: 'BREAST', action: 'end' }),
}), { params: Promise.resolve({ babyId }) });
const seed = (data: Record<string, unknown> = {}) => actual.activeBreastFeed.create({ data: {
  familyId, babyId, caretakerId: starter, activeSide: 'RIGHT', isPaused: false,
  leftDuration: 120, rightDuration: 60, pauseDuration: 30, firstSide: 'LEFT',
  sessionStartTime: new Date(Date.now() - 210_000), currentSideStartTime: new Date(), ...data,
} });
const rows = async () => ({ sessions: await actual.activeBreastFeed.findMany({ orderBy: { id: 'asc' } }),
  feeds: await actual.feedLog.findMany({ orderBy: { id: 'asc' } }) });

function readGate() {
  const releases: (() => void)[] = [];
  let changed = () => {};
  return {
    enter: () => new Promise<void>(resolve => { releases.push(resolve); changed(); }),
    reached: (count: number) => new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Expected ${count} session reads; saw ${releases.length}`)), 5000);
      changed = () => { if (releases.length >= count) { clearTimeout(timeout); resolve(); } };
      changed();
    }),
    release: (index: number) => releases[index]?.(),
    releaseAll: () => releases.forEach(release => release()),
  };
}

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-breastfeed-atomic-'));
  const url = 'file:' + path.join(directory, 'synthetic.db');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
  });
  previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = secret = randomBytes(32).toString('hex');
  actual = new PrismaClient({ adapter: createPrismaAdapter(url) });
  const activeBreastFeed = new Proxy(actual.activeBreastFeed, { get(model, property) {
    const member = Reflect.get(model, property);
    if (property === 'findFirst' || property === 'findUnique') return async (...args: unknown[]) => {
      const session = await Reflect.apply(member, model, args) as ActiveBreastFeed | null;
      if (session) await state.gate?.enter();
      return session;
    };
    return typeof member === 'function' ? member.bind(model) : member;
  } });
  state.db = new Proxy(actual, { get(target, property) {
    if (property === 'activeBreastFeed') return activeBreastFeed;
    const member = Reflect.get(target, property);
    return typeof member === 'function' ? member.bind(target) : member;
  } });
  await actual.family.createMany({ data: [familyId, 'breastfeed-other-family'].map(id => ({ id, slug: id, name: 'Synthetic Family' })) });
  await actual.baby.create({ data: { id: babyId, familyId, firstName: 'Synthetic', lastName: 'Child', birthDate: new Date('2026-01-01Z') } });
  await actual.caretaker.createMany({ data: [starter, ender].map((id, index) => ({ id, familyId,
    name: 'Synthetic Caregiver', type: 'Parent', role: 'ADMIN', loginId: `bf${index}`, securityPin: '123456' })) });
  hookToken = 'st_live_synthetic_' + randomUUID();
  await actual.apiKey.create({ data: { name: 'Synthetic breastfeeding', familyId,
    keyPrefix: hookToken.slice(0, 16), keyHash: createHash('sha256').update(hookToken).digest('hex'),
    scopes: JSON.stringify(['read', 'write']) } });
}, 90_000);

beforeEach(async () => {
  state.gate = null;
  await actual.feedLog.deleteMany();
  await actual.activeBreastFeed.deleteMany();
  state.notify.mockClear(); state.resetTimer.mockClear();
});

afterAll(async () => {
  await actual?.$disconnect();
  if (directory) rmSync(directory, { recursive: true, force: true });
  if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
});

describe('atomic active breastfeeding with real JWT auth and migrated SQLite', () => {
  it('rolls back the first side when the second feeding row fails and permits one clean retry', async () => {
    const session = await seed();
    const before = await rows();
    await actual.$executeRawUnsafe(`CREATE TRIGGER bf_fail_second BEFORE INSERT ON FeedLog WHEN NEW.side = 'RIGHT' BEGIN SELECT RAISE(ABORT, 'synthetic second-side failure'); END`);
    try {
      expect((await finish(session.id)).status).toBe(500);
      expect.soft(await rows()).toEqual(before);
      expect(state.notify).not.toHaveBeenCalled(); expect(state.resetTimer).not.toHaveBeenCalled();
    } finally { await actual.$executeRawUnsafe('DROP TRIGGER bf_fail_second'); }
    expect((await finish(session.id)).status).toBe(200);
    expect(await actual.feedLog.count()).toBe(2);
    expect(await actual.activeBreastFeed.count()).toBe(0);
    expect(state.notify).toHaveBeenCalledTimes(1); expect(state.resetTimer).toHaveBeenCalledTimes(1);
  });

  it('rolls back both feeding rows if removing the active session fails', async () => {
    const session = await seed();
    const before = await rows();
    await actual.$executeRawUnsafe(`CREATE TRIGGER bf_fail_delete BEFORE DELETE ON ActiveBreastFeed BEGIN SELECT RAISE(ABORT, 'synthetic session-delete failure'); END`);
    try {
      expect((await finish(session.id)).status).toBe(500);
      expect(await rows()).toEqual(before);
      expect(state.notify).not.toHaveBeenCalled(); expect(state.resetTimer).not.toHaveBeenCalled();
    } finally { await actual.$executeRawUnsafe('DROP TRIGGER bf_fail_delete'); }
  });

  it('rejects a stale end after another caregiver pauses the same session', async () => {
    const session = await seed();
    const gate = state.gate = readGate();
    const ending = finish(session.id);
    let pausing: Promise<Response> | undefined;
    try {
      await gate.reached(1);
      pausing = change(session.id, 'pause', token(starter));
      await gate.reached(2);
      gate.release(1);
      expect((await pausing).status).toBe(200);
      const winner = await rows();
      gate.release(0);
      expect.soft((await ending).status).toBe(409);
      expect(await rows()).toEqual(winner);
    } finally { gate.releaseAll(); await Promise.allSettled([ending, ...(pausing ? [pausing] : [])]); }
  });

  it('allows exactly one finalization when two caregivers already read the active session', async () => {
    const session = await seed();
    const gate = state.gate = readGate();
    const first = finish(session.id);
    let second: Promise<Response> | undefined;
    try {
      await gate.reached(1);
      second = finish(session.id, token(starter));
      await gate.reached(2);
      gate.release(0);
      expect((await first).status).toBe(200);
      const winner = await rows();
      gate.release(1);
      expect.soft((await second).status).toBe(409);
      expect(await rows()).toEqual(winner);
      expect(state.notify).toHaveBeenCalledTimes(1);
    } finally { gate.releaseAll(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
  });

  it('preserves explicit side durations, pause placement, grouping and authorized ending-caregiver attribution', async () => {
    const session = await seed();
    expect((await finish(session.id)).status).toBe(200);
    const feeds = await actual.feedLog.findMany({ orderBy: { startTime: 'asc' } });
    expect(feeds).toMatchObject([
      { familyId, babyId, caretakerId: ender, side: 'LEFT', feedDuration: 120, pauseDuration: 30,
        time: session.sessionStartTime, startTime: session.sessionStartTime, endTime: new Date(session.sessionStartTime.getTime() + 120_000) },
      { familyId, babyId, caretakerId: ender, side: 'RIGHT', feedDuration: 60, pauseDuration: 30,
        time: new Date(session.sessionStartTime.getTime() + 150_000), startTime: new Date(session.sessionStartTime.getTime() + 150_000),
        endTime: new Date(session.sessionStartTime.getTime() + 210_000) },
    ]);
    expect(feeds[0].sessionId).toBeTruthy(); expect(feeds[0].sessionId).toBe(feeds[1].sessionId);
    const before = await rows();
    expect((await finish(session.id)).status).toBe(404);
    expect(await rows()).toEqual(before);
  });

  it('rejects unauthorized or foreign-family actions without changing the active session', async () => {
    const session = await seed();
    const before = await rows();
    const expired = jwt.sign({ id: ender, familyId, role: 'ADMIN' }, secret, { expiresIn: -1 });
    for (const [auth, status] of [['', 401], [expired, 401], [token(ender, 'breastfeed-other-family'), 404]] as const) {
      expect((await finish(session.id, auth)).status).toBe(status);
      expect((await change(session.id, 'pause', auth)).status).toBe(status);
      expect(await rows()).toEqual(before);
    }
  });

  it.each([-1, null, '120', [], {}, false, 1.5, 2_147_483_648].map(value => ({ value })))('rejects invalid duration override $value without ending the session', async ({ value }) => {
    const session = await seed();
    const before = await rows();
    for (const body of [{ leftDuration: value, rightDuration: value }, { leftDuration: 120, rightDuration: 60, pauseDuration: value }]) {
      const response = await DELETE(request('DELETE', session.id, undefined, body));
      expect.soft(response.status).toBe(400);
      expect(await rows()).toEqual(before);
    }
    expect(state.notify).not.toHaveBeenCalled(); expect(state.resetTimer).not.toHaveBeenCalled();
  });

  it.each(['{broken', 'null', '[]', '120'])('rejects malformed optional duration body %s without silently using timer values', async body => {
    const session = await seed();
    const before = await rows();
    const response = await DELETE(new NextRequest(`http://localhost/api/active-breastfeed?id=${session.id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body,
    }));
    expect.soft(response.status).toBe(400);
    expect(await rows()).toEqual(before);
  });

  it('preserves explicit zero durations and does not invent a feeding side', async () => {
    const session = await seed();
    const response = await DELETE(request('DELETE', session.id, undefined, { leftDuration: 0, rightDuration: 0 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { feedLogsCreated: 0, feedLogIds: [] } });
    expect(await rows()).toEqual({ sessions: [], feeds: [] });
  });

  it('rejects sequentially stale duration overrides and timer actions using the displayed revision', async () => {
    const session = await seed();
    expect((await change(session.id, 'pause')).status).toBe(200);
    const winner = await rows();
    expect(winner.sessions[0].updatedAt.getTime()).toBeGreaterThan(session.updatedAt.getTime());
    for (const response of [
      await DELETE(request('DELETE', session.id, undefined, { leftDuration: 120, rightDuration: 60, expectedUpdatedAt: session.updatedAt.toISOString() })),
      await PUT(request('PUT', session.id, 'switch', { expectedUpdatedAt: session.updatedAt.toISOString() })),
    ]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'BREASTFEED_CONFLICT' });
      expect(await rows()).toEqual(winner);
    }
    expect((await DELETE(request('DELETE', session.id, undefined, {
      leftDuration: 120, rightDuration: 60, expectedUpdatedAt: winner.sessions[0].updatedAt.toISOString(),
    }))).status).toBe(200);
    expect(await actual.feedLog.count()).toBe(2);
  });

  it.each([null, '', 'yesterday', '2026-02-30T00:00:00.000Z', 42])('rejects invalid displayed revision %j before any finalization', async expectedUpdatedAt => {
    const session = await seed();
    const before = await rows();
    expect((await DELETE(request('DELETE', session.id, undefined, { leftDuration: 120, rightDuration: 60, expectedUpdatedAt }))).status).toBe(400);
    expect(await rows()).toEqual(before);
  });

  it.each([false, true])('rejects an overlapping stale timer action, shared timestamp: %s', async sameTimestamp => {
    const session = await seed();
    const gate = state.gate = readGate();
    const first = change(session.id, 'switch');
    let second: Promise<Response> | undefined;
    try {
      await gate.reached(1);
      second = change(session.id, 'pause', token(starter));
      await gate.reached(2);
      gate.release(0);
      expect((await first).status).toBe(200);
      if (sameTimestamp) await actual.activeBreastFeed.update({ where: { id: session.id }, data: { updatedAt: session.updatedAt } });
      const winner = await rows();
      gate.release(1);
      expect((await second).status).toBe(409);
      expect(await rows()).toEqual(winner);
    } finally { gate.releaseAll(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
  });

  it('rolls back both sides through the real API-key hook when session removal fails', async () => {
    await seed();
    const before = await rows();
    await actual.$executeRawUnsafe(`CREATE TRIGGER bf_hook_fail_delete BEFORE DELETE ON ActiveBreastFeed BEGIN SELECT RAISE(ABORT, 'synthetic hook failure'); END`);
    try {
      expect((await hookFinish()).status).toBe(500);
      expect(await rows()).toEqual(before);
    } finally { await actual.$executeRawUnsafe('DROP TRIGGER bf_hook_fail_delete'); }
    expect((await hookFinish()).status).toBe(200);
    expect(await actual.feedLog.count()).toBe(2);
  });

  it('reports a hook conflict when a JWT caregiver pauses after the hook read', async () => {
    const session = await seed();
    const gate = state.gate = readGate();
    const ending = hookFinish();
    let pausing: Promise<Response> | undefined;
    try {
      await gate.reached(1);
      pausing = change(session.id, 'pause');
      await gate.reached(2);
      gate.release(1);
      expect((await pausing).status).toBe(200);
      const winner = await rows();
      gate.release(0);
      const response = await ending;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'FEED_CONFLICT' } });
      expect(await rows()).toEqual(winner);
    } finally { gate.releaseAll(); await Promise.allSettled([ending, ...(pausing ? [pausing] : [])]); }
  });

  it('binds a frozen stop to its acting caregiver and child without changing normal ending attribution', async () => {
    const session = await seed();
    const before = await rows();
    const body = { leftDuration: 120, rightDuration: 60, expectedUpdatedAt: session.updatedAt.toISOString() };
    for (const expectedScope of [JSON.stringify([familyId, `caretaker:${starter}`, babyId]), JSON.stringify([familyId, `caretaker:${ender}`, 'different-child'])]) {
      expect((await DELETE(request('DELETE', session.id, undefined, { ...body, expectedScope }))).status).toBe(409);
      expect((await PUT(request('PUT', session.id, 'pause', { expectedUpdatedAt: session.updatedAt.toISOString(), expectedScope }))).status).toBe(409);
      expect(await rows()).toEqual(before);
    }
    const expectedScope = JSON.stringify([familyId, `caretaker:${ender}`, babyId]);
    expect((await DELETE(request('DELETE', session.id, undefined, { ...body, expectedScope }))).status).toBe(200);
    expect(await actual.feedLog.findMany()).toMatchObject([{ caretakerId: ender }, { caretakerId: ender }]);
  });

  it('rejects a start replayed with another caregiver after authentication changed', async () => {
    const before = await rows();
    const expectedScope = JSON.stringify([familyId, `caretaker:${starter}`, babyId]);
    expect((await POST(request('POST', '', undefined, { babyId, side: 'LEFT', expectedScope }))).status).toBe(409);
    expect(await rows()).toEqual(before);
  });

  it('rejects a new session for a removed child without creating timer or care rows', async () => {
    await actual.baby.update({ where: { id: babyId }, data: { deletedAt: new Date() } });
    const before = await rows();
    try {
      const response = await POST(request('POST', '', undefined, { babyId, side: 'LEFT' }));
      expect.soft(response.status).toBe(404);
      expect(await rows()).toEqual(before);
    } finally { await actual.baby.update({ where: { id: babyId }, data: { deletedAt: null } }); }
  });

  it('preserves the first-stop pause gap when a paused finalization is retried later', async () => {
    const session = await seed({ isPaused: true, currentSideStartTime: null, pausedAt: new Date(Date.now() - 300_000) });
    const body = { leftDuration: 120, rightDuration: 60, pauseDuration: 45, expectedUpdatedAt: session.updatedAt.toISOString() };
    const before = await rows();
    await actual.$executeRawUnsafe(`CREATE TRIGGER bf_pause_retry BEFORE INSERT ON FeedLog BEGIN SELECT RAISE(ABORT, 'synthetic delayed retry'); END`);
    try {
      expect((await DELETE(request('DELETE', session.id, undefined, body))).status).toBe(500);
      expect(await rows()).toEqual(before);
    } finally { await actual.$executeRawUnsafe('DROP TRIGGER bf_pause_retry'); }
    expect((await DELETE(request('DELETE', session.id, undefined, body))).status).toBe(200);
    const feeds = await actual.feedLog.findMany({ orderBy: { startTime: 'asc' } });
    expect(feeds).toMatchObject([
      { feedDuration: 120, pauseDuration: 45, startTime: session.sessionStartTime },
      { feedDuration: 60, pauseDuration: 45, startTime: new Date(session.sessionStartTime.getTime() + 165_000) },
    ]);
  });

  it.each([false, true])('rejects a future timer origin without deleting or changing it, paused: %s', async isPaused => {
    const session = await seed({ isPaused, ...(isPaused ? { pausedAt: new Date(Date.now() + 60_000), currentSideStartTime: null }
      : { currentSideStartTime: new Date(Date.now() + 60_000) }) });
    const before = await rows();
    expect((await finish(session.id)).status).toBe(400);
    expect((await change(session.id, isPaused ? 'resume' : 'pause')).status).toBe(400);
    const hookResponse = await hookFinish();
    expect(hookResponse.status).toBe(400);
    expect(await hookResponse.json()).toMatchObject({ error: { code: 'INVALID_FEED_SESSION' } });
    expect(await rows()).toEqual(before);
  });
});
