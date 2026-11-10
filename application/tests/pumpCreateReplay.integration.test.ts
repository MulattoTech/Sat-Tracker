import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';
import { journalScope } from '@/src/lib/bottle-journal/outbox-identity';

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient, notifications: vi.fn(async () => {}) }));
vi.mock('../app/api/db', () => ({ get default() { return state.db; } }));
vi.mock('../app/api/utils/api-logger', () => ({ logApiCall: vi.fn(async () => {}), getClientInfo: () => ({}) }));
vi.mock('../src/lib/notifications/activityHook', () => ({ notifyActivityCreated: state.notifications }));
import { POST, DELETE } from '../app/api/pump-log/route';

let directory: string;
let secret: string;
let previousSecret: string | undefined;
const familyId = 'nursery-replay-family';
const babyId = 'nursery-replay-child';
const caretakerId = 'nursery-replay-caregiver';
const expectedScope = journalScope(familyId, `caretaker:${caretakerId}`, babyId);
const valid = { babyId, startTime: '2026-10-20T13:00:00Z', endTime: '2026-10-20T13:12:00Z',
  duration: 12, leftAmount: 45, rightAmount: 55, unitAbbr: 'ML', pumpAction: 'FED', expectedScope };
const token = (id = caretakerId, family = familyId) => jwt.sign({ id, familyId: family, role: 'ADMIN', type: 'parent' }, secret, { expiresIn: '10m' });
const create = (body: unknown, auth = token()) => POST(new NextRequest('http://localhost/api/pump-log', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body),
}));
const counts = async () => ({ pumps: await state.db.pumpLog.count(), feeds: await state.db.feedLog.count(), receipts: await state.db.externalImportRecord.count() });

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-nursery-replay-'));
  const url = 'file:' + path.join(directory, 'synthetic.db');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
  });
  previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = secret = randomBytes(32).toString('hex');
  state.db = new PrismaClient({ adapter: createPrismaAdapter(url) });
  await state.db.family.createMany({ data: [familyId, 'nursery-other-family'].map(id => ({ id, slug: id, name: 'Synthetic Family' })) });
  await state.db.baby.createMany({ data: [babyId, 'nursery-second-child'].map(id => ({ id, familyId,
    firstName: 'Synthetic', lastName: 'Child', birthDate: new Date('2026-01-01Z') })) });
  await state.db.caretaker.createMany({ data: [caretakerId, 'nursery-other-caregiver'].map((id, i) => ({ id, familyId,
    name: 'Synthetic Caregiver', type: 'Parent', role: 'ADMIN', loginId: `n${i}`, securityPin: '123456' })) });
  await state.db.settings.create({ data: { familyId, enableBreastMilkTracking: true } });
  await state.db.unit.createMany({ data: [{ unitAbbr: 'ML', unitName: 'Milliliters' }, { unitAbbr: 'OZ', unitName: 'Ounces' }] });
}, 90_000);

beforeEach(async () => {
  await state.db.feedLog.deleteMany();
  await state.db.pumpLog.deleteMany();
  await state.db.externalImportRecord.deleteMany();
  await state.db.settings.updateMany({ where: { familyId }, data: { enableBreastMilkTracking: true } });
  state.notifications.mockClear();
});

afterAll(async () => {
  await state.db?.$disconnect();
  if (directory) rmSync(directory, { recursive: true, force: true });
  if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
});

describe('nursery pumping create identity with real JWT auth and migrated SQLite', () => {
  it('replays a lost successful response without duplicating the pump, feed, stock source, or notification', async () => {
    const body = { ...valid, requestId: randomUUID() };
    const first = await create(body), firstData = await first.json();
    expect(first.status).toBe(200);
    const before = await state.db.pumpLog.findFirstOrThrow();
    const feeds = await state.db.feedLog.findMany();
    const replay = await create(body), replayData = await replay.json();
    expect(replay.status).toBe(200);
    expect(replayData.data.id).toBe(firstData.data.id);
    expect(await counts()).toEqual({ pumps: 1, feeds: 1, receipts: 1 });
    expect(await state.db.pumpLog.findFirst()).toEqual(before);
    expect(await state.db.feedLog.findMany()).toEqual(feeds);
    expect(state.notifications).toHaveBeenCalledTimes(1);
  });

  it.each(['STORED', 'UNKNOWN', 'DISCARDED'])('replays %s without inventing a feeding record', async pumpAction => {
    const body = { ...valid, pumpAction, requestId: randomUUID() };
    expect((await create(body)).status).toBe(200);
    expect((await create(body)).status).toBe(200);
    expect(await counts()).toEqual({ pumps: 1, feeds: 0, receipts: 1 });
  });

  it('rejects changed intent under an already used request ID and preserves the winning record', async () => {
    const body = { ...valid, requestId: randomUUID() };
    expect((await create(body)).status).toBe(200);
    const before = await state.db.pumpLog.findMany(), feeds = await state.db.feedLog.findMany();
    expect((await create({ ...body, leftAmount: 75 })).status).toBe(409);
    expect((await create({ ...body, pumpAction: 'STORED' })).status).toBe(409);
    expect(await state.db.pumpLog.findMany()).toEqual(before);
    expect(await state.db.feedLog.findMany()).toEqual(feeds);
  });

  it('does not recreate a deleted pump after a late retry', async () => {
    const body = { ...valid, requestId: randomUUID() };
    const saved = await (await create(body)).json();
    expect((await DELETE(new NextRequest(`http://localhost/api/pump-log?id=${saved.data.id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token()}` },
    }))).status).toBe(200);
    expect((await create(body)).status).toBe(409);
    expect(await counts()).toEqual({ pumps: 0, feeds: 0, receipts: 1 });
  });

  it('does not silently accept a replay after another caregiver changed the pump or its feed', async () => {
    const body = { ...valid, requestId: randomUUID() };
    await create(body);
    await state.db.feedLog.updateMany({ data: { amount: 50 } });
    expect((await create(body)).status).toBe(409);
    await state.db.feedLog.updateMany({ data: { amount: 100 } });
    await state.db.pumpLog.updateMany({ data: { notes: 'Reviewed correction' } });
    expect((await create(body)).status).toBe(409);
    expect(await counts()).toEqual({ pumps: 1, feeds: 1, receipts: 1 });
  });

  it('rejects a pending session submitted with another caregiver or child scope', async () => {
    const body = { ...valid, requestId: randomUUID() };
    expect((await create(body, token('nursery-other-caregiver'))).status).toBe(409);
    expect((await create({ ...body, babyId: 'nursery-second-child' })).status).toBe(409);
    expect(await counts()).toEqual({ pumps: 0, feeds: 0, receipts: 0 });
  });

  it('uses authenticated family ownership and rejects anonymous, expired and cross-family requests', async () => {
    const body = { ...valid, requestId: randomUUID() };
    expect((await create(body, '')).status).toBe(401);
    const expired = jwt.sign({ id: caretakerId, familyId, role: 'ADMIN' }, secret, { expiresIn: -1 });
    expect((await create(body, expired)).status).toBe(401);
    expect((await create(body, token(caretakerId, 'nursery-other-family'))).status).toBe(404);
    expect(await counts()).toEqual({ pumps: 0, feeds: 0, receipts: 0 });
  });

  it('validates request identity and scope before mutations', async () => {
    for (const requestId of ['', 'not-a-uuid', 12, null]) {
      expect((await create({ ...valid, requestId })).status).toBe(400);
    }
    expect((await create({ ...valid, requestId: randomUUID(), expectedScope: undefined })).status).toBe(400);
    expect(await counts()).toEqual({ pumps: 0, feeds: 0, receipts: 0 });
  });

  it('rejects a saved draft for a subsequently archived child without creating hidden care records', async () => {
    await state.db.baby.update({ where: { id: babyId }, data: { deletedAt: new Date() } });
    try {
      expect((await create({ ...valid, requestId: randomUUID() })).status).toBe(404);
      expect(await counts()).toEqual({ pumps: 0, feeds: 0, receipts: 0 });
    } finally { await state.db.baby.update({ where: { id: babyId }, data: { deletedAt: null } }); }
  });

  it('allows correction after a rejected validation using the same identity', async () => {
    const body = { ...valid, requestId: randomUUID() };
    expect((await create({ ...body, leftAmount: -5 })).status).toBe(400);
    expect((await create(body)).status).toBe(200);
    expect(await counts()).toEqual({ pumps: 1, feeds: 1, receipts: 1 });
  });

  it('rolls back the pump and receipt when linked-feed creation fails', async () => {
    const body = { ...valid, requestId: randomUUID() };
    await state.db.$executeRawUnsafe(`CREATE TRIGGER nursery_fail_feed BEFORE INSERT ON FeedLog BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
    try {
      expect((await create(body)).status).toBe(500);
      expect(await counts()).toEqual({ pumps: 0, feeds: 0, receipts: 0 });
    } finally { await state.db.$executeRawUnsafe('DROP TRIGGER nursery_fail_feed'); }
    expect((await create(body)).status).toBe(200);
    expect(await counts()).toEqual({ pumps: 1, feeds: 1, receipts: 1 });
  });

  it('allows at most one atomic creation for overlapping identical submissions', async () => {
    const body = { ...valid, requestId: randomUUID() };
    const results = await Promise.all([create(body), create(body)]);
    expect(results.some(result => result.status === 200)).toBe(true);
    expect(results.every(result => [200, 409].includes(result.status))).toBe(true);
    expect((await create(body)).status).toBe(200);
    expect(await counts()).toEqual({ pumps: 1, feeds: 1, receipts: 1 });
    expect(state.notifications).toHaveBeenCalledTimes(1);
  });
});
