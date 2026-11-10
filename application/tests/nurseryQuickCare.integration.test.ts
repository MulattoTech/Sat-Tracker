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
import { readNurseryUndo } from '@/src/utils/nursery/undo';

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient, separate: false,
  barrier: null as null | (() => Promise<void>), notify: vi.fn(async () => {}), reset: vi.fn(async () => {}) }));
vi.mock('../app/api/db', () => ({ get default() { return state.db; } }));
vi.mock('../app/api/utils/api-logger', () => ({ logApiCall: vi.fn(async () => {}), getClientInfo: () => ({ ip: '127.0.0.46' }) }));
vi.mock('../src/lib/notifications/activityHook', () => ({ notifyActivityCreated: state.notify, resetTimerNotificationState: state.reset }));
import { POST as login } from '../app/api/auth/route';
import { POST as postDiaper, PUT as putDiaper, DELETE as deleteDiaper } from '../app/api/diaper-log/route';
import { POST as postFood, PUT as putFood, DELETE as deleteFood } from '../app/api/food-log/route';

type Kind = 'diaper' | 'food';
const kinds = ['diaper', 'food'] as const;
const familyId = 'quick-family', babyId = 'quick-child', sibling = 'quick-sibling', foreign = 'quick-foreign';
const actor = 'quick-caregiver', peer = 'quick-peer', foodId = 'quick-food', at = '2026-10-20T12:00:00.000Z';
const scope = (child = babyId, caregiver = actor, family = familyId) => JSON.stringify([family, `caretaker:${caregiver}`, child]);
let db: PrismaClient, parallelDb: PrismaClient, directory: string, secret: string;
let previousSecret: string | undefined, previousMode: string | undefined, txNumber = 0;
const tokens: Record<string, string> = {};
const request = (method: string, kind: Kind | 'auth', body?: unknown, token = tokens[actor], id?: string) => new NextRequest(
  `http://localhost/api/${kind === 'auth' ? 'auth' : kind + '-log'}${id ? '?id=' + encodeURIComponent(id) : ''}`, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const body = (kind: Kind, extra: Record<string, unknown> = {}) => ({ babyId, time: at,
  ...(kind === 'diaper' ? { type: 'WET' } : { foodId }), nurseryScope: scope(), requestId: randomUUID(), ...extra });
const post = (kind: Kind, payload: unknown, token = tokens[actor]) => (kind === 'diaper' ? postDiaper : postFood)(request('POST', kind, payload, token));
const put = (kind: Kind, id: string, payload: unknown, token = tokens[peer]) => (kind === 'diaper' ? putDiaper : putFood)(request('PUT', kind, payload, token, id));
const remove = (kind: Kind, id: string, payload?: unknown) => (kind === 'diaper' ? deleteDiaper : deleteFood)(request('DELETE', kind, payload, tokens[actor], id));
const rows = async () => ({ diapers: await db.diaperLog.findMany({ orderBy: { id: 'asc' } }),
  food: await db.foodLog.findMany({ orderBy: { id: 'asc' } }), receipts: await db.externalImportRecord.findMany({ orderBy: { id: 'asc' } }) });

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-nursery-quick-care-'));
  const url = 'file:' + path.join(directory, 'synthetic.db');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
  });
  previousSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = secret = randomBytes(32).toString('hex');
  previousMode = process.env.DEPLOYMENT_MODE; process.env.DEPLOYMENT_MODE = 'selfhosted';
  db = new PrismaClient({ adapter: createPrismaAdapter(url) }); parallelDb = new PrismaClient({ adapter: createPrismaAdapter(url) });
  state.db = new Proxy(db, { get(target, property) {
    if (property === '$transaction') return (callback: (tx: object) => Promise<unknown>, options: unknown) => {
      const client = state.separate && ++txNumber % 2 === 0 ? parallelDb : db;
      return client.$transaction(async tx => {
        const instrumented = new Proxy(tx, { get(inner, key) {
          const member = Reflect.get(inner, key);
          if (key === 'diaperLog' || key === 'foodLog') return new Proxy(member, { get(model, operation) {
            const method = Reflect.get(model, operation);
            if (operation === 'create') return async (...args: unknown[]) => { await state.barrier?.(); return Reflect.apply(method, model, args); };
            return typeof method === 'function' ? method.bind(model) : method;
          } });
          return typeof member === 'function' ? member.bind(inner) : member;
        } });
        return callback(instrumented);
      }, options as Parameters<PrismaClient['$transaction']>[1]);
    };
    const member = Reflect.get(target, property); return typeof member === 'function' ? member.bind(target) : member;
  } });
  await db.family.createMany({ data: [familyId, foreign].map(id => ({ id, slug: id, name: 'Synthetic Quick Care Family', setupStage: 3 })) });
  await db.baby.createMany({ data: [babyId, sibling, foreign].map(id => ({ id, familyId: id === foreign ? foreign : familyId,
    firstName: 'Synthetic', lastName: 'QuickCare', birthDate: new Date('2026-01-01Z') })) });
  await db.caretaker.createMany({ data: [actor, peer, foreign].map((id, index) => ({ id, familyId: id === foreign ? foreign : familyId,
    name: 'Synthetic Ordinary Caregiver', loginId: `q${index}`, securityPin: '830271', role: 'USER', type: 'Parent' })) });
  await db.settings.createMany({ data: [familyId, foreign].map(id => ({ familyId: id, authType: 'CARETAKER' })) });
  await db.food.createMany({ data: [foodId, 'quick-other-food', 'quick-foreign-food'].map(id => ({ id,
    familyId: id === 'quick-foreign-food' ? foreign : familyId, name: 'Synthetic Oatmeal' })) });
  for (const [index, id] of [actor, peer, foreign].entries()) {
    const response = await login(request('POST', 'auth', { loginId: `q${index}`, securityPin: '830271', familySlug: id === foreign ? foreign : familyId }, ''));
    expect(response.status).toBe(200); const value = await response.json();
    expect(value.data.role).toBe('USER'); expect(jwt.verify(value.data.token, secret)).toMatchObject({ id }); tokens[id] = value.data.token;
  }
}, 90_000);
beforeEach(async () => {
  state.separate = false; state.barrier = null; txNumber = 0;
  await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS quick_fail_receipt');
  await db.diaperLog.deleteMany(); await db.foodLog.deleteMany(); await db.externalImportRecord.deleteMany();
  await db.baby.updateMany({ data: { deletedAt: null } }); await db.food.updateMany({ data: { deletedAt: null } });
  state.notify.mockClear(); state.reset.mockClear();
});
afterAll(async () => {
  await Promise.all([db?.$disconnect(), parallelDb?.$disconnect()]);
  if (directory) rmSync(directory, { recursive: true, force: true });
  if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
  if (previousMode === undefined) delete process.env.DEPLOYMENT_MODE; else process.env.DEPLOYMENT_MODE = previousMode;
});

describe('Nursery quick diaper and food recovery through real ordinary-caregiver login and migrated SQLite', () => {
  it.each(kinds)('confirms one original %s save and the same original Undo on exact replay', async kind => {
    const payload = body(kind); const first = await post(kind, payload); expect(first.status).toBe(200);
    const saved = await first.json(), before = await rows(); expect(readNurseryUndo(saved.undo)?.kind).toBe(kind);
    const replay = await post(kind, payload); expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...saved, replayed: true }); expect(saved.replayed).toBe(false);
    expect(await rows()).toEqual(before); expect(before.receipts).toHaveLength(1);
    expect(saved.data.time).toBe(at); expect(saved.data.caretakerId).toBe(actor);
    expect(state.notify).toHaveBeenCalledTimes(kind === 'diaper' ? 1 : 0);
    expect(state.reset).toHaveBeenCalledTimes(kind === 'diaper' ? 1 : 0);
  });

  it.each(kinds)('keeps deliberate distinct %s UUID actions distinct even with identical content/time', async kind => {
    expect((await post(kind, body(kind))).status).toBe(200); expect((await post(kind, body(kind))).status).toBe(200);
    const saved = await rows(); expect(saved[kind === 'diaper' ? 'diapers' : 'food']).toHaveLength(2); expect(saved.receipts).toHaveLength(2);
  });

  it.each(kinds)('preserves legacy manual and scope-only %s create semantics', async kind => {
    const payload = body(kind) as Record<string, unknown>; delete payload.requestId; delete payload.nurseryScope;
    const first = await post(kind, payload); expect(first.status).toBe(200); expect((await first.json()).undo).toBeUndefined();
    expect((await post(kind, payload)).status).toBe(200);
    const scoped = await post(kind, { ...payload, nurseryScope: scope() }); expect(scoped.status).toBe(200);
    expect(readNurseryUndo((await scoped.json()).undo)?.kind).toBe(kind);
    const saved = await rows(); expect(saved[kind === 'diaper' ? 'diapers' : 'food']).toHaveLength(3); expect(saved.receipts).toHaveLength(0);
  });

  it.each(kinds)('rejects changed %s request payload, actor or child without a write or fresh Undo', async kind => {
    const payload = body(kind); expect((await post(kind, payload)).status).toBe(200); const before = await rows();
    const variants = [
      [{ ...payload, time: '2026-10-20T12:02:00.000Z' }, tokens[actor]],
      [{ ...payload, ...(kind === 'diaper' ? { type: 'BOTH' } : { foodId: 'quick-other-food' }) }, tokens[actor]],
      [{ ...payload, babyId: sibling, nurseryScope: scope(sibling) }, tokens[actor]],
      [{ ...payload, nurseryScope: scope(babyId, peer) }, tokens[peer]],
    ] as const;
    for (const [changed, token] of variants) {
      const response = await post(kind, changed, token); expect(response.status).toBe(409);
      expect((await response.json()).undo).toBeUndefined(); expect(await rows()).toEqual(before);
    }
  });

  for (const kind of kinds) it.each(['hard deletion', 'soft deletion', 'move', 'correction', 'same-timestamp correction', 'timestamp-only revision'])
    (`does not resurrect or mint a new ${kind} Undo after %s`, async change => {
      const payload = body(kind), first = await post(kind, payload); expect(first.status).toBe(200);
      const saved = (await first.json()).data;
      if (kind === 'diaper') {
        if (change === 'hard deletion') await db.diaperLog.delete({ where: { id: saved.id } });
        else await db.diaperLog.update({ where: { id: saved.id }, data: change === 'soft deletion' ? { deletedAt: new Date() }
          : change === 'move' ? { babyId: sibling } : change === 'timestamp-only revision' ? { updatedAt: new Date(Date.parse(saved.updatedAt) + 1) }
          : { notes: 'Peer correction', ...(change === 'same-timestamp correction' ? { updatedAt: new Date(saved.updatedAt) } : {}) } });
      } else {
        if (change === 'hard deletion') await db.foodLog.delete({ where: { id: saved.id } });
        else await db.foodLog.update({ where: { id: saved.id }, data: change === 'soft deletion' ? { deletedAt: new Date() }
          : change === 'move' ? { babyId: sibling } : change === 'timestamp-only revision' ? { updatedAt: new Date(Date.parse(saved.updatedAt) + 1) }
          : { enjoyment: 'LOVED', ...(change === 'same-timestamp correction' ? { updatedAt: new Date(saved.updatedAt) } : {}) } });
      }
      const before = await rows(), replay = await post(kind, payload); expect(replay.status).toBe(409);
      expect((await replay.json()).undo).toBeUndefined(); expect(await rows()).toEqual(before); expect(before.receipts).toHaveLength(1);
    });

  it.each(kinds)('keeps the original %s descriptor conditional after a successful recovery', async kind => {
    const payload = body(kind); expect((await post(kind, payload)).status).toBe(200);
    const replay = await post(kind, payload); expect(replay.status).toBe(200); const saved = await replay.json();
    expect((await put(kind, saved.data.id, { notes: 'Peer observed correction' })).status).toBe(200);
    const before = await rows(); expect((await remove(kind, saved.data.id, { nurseryUndo: saved.undo })).status).toBe(409);
    expect(await rows()).toEqual(before);
  });

  it('supports the recovered food enjoyment action while rejecting a later create replay', async () => {
    const payload = body('food'); expect((await post('food', payload)).status).toBe(200);
    const saved = await (await post('food', payload)).json();
    const enjoyed = await put('food', saved.data.id, { enjoyment: 'LOVED', nurseryUndo: saved.undo }, tokens[actor]);
    expect(enjoyed.status).toBe(200); const updated = await enjoyed.json();
    expect(updated.undo.records[0].revision).not.toBe(saved.undo.records[0].revision);
    const before = await rows(); const replay = await post('food', payload); expect(replay.status).toBe(409);
    expect((await replay.json()).undo).toBeUndefined(); expect(await rows()).toEqual(before);
    expect((await remove('food', saved.data.id, { nurseryUndo: updated.undo })).status).toBe(200);
  });

  it.each(kinds)('retains the %s receipt after conditional Undo and never recreates the removed record', async kind => {
    const payload = body(kind), saved = await (await post(kind, payload)).json();
    expect((await remove(kind, saved.data.id, { nurseryUndo: saved.undo })).status).toBe(200);
    const before = await rows(); expect((await post(kind, payload)).status).toBe(409); expect(await rows()).toEqual(before);
    expect(before.receipts).toHaveLength(1);
  });

  for (const kind of kinds) it.each([null, '', 'not-a-uuid', 1, [], {}])(`rejects invalid ${kind} request identity %j`, async requestId => {
    const before = await rows(); expect((await post(kind, body(kind, { requestId }))).status).toBe(400); expect(await rows()).toEqual(before);
  });

  it.each([['WET'], {}, null, true, 1, 'UNKNOWN'])('rejects malformed quick diaper type %j without writes', async type => {
    const before = await rows(); expect((await post('diaper', body('diaper', { type }))).status).toBe(400); expect(await rows()).toEqual(before);
  });

  it.each(kinds)('strictly separates %s recovery metadata from care scalars and rejects missing scope', async kind => {
    for (const extra of [{ nurseryScope: null }, { notes: 'extra quick field' }, { familyId: foreign }, { id: 'chosen-id' },
      { time: '2026-10-20' }, { time: ['2026-10-20T12:00:00.000Z'] }, { baby: { connect: { id: foreign } } }]) {
      const before = await rows(); const response = await post(kind, body(kind, extra));
      expect([400, 409]).toContain(response.status); expect(await rows()).toEqual(before);
    }
    const payload = body(kind) as Record<string, unknown>; delete payload.nurseryScope;
    expect((await post(kind, payload)).status).toBe(400);
  });

  it.each(kinds)('rejects anonymous, expired, mismatched and foreign-family %s requests without writes', async kind => {
    const payload = body(kind), before = await rows();
    expect((await post(kind, payload, '')).status).toBe(401);
    expect((await post(kind, payload, jwt.sign({ id: actor, familyId, role: 'USER', type: 'Parent' }, secret, { expiresIn: -1 }))).status).toBe(401);
    expect((await post(kind, payload, tokens[peer])).status).toBe(409);
    expect((await post(kind, payload, tokens[foreign])).status).toBe(409);
    expect((await post(kind, body(kind, { babyId: foreign, nurseryScope: scope(foreign) }))).status).toBe(404);
    expect(await rows()).toEqual(before);
  });

  it.each(kinds)('refuses a new %s for a removed child and rolls its write back', async kind => {
    await db.baby.update({ where: { id: babyId }, data: { deletedAt: new Date() } }); const before = await rows();
    expect((await post(kind, body(kind))).status).toBe(404); expect(await rows()).toEqual(before);
  });

  it.each(['quick-foreign-food', 'missing-food', foodId])('rejects missing, foreign or removed catalog food %s without a receipt', async selected => {
    if (selected === foodId) await db.food.update({ where: { id: foodId }, data: { deletedAt: new Date() } });
    const before = await rows(); expect((await post('food', body('food', { foodId: selected }))).status).toBe(404); expect(await rows()).toEqual(before);
  });

  it.each(kinds)('rolls back the %s record if durable receipt insertion fails, then permits exact retry', async kind => {
    const payload = body(kind), before = await rows();
    await db.$executeRawUnsafe("CREATE TRIGGER quick_fail_receipt BEFORE INSERT ON ExternalImportRecord BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END");
    try { expect((await post(kind, payload)).status).toBe(500); expect(await rows()).toEqual(before); }
    finally { await db.$executeRawUnsafe('DROP TRIGGER quick_fail_receipt'); }
    expect((await post(kind, payload)).status).toBe(200); expect((await rows()).receipts).toHaveLength(1);
  });

  for (const kind of kinds) it.each(['same', 'distinct'] as const)(`arbitrates ${kind} %s UUIDs on separate connections and leaves both adapters readable/writable`, async identity => {
    state.separate = true; let arrived = 0, release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    state.barrier = async () => { if (++arrived === 2) release(); await ready; };
    const first = body(kind), second = identity === 'same' ? first : body(kind);
    const results = await Promise.all([post(kind, first), post(kind, second)]); state.barrier = null;
    expect(results.every(response => [200, 409].includes(response.status))).toBe(true);
    const saved = await rows(); expect(saved[kind === 'diaper' ? 'diapers' : 'food']).toHaveLength(identity === 'same'
      ? (results.some(response => response.status === 200) ? 1 : 0) : results.filter(response => response.status === 200).length);
    // A failed SQLite commit can leave its adapter able to read but unable to BEGIN.
    // Prove a fresh independent transaction and cross-client read on both adapters.
    for (const [writer, reader] of [[db, parallelDb], [parallelDb, db]]) {
      expect(await reader.baby.count({ where: { familyId } })).toBe(2);
      const control = await writer.$transaction(tx => tx.diaperLog.create({ data: { familyId, babyId, caretakerId: peer,
        time: new Date(at), type: 'DRY' } }), { timeout: 15_000 });
      expect(await reader.diaperLog.findUnique({ where: { id: control.id } })).toMatchObject({ type: 'DRY' });
    }
    expect((await post(kind, first)).status).toBe(200); expect((await post(kind, second)).status).toBe(200);
    expect((await rows()).receipts).toHaveLength(identity === 'same' ? 1 : 2);
  }, 30_000);
});
