import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';
import { readNurseryUndo, nurseryUndoEndpoint, type NurseryUndo, type NurseryUndoKind } from '@/src/utils/nursery/undo';

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient,
  gate: null as null | { model: string; enter: () => Promise<void> }, separateTransactions: false }));
vi.mock('../app/api/db', () => ({ get default() { return state.db; } }));
vi.mock('../app/api/utils/api-logger', () => ({ logApiCall: vi.fn(async () => {}), getClientInfo: () => ({ ip: '127.0.0.38' }) }));
vi.mock('../src/lib/notifications/activityHook', () => ({ notifyActivityCreated: vi.fn(async () => {}), resetTimerNotificationState: vi.fn(async () => {}) }));
import { POST as login } from '../app/api/auth/route';
import { POST as postDiaper, PUT as putDiaper, DELETE as deleteDiaper } from '../app/api/diaper-log/route';
import { POST as postFood, PUT as putFood, DELETE as deleteFood } from '../app/api/food-log/route';
import { PUT as putFeed, DELETE as deleteFeed } from '../app/api/feed-log/route';
import { POST as postPump, PUT as putPump, DELETE as deletePump } from '../app/api/pump-log/route';
import { POST as postBottle } from '../app/api/bottle-journal/route';
import { POST as startBreast, DELETE as finishBreast } from '../app/api/active-breastfeed/route';

const familyId = 'undo-family', babyId = 'undo-child', sibling = 'undo-sibling', foreign = 'undo-foreign';
const actor = 'undo-caregiver', peer = 'undo-peer', at = '2026-10-20T12:00:00.000Z';
const scope = (child = babyId, id = actor, family = familyId) => JSON.stringify([family, `caretaker:${id}`, child]);
const kinds = ['diaper', 'food', 'bottle', 'breast', 'pump'] as const;
let db: PrismaClient, parallelDb: PrismaClient, directory: string, secret: string, previousSecret: string | undefined;
let previousMode: string | undefined, tokens: Record<string, string>, txNumber = 0;
const request = (method: string, endpoint: string, body?: unknown, token = tokens[actor]) => new NextRequest(`http://localhost${endpoint}`, {
  method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const route = (kind: NurseryUndoKind) => kind === 'diaper' ? deleteDiaper : kind === 'food' ? deleteFood : kind === 'pump' ? deletePump : deleteFeed;
const remove = (undo: NurseryUndo, token = tokens[actor], body: unknown = { nurseryUndo: undo }) => route(undo.kind)(request('DELETE', nurseryUndoEndpoint(undo), body, token));
const snapshot = async () => ({ diapers: await db.diaperLog.findMany({ orderBy: { id: 'asc' } }),
  food: await db.foodLog.findMany({ orderBy: { id: 'asc' } }), feeds: await db.feedLog.findMany({ orderBy: { id: 'asc' } }),
  pumps: await db.pumpLog.findMany({ orderBy: { id: 'asc' } }), receipts: await db.externalImportRecord.findMany({ orderBy: { id: 'asc' } }) });

async function create(kind: NurseryUndoKind, singleSide = false) {
  let response: Response, replay: (() => Promise<Response>) | undefined;
  if (kind === 'diaper') response = await postDiaper(request('POST', '/api/diaper-log', { babyId, time: at, type: 'WET', nurseryScope: scope() }));
  else if (kind === 'food') response = await postFood(request('POST', '/api/food-log', { babyId, foodId: 'undo-food', time: at, nurseryScope: scope() }));
  else if (kind === 'bottle') {
    const body = { babyId, requestId: randomUUID(), expectedScope: scope(), bottle: { time: at, amount: 100, unitAbbr: 'ML', bottleType: 'Breast Milk' } };
    replay = () => postBottle(request('POST', '/api/bottle-journal', body)); response = await replay();
  } else if (kind === 'pump') {
    const body = { babyId, requestId: randomUUID(), expectedScope: scope(), startTime: at, endTime: '2026-10-20T12:10:00.000Z',
      duration: 10, leftAmount: 45, rightAmount: 55, unitAbbr: 'ML', pumpAction: singleSide ? 'STORED' : 'FED' };
    replay = () => postPump(request('POST', '/api/pump-log', body)); response = await replay();
  } else {
    const start = await startBreast(request('POST', '/api/active-breastfeed', { babyId, side: 'LEFT', startTime: at, expectedScope: scope() }));
    expect(start.status).toBe(200); const session = (await start.json()).data;
    response = await finishBreast(request('DELETE', `/api/active-breastfeed?id=${session.id}`, {
      expectedScope: scope(), expectedUpdatedAt: session.updatedAt, leftDuration: 60, rightDuration: singleSide ? 0 : 90, pauseDuration: 30,
    }));
  }
  expect(response.status).toBe(200); const body = await response.json();
  const undo = readNurseryUndo(kind === 'bottle' ? body.data.undo : body.undo);
  expect(undo).not.toBeNull(); expect(undo?.kind).toBe(kind); expect(undo?.scope).toBe(scope());
  return { undo: undo!, body, replay };
}

async function correct(undo: NurseryUndo) {
  const id = undo.records[0].id;
  const response = undo.kind === 'diaper'
    ? await putDiaper(request('PUT', `/api/diaper-log?id=${id}`, { type: 'BOTH', notes: 'Peer verified correction' }, tokens[peer]))
    : undo.kind === 'food'
      ? await putFood(request('PUT', `/api/food-log?id=${id}`, { notes: 'Peer verified correction', enjoyment: 'LIKED' }, tokens[peer]))
      : undo.kind === 'pump'
        ? await putPump(request('PUT', `/api/pump-log?id=${id}`, { notes: 'Peer verified correction', totalAmount: 110 }, tokens[peer]))
        : await putFeed(request('PUT', `/api/feed-log?id=${id}`, { notes: 'Peer verified correction', ...(undo.kind === 'bottle' ? { amount: 80, bottleType: 'Breast Milk' } : {}) }, tokens[peer]));
  expect(response.status).toBe(200);
}

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-nursery-conditional-undo-'));
  const url = 'file:' + path.join(directory, 'synthetic.db');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
  });
  previousSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = secret = randomBytes(32).toString('hex');
  previousMode = process.env.DEPLOYMENT_MODE; process.env.DEPLOYMENT_MODE = 'selfhosted';
  db = new PrismaClient({ adapter: createPrismaAdapter(url) }); parallelDb = new PrismaClient({ adapter: createPrismaAdapter(url) });
  const models = new Map<string, object>();
  for (const name of ['diaperLog', 'foodLog', 'feedLog', 'pumpLog'] as const) {
    const model = db[name];
    models.set(name, new Proxy(model, { get(target, property) {
      const member = Reflect.get(target, property);
      if (property === 'findFirst' || property === 'findMany') return async (...args: unknown[]) => {
        const result = await Reflect.apply(member, target, args);
        if (state.gate?.model === name) { const gate = state.gate; state.gate = null; await gate.enter(); }
        return result;
      };
      return typeof member === 'function' ? member.bind(target) : member;
    } }));
  }
  state.db = new Proxy(db, { get(target, property) {
    if (models.has(String(property))) return models.get(String(property));
    if (property === '$transaction') return (...args: unknown[]) => {
      const client = state.separateTransactions && ++txNumber % 2 === 0 ? parallelDb : db;
      return Reflect.apply(client.$transaction, client, args);
    };
    const member = Reflect.get(target, property); return typeof member === 'function' ? member.bind(target) : member;
  } });
  await db.family.createMany({ data: [familyId, foreign].map(id => ({ id, slug: id, name: 'Synthetic Undo Family', setupStage: 3 })) });
  await db.baby.createMany({ data: [babyId, sibling, foreign].map(id => ({ id, familyId: id === foreign ? foreign : familyId,
    firstName: 'Synthetic', lastName: 'Undo', birthDate: new Date('2026-01-01Z') })) });
  await db.caretaker.createMany({ data: [actor, peer, foreign].map((id, index) => ({ id, familyId: id === foreign ? foreign : familyId,
    name: 'Synthetic Ordinary Caregiver', loginId: `u${index}`, securityPin: '830271', role: 'USER', type: 'Parent' })) });
  await db.settings.createMany({ data: [familyId, foreign].map(id => ({ familyId: id, authType: 'CARETAKER', enableBreastMilkTracking: true })) });
  await db.unit.createMany({ data: ['ML', 'OZ'].map(unitAbbr => ({ unitAbbr, unitName: unitAbbr })) });
  await db.food.create({ data: { id: 'undo-food', familyId, name: 'Synthetic Banana' } });
  tokens = {};
  for (const [index, id] of [actor, peer, foreign].entries()) {
    const response = await login(request('POST', '/api/auth', { loginId: `u${index}`, securityPin: '830271', familySlug: id === foreign ? foreign : familyId }, ''));
    expect(response.status).toBe(200); const body = await response.json();
    expect(body.data.role).toBe('USER'); expect(jwt.verify(body.data.token, secret)).toMatchObject({ id }); tokens[id] = body.data.token;
  }
}, 90_000);

beforeEach(async () => {
  state.gate = null; state.separateTransactions = false; txNumber = 0;
  await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS undo_fail_delete');
  await db.activeBreastFeed.deleteMany(); await db.feedLog.deleteMany(); await db.pumpLog.deleteMany();
  await db.diaperLog.deleteMany(); await db.foodLog.deleteMany(); await db.externalImportRecord.deleteMany();
  await db.baby.updateMany({ data: { deletedAt: null } });
});
afterAll(async () => {
  await Promise.all([db?.$disconnect(), parallelDb?.$disconnect()]);
  if (directory) rmSync(directory, { recursive: true, force: true });
  if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
  if (previousMode === undefined) delete process.env.DEPLOYMENT_MODE; else process.env.DEPLOYMENT_MODE = previousMode;
});

describe('conditional Nursery Undo through real login/JWT and migrated SQLite', () => {
  it.each(kinds)('undoes the exact original %s action and keeps durable create receipts', async kind => {
    const { undo } = await create(kind), receipts = await db.externalImportRecord.findMany();
    expect((await remove(undo)).status).toBe(200);
    const after = await snapshot(); expect(after.diapers).toHaveLength(0); expect(after.feeds).toHaveLength(0); expect(after.pumps).toHaveLength(0);
    expect(after.food.length).toBe(kind === 'food' ? 1 : 0); if (kind === 'food') expect(after.food[0].deletedAt).not.toBeNull();
    expect(await db.externalImportRecord.findMany()).toEqual(receipts);
    expect([404, 409]).toContain((await remove(undo)).status); // Missing is never a successful Undo receipt.
  });

  it.each(kinds)('preserves a peer correction to %s', async kind => {
    const { undo } = await create(kind); await correct(undo); const winner = await snapshot();
    expect((await remove(undo)).status).toBe(409); expect(await snapshot()).toEqual(winner);
  });

  it.each(kinds)('claims every scalar when a %s correction commits after its snapshot read', async kind => {
    const { undo } = await create(kind);
    let release!: () => void, arrived!: () => void;
    const reached = new Promise<void>(resolve => { arrived = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
    const model = kind === 'bottle' || kind === 'breast' ? 'feedLog' : `${kind}Log`;
    state.gate = { model, enter: async () => { arrived(); await blocked; } };
    const pending = remove(undo);
    try {
      await reached; await correct(undo); const winner = await snapshot(); release();
      expect((await pending).status).toBe(409); expect(await snapshot()).toEqual(winner);
    } finally { release(); await pending; }
  });

  it.each(kinds)('rejects actor, family, child, anonymous and expired-scope %s Undo without writes', async kind => {
    const { undo } = await create(kind), before = await snapshot();
    expect((await remove(undo, tokens[peer])).status).toBe(409);
    expect((await remove(undo, tokens[foreign])).status).toBe(409);
    expect((await remove(undo, '')).status).toBe(401);
    const expired = jwt.sign({ id: actor, familyId, role: 'USER', type: 'Parent' }, secret, { expiresIn: -1 });
    expect((await remove(undo, expired)).status).toBe(401);
    expect([404, 409]).toContain((await remove({ ...undo, babyId: sibling, scope: scope(sibling) })).status);
    expect(await snapshot()).toEqual(before);
  });

  it.each(kinds)('rolls back a %s claim when its original child was removed', async kind => {
    const { undo } = await create(kind); await db.baby.update({ where: { id: babyId }, data: { deletedAt: new Date() } });
    const before = await snapshot(); expect((await remove(undo)).status).toBe(404); expect(await snapshot()).toEqual(before);
  });

  it.each(kinds)('keeps bodyless manual %s deletion compatible', async kind => {
    const { undo } = await create(kind); await correct(undo);
    expect((await route(kind)(request('DELETE', nurseryUndoEndpoint(undo)))).status).toBe(200);
  });

  it.each([null, [], {}, { nurseryUndo: null }, { nurseryUndo: {} }])('rejects a malformed nonempty Undo body without falling back to manual deletion: %j', async body => {
    const { undo } = await create('diaper'), before = await snapshot();
    expect((await remove(undo, tokens[actor], body)).status).toBe(400); expect(await snapshot()).toEqual(before);
  });

  it('rejects extra fields, route mismatches, and ID substitution without a write', async () => {
    const { undo } = await create('diaper'), before = await snapshot();
    expect((await remove(undo, tokens[actor], { nurseryUndo: undo, unsafe: true })).status).toBe(400);
    expect((await deleteFood(request('DELETE', nurseryUndoEndpoint(undo), { nurseryUndo: undo }))).status).toBe(400);
    expect((await deleteDiaper(request('DELETE', '/api/diaper-log?id=another-record', { nurseryUndo: undo }))).status).toBe(400);
    expect(await snapshot()).toEqual(before);
  });

  it.each(['diaper', 'food'] as const)('rejects a %s create under a different actor scope before writing', async kind => {
    const body = { babyId, time: at, nurseryScope: scope(babyId, peer), ...(kind === 'diaper' ? { type: 'WET' } : { foodId: 'undo-food' }) };
    const response = await (kind === 'diaper' ? postDiaper : postFood)(request('POST', `/api/${kind}-log`, body));
    expect(response.status).toBe(409); expect((await snapshot()).diapers).toHaveLength(0); expect((await snapshot()).food).toHaveLength(0);
  });

  it('detects a same-millisecond field correction rather than relying on updatedAt alone', async () => {
    const { undo } = await create('diaper'), original = await db.diaperLog.findFirstOrThrow();
    await db.diaperLog.update({ where: { id: original.id }, data: { type: 'BOTH', notes: 'Changed at the same timestamp', updatedAt: original.updatedAt } });
    const winner = await snapshot(); expect((await remove(undo)).status).toBe(409); expect(await snapshot()).toEqual(winner);
  });

  it.each(['edited', 'removed', 'extra', 'moved'] as const)('keeps all remaining breast sides when group membership is %s', async change => {
    const { undo } = await create('breast'), row = await db.feedLog.findUniqueOrThrow({ where: { id: undo.records[1].id } });
    if (change === 'edited') await db.feedLog.update({ where: { id: row.id }, data: { feedDuration: 120, updatedAt: row.updatedAt } });
    else if (change === 'removed') await db.feedLog.delete({ where: { id: row.id } });
    else if (change === 'moved') await db.feedLog.update({ where: { id: row.id }, data: { babyId: sibling } });
    else await db.feedLog.create({ data: { familyId, babyId, caretakerId: actor, time: new Date(at), type: 'BREAST', side: 'LEFT', sessionId: undo.sessionId } });
    const winner = await snapshot(); expect((await remove(undo)).status).toBe(409); expect(await snapshot()).toEqual(winner);
  });

  it('undoes a one-side breast session without inventing a second side', async () => {
    const { undo } = await create('breast', true); expect(undo.records).toHaveLength(1);
    expect((await remove(undo)).status).toBe(200); expect(await db.feedLog.count()).toBe(0);
  });

  it.each(['changed', 'missing', 'unlinked', 'foreign'] as const)('preserves a pump when its original feeding record is %s', async change => {
    const { undo } = await create('pump'), feed = await db.feedLog.findUniqueOrThrow({ where: { id: undo.feed!.id } });
    if (change === 'changed') await db.feedLog.update({ where: { id: feed.id }, data: { amount: 80, notes: 'Peer observed 80 mL', updatedAt: feed.updatedAt } });
    else if (change === 'missing') await db.feedLog.delete({ where: { id: feed.id } });
    else if (change === 'unlinked') await db.feedLog.update({ where: { id: feed.id }, data: { sourcePumpId: null } });
    else await db.feedLog.update({ where: { id: feed.id }, data: { familyId: foreign, babyId: foreign } });
    const winner = await snapshot(); expect((await remove(undo)).status).toBe(409); expect(await snapshot()).toEqual(winner);
  });

  it('claims the original absence of a pump feeding record', async () => {
    const { undo } = await create('pump', true); expect(undo.feed).toBeNull();
    await db.feedLog.create({ data: { familyId, babyId, caretakerId: actor, time: new Date(at), type: 'BOTTLE', amount: 100,
      bottleType: 'Breast Milk', unitAbbr: 'ML', sourcePumpId: undo.records[0].id } });
    const before = await snapshot(); expect((await remove(undo)).status).toBe(409); expect(await snapshot()).toEqual(before);
  });

  it.each(['breast', 'pump'] as const)('rolls back the entire %s Undo when its second deletion fails', async kind => {
    const { undo } = await create(kind), before = await snapshot();
    const id = kind === 'pump' ? undo.feed!.id : undo.records[1].id;
    expect(id).toMatch(/^[a-f\d-]+$/);
    await db.$executeRawUnsafe(`CREATE TRIGGER undo_fail_delete BEFORE DELETE ON FeedLog WHEN OLD.id = '${id}' BEGIN SELECT RAISE(ABORT, 'synthetic second deletion failure'); END`);
    try { expect((await remove(undo)).status).toBe(500); expect(await snapshot()).toEqual(before); }
    finally { await db.$executeRawUnsafe('DROP TRIGGER undo_fail_delete'); }
    expect((await remove(undo)).status).toBe(200);
  });

  it.each(['bottle', 'pump'] as const)('confirms a create replay without inventing a fresh %s Undo baseline', async kind => {
    const saved = await create(kind), before = await snapshot();
    const replay = await saved.replay!(); expect(replay.status).toBe(200); const body = await replay.json();
    expect(body.undo).toBeUndefined(); expect(body.data.undo).toBeUndefined(); expect(await snapshot()).toEqual(before);
    expect((await remove(saved.undo)).status).toBe(200); expect((await saved.replay!()).status).toBe(409);
  });

  it('advances food Undo only through its own conditional enjoyment change', async () => {
    const { undo } = await create('food');
    const response = await putFood(request('PUT', nurseryUndoEndpoint(undo), { nurseryUndo: undo, enjoyment: 'LOVED' }));
    expect(response.status).toBe(200); const updated = (await response.json()).undo as NurseryUndo;
    expect(updated.records[0].revision).not.toBe(undo.records[0].revision);
    expect((await remove(undo)).status).toBe(409); expect((await remove(updated)).status).toBe(200);
  });

  it('does not adopt a peer food correction as the enjoyment action Undo baseline', async () => {
    const { undo } = await create('food'); await correct(undo); const winner = await snapshot();
    const response = await putFood(request('PUT', nurseryUndoEndpoint(undo), { nurseryUndo: undo, enjoyment: 'LOVED' }));
    expect(response.status).toBe(409); expect((await response.json()).undo).toBeUndefined(); expect(await snapshot()).toEqual(winner);
  });

  it.each(['pump', 'food'] as const)('arbitrates %s Undo versus a correction on separate connections and leaves the database usable', async kind => {
    const { undo } = await create(kind), before = await snapshot(); state.separateTransactions = true;
    const correction = kind === 'pump'
      ? () => putPump(request('PUT', nurseryUndoEndpoint(undo), { notes: 'Concurrent peer correction' }, tokens[peer]))
      : () => putFood(request('PUT', nurseryUndoEndpoint(undo), { nurseryUndo: undo, enjoyment: 'LOVED' }));
    const [undone, edited] = await Promise.all([remove(undo), correction()]);
    expect([200, 404, 409]).toContain(undone.status);
    expect([200, 404, 409]).toContain(edited.status);
    expect([undone, edited].filter(result => result.status === 200).length).toBeLessThanOrEqual(1);
    const after = await snapshot();
    if (undone.status === 200) {
      if (kind === 'pump') { expect(after.pumps).toHaveLength(0); expect(after.feeds).toHaveLength(0); }
      else expect(after.food[0].deletedAt).not.toBeNull();
    } else if (edited.status === 200) {
      if (kind === 'pump') expect(after.pumps[0].notes).toBe('Concurrent peer correction');
      else expect(after.food[0]).toMatchObject({ enjoyment: 'LOVED', deletedAt: null });
    } else {
      expect(after).toEqual(before);
      state.separateTransactions = false;
      expect((await remove(undo)).status).toBe(200);
    }
    expect(await parallelDb.baby.count({ where: { familyId } })).toBe(2);
    // A poisoned SQLite adapter can still read while its next BEGIN fails.
    // Exercise a fresh committed transaction on both independent adapters,
    // regardless of which adapter won the contested care transaction.
    for (const [writer, reader] of [[parallelDb, db], [db, parallelDb]]) {
      const later = await writer.$transaction(tx => tx.diaperLog.create({
        data: { familyId, babyId, caretakerId: peer, time: new Date(at), type: 'DRY' },
      }), { timeout: 15_000 });
      expect(await reader.diaperLog.findUnique({ where: { id: later.id } })).toMatchObject({ type: 'DRY' });
    }
  }, 25_000);
});
