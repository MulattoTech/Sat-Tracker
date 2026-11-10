import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { PrismaClient, type SleepLog } from '@prisma/client';
import { NextRequest } from 'next/server';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient, gate: null as ReturnType<typeof readGate> | null,
  separateTransactions: false, notify: vi.fn(async () => {}) }));
vi.mock('../app/api/db', () => ({ get default() { return state.db; } }));
vi.mock('../app/api/utils/api-logger', () => ({ logApiCall: vi.fn(async () => {}), getClientInfo: () => ({}) }));
vi.mock('../src/lib/notifications/activityHook', () => ({ notifyActivityCreated: state.notify, resetTimerNotificationState: vi.fn(async () => {}) }));
import { GET, POST, PUT, DELETE } from '../app/api/sleep-log/route';
import { PUT as hookPut } from '../app/api/hooks/v1/babies/[babyId]/activities/[activityId]/route';
import { PUT as renameLocation } from '../app/api/sleep-locations/route';

const familyId = 'sleep-recovery-family', babyId = 'sleep-recovery-child', siblingId = 'sleep-recovery-sibling';
const actor = 'sleep-recovery-caregiver', peer = 'sleep-recovery-peer', foreign = 'sleep-recovery-foreign';
const startTime = '2026-10-20T12:00:00.000Z', endTime = '2026-10-20T13:00:00.000Z';
let db: PrismaClient, parallelDb: PrismaClient, directory: string, secret: string, previousSecret: string | undefined, hookToken: string;
let txNumber = 0;
const token = (id = actor, family = familyId) => jwt.sign({ id, familyId: family, role: 'USER', type: 'parent' }, secret, { expiresIn: '10m' });
const scope = (child = babyId, id = actor, family = familyId) => JSON.stringify([family, `caretaker:${id}`, child]);
const req = (method: string, query = '', body?: unknown, auth = token()) => new NextRequest(`http://localhost/api/sleep-log${query ? '?' + query : ''}`, {
  method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const startBody = (requestId = randomUUID(), extra: Record<string, unknown> = {}) => ({
  babyId, startTime, type: 'NAP', location: 'Crib', nurseryAction: 'start', requestId, expectedScope: scope(), ...extra,
});
const read = async (id: string) => { const response = await GET(req('GET', 'id=' + id)); expect(response.status).toBe(200); return (await response.json()).data; };
const wake = (row: { id: string; revision: string }, extra: Record<string, unknown> = {}, auth = token()) => PUT(req('PUT', 'id=' + row.id, {
  endTime, nurseryAction: 'wake', expectedRevision: row.revision, expectedScope: scope(), ...extra,
}, auth));
const undo = (row: { id: string; revision: string }, action: 'undo-start' | 'undo-wake', extra: Record<string, unknown> = {}, auth = token()) => {
  const method = action === 'undo-start' ? 'DELETE' : 'PUT';
  return (method === 'DELETE' ? DELETE : PUT)(req(method, 'id=' + row.id, {
    ...(action === 'undo-wake' ? { endTime: null, duration: null } : {}),
    nurseryAction: action, expectedRevision: row.revision, expectedScope: scope(), ...extra,
  }, auth));
};
const seed = (extra: Record<string, unknown> = {}) => db.sleepLog.create({ data: {
  babyId, familyId, caretakerId: actor, startTime: new Date(startTime), type: 'NAP', location: 'Crib', ...extra,
} });
const rows = async () => ({ sleeps: await db.sleepLog.findMany({ orderBy: { id: 'asc' } }), receipts: await db.externalImportRecord.findMany({ orderBy: { id: 'asc' } }) });

function readGate() {
  const releases: (() => void)[] = []; let changed = () => {};
  return {
    enter: () => new Promise<void>(resolve => { releases.push(resolve); changed(); }),
    reached: (count: number) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Expected ${count} reads; saw ${releases.length}`)), 5000);
      changed = () => { if (releases.length >= count) { clearTimeout(timer); resolve(); } }; changed();
    }),
    release: (index: number) => releases[index]?.(), releaseAll: () => releases.forEach(release => release()),
  };
}

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-sleep-recovery-'));
  const url = 'file:' + path.join(directory, 'synthetic.db');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
  });
  previousSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = secret = randomBytes(32).toString('hex');
  db = new PrismaClient({ adapter: createPrismaAdapter(url) });
  parallelDb = new PrismaClient({ adapter: createPrismaAdapter(url) });
  const sleepLog = new Proxy(db.sleepLog, { get(model, property) {
    const member = Reflect.get(model, property);
    if (property === 'findFirst') return async (...args: unknown[]) => {
      const row = await Reflect.apply(member, model, args) as SleepLog | null;
      if (row) await state.gate?.enter(); return row;
    };
    return typeof member === 'function' ? member.bind(model) : member;
  } });
  state.db = new Proxy(db, { get(target, property) {
    if (property === 'sleepLog') return sleepLog;
    if (property === '$transaction') return (...args: unknown[]) => {
      const client = state.separateTransactions && ++txNumber % 2 === 0 ? parallelDb : db;
      return Reflect.apply(client.$transaction, client, args);
    };
    const member = Reflect.get(target, property); return typeof member === 'function' ? member.bind(target) : member;
  } });
  await db.family.createMany({ data: [familyId, foreign].map(id => ({ id, slug: id, name: 'Synthetic Sleep Family' })) });
  await db.baby.createMany({ data: [babyId, siblingId, foreign].map(id => ({ id, familyId: id === foreign ? foreign : familyId,
    firstName: 'Synthetic', lastName: 'Sleep', birthDate: new Date('2026-01-01T00:00:00Z') })) });
  await db.caretaker.createMany({ data: [actor, peer, foreign].map(id => ({ id, familyId: id === foreign ? foreign : familyId,
    name: 'Synthetic ordinary caregiver', role: 'USER', type: 'Parent', loginId: id, securityPin: '830271' })) });
  await db.settings.create({ data: { familyId, familyName: 'Synthetic Sleep Family', authType: 'CARETAKER' } });
  await db.account.create({ data: { id: 'sleep-recovery-account', email: 'sleep@example.invalid', password: 'synthetic-unused-hash', verified: true, familyId, caretakerId: actor } });
  hookToken = 'st_live_synthetic_' + randomUUID();
  await db.apiKey.create({ data: { name: 'Synthetic sleep recovery', familyId, keyPrefix: hookToken.slice(0, 16),
    keyHash: createHash('sha256').update(hookToken).digest('hex'), scopes: JSON.stringify(['read', 'write']) } });
}, 90_000);
beforeEach(async () => {
  state.gate = null; state.separateTransactions = false; txNumber = 0;
  await db.sleepLog.deleteMany(); await db.externalImportRecord.deleteMany();
  await db.baby.updateMany({ data: { deletedAt: null } }); state.notify.mockClear();
});
afterAll(async () => {
  await parallelDb?.$disconnect(); await db?.$disconnect(); if (directory) rmSync(directory, { recursive: true, force: true });
  if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
});

describe('recoverable nursery sleep with real USER JWT and migrated SQLite', () => {
  it('creates one active sleep and exact retries preserve identity, timestamps, receipt and one notification', async () => {
    const body = startBody(); const first = await POST(req('POST', '', body)); expect(first.status).toBe(200);
    const saved = (await first.json()).data; expect(saved.revision).toMatch(/^[a-f\d]{64}$/); expect(saved.caretakerId).toBe(actor);
    const before = await rows(); const repeated = await POST(req('POST', '', body)); expect(repeated.status).toBe(200);
    expect((await repeated.json()).data).toEqual(saved); expect(await rows()).toEqual(before);
    expect(before.sleeps).toHaveLength(1); expect(before.receipts).toHaveLength(1); expect(state.notify).toHaveBeenCalledTimes(1);
    expect((await read(saved.id)).revision).toBe(saved.revision);
  });

  it('rejects changed payload, child, or caregiver for an existing start identity without any write', async () => {
    const body = startBody(); expect((await POST(req('POST', '', body))).status).toBe(200); const before = await rows();
    const attempts = [
      [startBody(body.requestId, { location: 'Contact' }), token()],
      [startBody(body.requestId, { babyId: siblingId, expectedScope: scope(siblingId) }), token()],
      [startBody(body.requestId, { expectedScope: scope(babyId, peer) }), token(peer)],
    ] as const;
    for (const [changed, auth] of attempts) { expect((await POST(req('POST', '', changed, auth))).status).toBe(409); expect(await rows()).toEqual(before); }
  });

  it.each(['hard delete', 'soft delete', 'completion', 'correction'])('does not resurrect or overwrite a saved start after %s', async kind => {
    const body = startBody(); const first = await POST(req('POST', '', body)); const saved = (await first.json()).data;
    if (kind === 'hard delete') expect((await DELETE(req('DELETE', 'id=' + saved.id))).status).toBe(200);
    if (kind === 'soft delete') await db.sleepLog.update({ where: { id: saved.id }, data: { deletedAt: new Date() } });
    if (kind === 'completion') expect((await wake(saved)).status).toBe(200);
    if (kind === 'correction') expect((await PUT(req('PUT', 'id=' + saved.id, { notes: 'Peer verified', location: 'Contact' }, token(peer)))).status).toBe(200);
    const before = await rows(); expect((await POST(req('POST', '', body))).status).toBe(409); expect(await rows()).toEqual(before);
    expect(before.receipts).toHaveLength(1);
  });

  it('keeps legacy manual creates distinct and rejects an explicit nursery start when multiple sleeps are already active', async () => {
    const body = { babyId, startTime, type: 'NAP', endTime: null, duration: null, location: 'Crib', quality: null, notes: null };
    expect((await POST(req('POST', '', body))).status).toBe(200); expect((await POST(req('POST', '', body))).status).toBe(200);
    const before = await rows(); expect(before.sleeps).toHaveLength(2); expect(before.receipts).toHaveLength(0);
    expect((await POST(req('POST', '', startBody()))).status).toBe(409); expect(await rows()).toEqual(before);
  });

  it('arbitrates two distinct concurrent nursery starts across separate SQLite connections', async () => {
    state.separateTransactions = true;
    const results = await Promise.all([POST(req('POST', '', startBody())), POST(req('POST', '', startBody(randomUUID(), { expectedScope: scope(babyId, peer) }), token(peer)))]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const after = await rows(); expect(after.sleeps).toHaveLength(1); expect(after.receipts).toHaveLength(1); expect(state.notify).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('arbitrates a concurrent new Start against Undo-Wake across separate connections', async () => {
    const saved = await read((await seed({ endTime: new Date(endTime), duration: 60 })).id);
    state.separateTransactions = true;
    const body = startBody();
    const results = await Promise.all([POST(req('POST', '', body)), undo(saved, 'undo-wake')]);
    // Serializable engines may abort either contender or both. No retry is
    // performed implicitly; an explicit retry must still leave one active row.
    expect(results.every(result => [200, 409].includes(result.status))).toBe(true);
    const committed = results.filter(result => result.status === 200).length;
    expect(committed).toBeLessThanOrEqual(1);
    expect(await db.sleepLog.count({ where: { babyId, endTime: null, deletedAt: null } })).toBe(committed);
    if (committed === 0) {
      expect(await db.sleepLog.findUnique({ where: { id: saved.id } })).toMatchObject({ endTime: new Date(endTime), duration: 60 });
      expect(await db.externalImportRecord.count()).toBe(0);
      expect((await POST(req('POST', '', body))).status).toBe(200);
      expect((await undo(saved, 'undo-wake')).status).toBe(409);
      expect(await db.sleepLog.count({ where: { babyId, endTime: null, deletedAt: null } })).toBe(1);
    }
  }, 20_000);

  it('account-auth intent uses the account identity and fresh database family, not its linked PIN identity', async () => {
    const accountId = 'sleep-recovery-account';
    const auth = jwt.sign({ accountId, isAccountAuth: true, familyId }, secret, { expiresIn: '10m' });
    const expectedScope = JSON.stringify([familyId, `account:${accountId}`, babyId]);
    const body = startBody(randomUUID(), { expectedScope });
    const response = await POST(req('POST', '', body, auth)); expect(response.status).toBe(200);
    const saved = (await response.json()).data; expect(saved.caretakerId).toBe(actor);
    const before = await rows(); expect((await POST(req('POST', '', body))).status).toBe(409);
    expect((await POST(req('POST', '', { ...body, expectedScope: scope() }, auth))).status).toBe(409);
    expect(await rows()).toEqual(before); expect((await POST(req('POST', '', body, auth))).status).toBe(200);
    await db.account.update({ where: { id: accountId }, data: { familyId: foreign } });
    try { expect((await POST(req('POST', '', body, auth))).status).toBe(409); expect(await rows()).toEqual(before); }
    finally { await db.account.update({ where: { id: accountId }, data: { familyId } }); }
    expect((await wake(saved, { expectedScope }, auth)).status).toBe(200);
  });

  it('arbitrates a manual child move against a correction and leaves both SQLite connections usable', async () => {
    const row = await seed(), gate = readGate(); state.gate = gate; state.separateTransactions = true;
    const moving = PUT(req('PUT', 'id=' + row.id, { babyId: siblingId }));
    const correcting = PUT(req('PUT', 'id=' + row.id, { notes: 'Peer verified this sleep' }, token(peer)));
    try { await gate.reached(2); } finally { state.gate = null; gate.releaseAll(); }
    const results = await Promise.all([moving, correcting]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(await db.sleepLog.count()).toBe(1); expect(await parallelDb.sleepLog.count()).toBe(1);
    const saved = await read(row.id);
    expect([babyId, siblingId]).toContain(saved.babyId);
    expect((await PUT(req('PUT', 'id=' + row.id, { notes: 'Confirmed after contention' }))).status).toBe(200);
    expect((await read(row.id)).notes).toBe('Confirmed after contention');
  }, 20_000);

  it('concurrent requests with the same durable identity create only one sleep and can replay safely', async () => {
    state.separateTransactions = true; const body = startBody();
    const results = await Promise.all([POST(req('POST', '', body)), POST(req('POST', '', body))]);
    expect(results.some(result => result.status === 200)).toBe(true); expect(results.every(result => [200, 409].includes(result.status))).toBe(true);
    const before = await rows(); expect(before.sleeps).toHaveLength(1); expect(before.receipts).toHaveLength(1);
    expect((await POST(req('POST', '', body))).status).toBe(200); expect(await rows()).toEqual(before); expect(state.notify).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('rolls the sleep back when its durable receipt fails, then permits one clean retry', async () => {
    const body = startBody();
    await db.$executeRawUnsafe("CREATE TRIGGER sleep_fail_receipt BEFORE INSERT ON ExternalImportRecord BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END");
    try { expect((await POST(req('POST', '', body))).status).toBe(500); expect(await rows()).toEqual({ sleeps: [], receipts: [] }); expect(state.notify).not.toHaveBeenCalled(); }
    finally { await db.$executeRawUnsafe('DROP TRIGGER sleep_fail_receipt'); }
    expect((await POST(req('POST', '', body))).status).toBe(200); expect((await rows()).sleeps).toHaveLength(1); expect((await rows()).receipts).toHaveLength(1);
  });

  it('a completed wake rejects a stale retry with either its original or a later endpoint', async () => {
    const saved = await read((await seed()).id); const first = await wake(saved); expect(first.status).toBe(200);
    const done = (await first.json()).data; expect(done.duration).toBe(60); expect(done.endTime).toBe(endTime); expect(done.revision).not.toBe(saved.revision);
    expect(done.caretakerId).toBe(actor); const before = await rows();
    expect((await wake(saved)).status).toBe(409);
    expect((await wake(saved, { endTime: '2026-10-20T13:05:00.000Z' })).status).toBe(409); expect(await rows()).toEqual(before);
    expect(state.notify).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale wake after an actual hook correction even when updatedAt has the same millisecond', async () => {
    const initial = await seed(), saved = await read(initial.id);
    const changed = await hookPut(new NextRequest(`http://localhost/api/hooks/v1/babies/${babyId}/activities/${initial.id}?type=sleep`, {
      method: 'PUT', headers: { Authorization: `Bearer ${hookToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'sleep', notes: 'Hook corrected sleep', location: 'Contact' }),
    }), { params: Promise.resolve({ babyId, activityId: initial.id }) });
    expect(changed.status).toBe(200);
    await db.sleepLog.update({ where: { id: initial.id }, data: { updatedAt: initial.updatedAt } });
    const current = await read(initial.id); expect(current.updatedAt).toBe(saved.updatedAt); expect(current.revision).not.toBe(saved.revision);
    const before = await rows(); expect((await wake(saved)).status).toBe(409); expect(await rows()).toEqual(before);
  });

  it('actual bulk location rename invalidates the displayed sleep revision', async () => {
    const saved = await read((await seed({ location: 'Original Cot' })).id);
    const changed = await renameLocation(new NextRequest('http://localhost/api/sleep-locations', { method: 'PUT',
      headers: { Authorization: `Bearer ${token(peer)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'Original Cot', to: 'Synthetic Cot' }) }));
    expect(changed.status).toBe(200); expect((await read(saved.id)).revision).not.toBe(saved.revision);
    const before = await rows(); expect((await wake(saved)).status).toBe(409); expect(await rows()).toEqual(before);
  });

  it('a full snapshot claim rejects a write that changed after the authenticated lookup', async () => {
    const initial = await seed(), saved = await read(initial.id), gate = state.gate = readGate();
    const pending = wake(saved);
    try {
      await gate.reached(1); await db.sleepLog.update({ where: { id: initial.id }, data: { notes: 'Concurrent verified correction', updatedAt: initial.updatedAt } });
      const winner = await rows(); gate.release(0); expect((await pending).status).toBe(409); expect(await rows()).toEqual(winner); expect(state.notify).not.toHaveBeenCalled();
    } finally { gate.releaseAll(); await Promise.allSettled([pending]); }
  });

  it('allows one wake when two caregivers read the same revision before either mutation', async () => {
    const saved = await read((await seed()).id), gate = state.gate = readGate(); const first = wake(saved);
    let second: Promise<Response> | undefined;
    try {
      await gate.reached(1); second = wake(saved, { expectedScope: scope(babyId, peer), endTime: '2026-10-20T13:10:00.000Z' }, token(peer)); await gate.reached(2);
      gate.release(0); expect((await first).status).toBe(200); const winner = await rows(); gate.release(1);
      expect((await second).status).toBe(409); expect(await rows()).toEqual(winner); expect(state.notify).toHaveBeenCalledTimes(1);
    } finally { gate.releaseAll(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
  });

  it.each(['removed', 'soft-deleted'])('does not resurrect a record %s after the read', async kind => {
    const saved = await read((await seed()).id), gate = state.gate = readGate(), pending = wake(saved);
    try {
      await gate.reached(1);
      if (kind === 'removed') await db.sleepLog.delete({ where: { id: saved.id } });
      else await db.sleepLog.update({ where: { id: saved.id }, data: { deletedAt: new Date() } });
      const before = await rows(); gate.release(0); expect((await pending).status).toBe(409); expect(await rows()).toEqual(before);
    } finally { gate.releaseAll(); await Promise.allSettled([pending]); }
  });

  it('Start Undo preserves a sleep another ordinary caregiver has completed or corrected', async () => {
    const saved = await read((await seed()).id);
    expect((await PUT(req('PUT', 'id=' + saved.id, { endTime, notes: 'Peer verified the wake time' }, token(peer)))).status).toBe(200);
    const before = await rows(); expect((await undo(saved, 'undo-start')).status).toBe(409); expect(await rows()).toEqual(before);
  });

  it('Wake Undo preserves a later caregiver correction and a clean Undo can reopen the exact saved revision', async () => {
    const saved = await read((await seed()).id), first = await wake(saved), completed = (await first.json()).data;
    expect((await PUT(req('PUT', 'id=' + saved.id, { endTime: '2026-10-20T12:55:00.000Z', notes: 'Peer corrected endpoint' }, token(peer)))).status).toBe(200);
    const before = await rows(); expect((await undo(completed, 'undo-wake')).status).toBe(409); expect(await rows()).toEqual(before);
    const current = await read(saved.id); expect((await undo(current, 'undo-wake')).status).toBe(200);
    expect(await db.sleepLog.findUnique({ where: { id: saved.id } })).toMatchObject({ endTime: null, duration: null, notes: 'Peer corrected endpoint' });
  });

  it('blocks a guarded Wake when a second legacy active row appears after the displayed lookup', async () => {
    const saved = await read((await seed()).id); await seed(); const before = await rows();
    expect((await wake(saved)).status).toBe(409); expect(await rows()).toEqual(before); expect(state.notify).not.toHaveBeenCalled();
  });

  it('does not reopen a completed sleep when another active sleep exists for the child', async () => {
    const saved = await read((await seed({ endTime: new Date(endTime), duration: 60 })).id); await seed(); const before = await rows();
    expect((await undo(saved, 'undo-wake')).status).toBe(409); expect(await rows()).toEqual(before);
  });

  it('rolls a failed endpoint update and failed Undo delete back without a notification or receipt loss', async () => {
    const body = startBody(), response = await POST(req('POST', '', body)), saved = (await response.json()).data; const before = await rows(); state.notify.mockClear();
    await db.$executeRawUnsafe("CREATE TRIGGER sleep_fail_update BEFORE UPDATE ON SleepLog BEGIN SELECT RAISE(ABORT, 'synthetic endpoint failure'); END");
    try { expect((await wake(saved)).status).toBe(500); expect(await rows()).toEqual(before); expect(state.notify).not.toHaveBeenCalled(); }
    finally { await db.$executeRawUnsafe('DROP TRIGGER sleep_fail_update'); }
    await db.$executeRawUnsafe("CREATE TRIGGER sleep_fail_delete BEFORE DELETE ON SleepLog BEGIN SELECT RAISE(ABORT, 'synthetic delete failure'); END");
    try { expect((await undo(saved, 'undo-start')).status).toBe(500); expect(await rows()).toEqual(before); }
    finally { await db.$executeRawUnsafe('DROP TRIGGER sleep_fail_delete'); }
    expect((await undo(saved, 'undo-start')).status).toBe(200); expect(await db.sleepLog.count()).toBe(0); expect(await db.externalImportRecord.count()).toBe(1);
    expect((await POST(req('POST', '', body))).status).toBe(409);
  });

  it('uses auth family and original child/actor for guarded requests', async () => {
    const saved = await read((await seed()).id), before = await rows();
    expect((await wake(saved, {}, '')).status).toBe(401);
    expect((await wake(saved, {}, token(foreign, foreign))).status).toBe(404);
    expect((await wake(saved, {}, token(peer))).status).toBe(409);
    expect((await wake(saved, { expectedScope: scope(siblingId) })).status).toBe(409);
    expect((await undo(saved, 'undo-start', { expectedScope: scope(siblingId) })).status).toBe(409);
    expect(await rows()).toEqual(before);
  });

  it('refuses new nursery starts for removed or foreign children and never creates receipts', async () => {
    await db.baby.update({ where: { id: babyId }, data: { deletedAt: new Date() } });
    expect((await POST(req('POST', '', startBody()))).status).toBe(404);
    expect((await POST(req('POST', '', startBody(randomUUID(), { babyId: foreign, expectedScope: scope(foreign) })))).status).toBe(404);
    expect(await rows()).toEqual({ sleeps: [], receipts: [] });
  });

  it('activeOnly preserves ambiguity while excluding completed, removed and other-child rows', async () => {
    const active = await seed(); await seed(); await seed({ endTime: new Date(endTime), duration: 60 }); await seed({ deletedAt: new Date() }); await seed({ babyId: siblingId });
    const response = await GET(req('GET', `babyId=${babyId}&activeOnly=true`)); expect(response.status).toBe(200); const data = (await response.json()).data;
    expect(data).toHaveLength(2); expect(data.every((row: Record<string, unknown>) => row.endTime === null && row.deletedAt === null && row.babyId === babyId)).toBe(true);
    expect(data.find((row: { id: string }) => row.id === active.id).revision).toMatch(/^[a-f\d]{64}$/);
  });

  it.each([
    { nurseryAction: 'start', requestId: null }, { expectedScope: null }, { requestId: {} }, { requestId: 'not-a-uuid' },
    { expectedRevision: 'a'.repeat(64) }, { nurseryAction: 'wake' }, { endTime }, { duration: 5 },
    { startTime: '2026-10-20 12:00:00Z' }, { familyId: foreign }, { caretakerId: peer }, { baby: { connect: { id: siblingId } } },
  ])('rejects malformed start metadata or persistence fields without writes: %j', async extra => {
    expect((await POST(req('POST', '', startBody(randomUUID(), extra)))).status).toBe(400); expect(await rows()).toEqual({ sleeps: [], receipts: [] });
  });

  it.each([
    { expectedRevision: null }, { expectedRevision: 'stale' }, { expectedScope: [] }, { requestId: randomUUID() },
    { endTime: null }, { endTime: '2026-10-20T11:00:00.000Z' }, { duration: 1 }, { babyId: siblingId },
    { notes: 'Guarded wake only changes its endpoint' }, { familyId: foreign }, { endTime: { set: endTime } },
  ])('rejects malformed guarded wake without any write: %j', async extra => {
    const saved = await read((await seed()).id), before = await rows(); expect((await wake(saved, extra)).status).toBe(400); expect(await rows()).toEqual(before);
  });

  it('keeps ordinary completed historical entry, correction, and bodyless deletion compatible', async () => {
    const response = await POST(req('POST', '', { babyId, startTime, endTime, type: 'NIGHT_SLEEP', location: null, quality: null, notes: null }));
    expect(response.status).toBe(200); const saved = (await response.json()).data; expect(saved.duration).toBe(60);
    expect((await PUT(req('PUT', 'id=' + saved.id, { notes: 'Reviewed historical sleep', babyId: siblingId, location: 'Contact' }))).status).toBe(200);
    expect((await read(saved.id)).babyId).toBe(siblingId); expect(await db.externalImportRecord.count()).toBe(0);
    expect((await DELETE(req('DELETE', 'id=' + saved.id))).status).toBe(200); expect(await db.sleepLog.count()).toBe(0);
  });
});
