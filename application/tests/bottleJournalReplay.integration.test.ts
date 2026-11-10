// Real JWT middleware and migrated, disposable SQLite exercise the journal's
// durable create receipt together with the canonical feed deletion endpoint.
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

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient,
  notifications: vi.fn(async () => {}), timers: vi.fn(async () => {}) }));
vi.mock('../app/api/db', () => ({ get default() { return state.db; } }));
vi.mock('../app/api/utils/api-logger', () => ({ logApiCall: vi.fn(async () => {}), getClientInfo: () => ({}) }));
vi.mock('../src/lib/notifications/activityHook', () => ({
  notifyActivityCreated: state.notifications, resetTimerNotificationState: state.timers,
}));
import { POST } from '../app/api/bottle-journal/route';
import { DELETE } from '../app/api/feed-log/route';

let directory: string, secret: string, previousSecret: string | undefined;
const familyId = 'journal-replay-family', babyId = 'journal-replay-child', caretakerId = 'journal-replay-caregiver';
const bottle = { time: '2026-10-21T15:01:00.000Z', amount: 90, offeredAmount: 120,
  unitAbbr: 'ML', bottleType: 'Formula', formulaKcalOz: 22, formulaName: 'Synthetic formula',
  bottleLabel: 'Synthetic label', notes: 'Synthetic notes' };
const token = (family = familyId) => jwt.sign({ id: caretakerId, familyId: family, role: 'ADMIN', type: 'parent' }, secret, { expiresIn: '10m' });
const scope = (child = babyId) => journalScope(familyId, `caretaker:${caretakerId}`, child);
const create = (body: unknown, auth = token()) => POST(new NextRequest('http://localhost/api/bottle-journal', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
  body: JSON.stringify(body),
}));
const remove = (id: string) => DELETE(new NextRequest(`http://localhost/api/feed-log?id=${id}`, {
  method: 'DELETE', headers: { Authorization: `Bearer ${token()}` },
}));
const request = () => ({ babyId, bottle, requestId: randomUUID(), expectedScope: scope() });
const snapshot = async () => ({ feeds: await state.db.feedLog.findMany({ orderBy: { id: 'asc' } }),
  receipts: await state.db.externalImportRecord.findMany({ orderBy: { id: 'asc' } }) });

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-journal-replay-'));
  const url = 'file:' + path.join(directory, 'synthetic.db');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
  });
  previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = secret = randomBytes(32).toString('hex');
  state.db = new PrismaClient({ adapter: createPrismaAdapter(url) });
  await state.db.family.createMany({ data: [familyId, 'journal-replay-other-family'].map(id => ({ id, slug: id, name: 'Synthetic Family' })) });
  await state.db.baby.createMany({ data: [babyId, 'journal-replay-sibling'].map(id => ({ id, familyId,
    firstName: 'Synthetic', lastName: 'Child', birthDate: new Date('2026-01-01Z') })) });
  await state.db.caretaker.create({ data: { id: caretakerId, familyId, name: 'Synthetic Caregiver',
    role: 'ADMIN', type: 'parent', loginId: 'jr', securityPin: 'synthetic-only' } });
  await state.db.unit.createMany({ data: [{ unitAbbr: 'ML', unitName: 'Milliliters' }, { unitAbbr: 'OZ', unitName: 'Ounces' }] });
}, 90_000);
beforeEach(async () => {
  await state.db.feedLog.deleteMany(); await state.db.externalImportRecord.deleteMany();
  state.notifications.mockClear(); state.timers.mockClear();
});
afterAll(async () => {
  await state.db?.$disconnect(); if (directory) rmSync(directory, { recursive: true, force: true });
  if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
});

describe('bottle journal durable replay receipts with real authenticated routes', () => {
  it('confirms an unchanged lost-response retry without modifying the feed, receipt or attribution', async () => {
    const body = request();
    expect((await create(body)).status).toBe(200);
    const saved = await snapshot();
    const replay = await create(body);
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toEqual({ id: body.requestId, created: false, updated: false });
    expect(await snapshot()).toEqual(saved);
    expect(saved.feeds[0].caretakerId).toBe(caretakerId);
    expect(state.notifications).toHaveBeenCalledTimes(1); expect(state.timers).toHaveBeenCalledTimes(1);
  });

  it('returns an actionable conflict after canonical hard deletion, retaining the receipt and never resurrecting the feed', async () => {
    const body = request(); expect((await create(body)).status).toBe(200);
    const receipts = (await snapshot()).receipts;
    expect((await remove(body.requestId)).status).toBe(200);
    const replay = await create(body);
    expect(replay.status).toBe(409);
    expect((await replay.json()).success).toBe(false);
    expect(await snapshot()).toEqual({ feeds: [], receipts });
    expect(state.notifications).toHaveBeenCalledTimes(1); expect(state.timers).toHaveBeenCalledTimes(1);
  });

  it('treats a soft-deleted saved feed as a conflict and preserves its tombstone', async () => {
    const body = request(); await create(body);
    await state.db.feedLog.update({ where: { id: body.requestId }, data: { deletedAt: new Date() } });
    const saved = await snapshot();
    expect((await create(body)).status).toBe(409);
    expect(await snapshot()).toEqual(saved);
  });

  it('does not accept changed values or a moved child as a successful original retry', async () => {
    const body = request(); await create(body);
    await state.db.feedLog.update({ where: { id: body.requestId }, data: { amount: 91 } });
    let saved = await snapshot();
    expect((await create(body)).status).toBe(409); expect(await snapshot()).toEqual(saved);
    await state.db.feedLog.update({ where: { id: body.requestId }, data: { babyId: 'journal-replay-sibling' } });
    saved = await snapshot();
    expect((await create(body)).status).toBe(409); expect(await snapshot()).toEqual(saved);
  });

  it.each([
    { targetRecordId: 'another-target-record' }, { targetEntityType: 'PumpLog' }, { sourceChildId: 'journal-replay-sibling' },
  ])('rejects a mismatched receipt before confirming an existing feed: %o', async change => {
    const body = request(); await create(body);
    await state.db.externalImportRecord.updateMany({ data: change });
    const saved = await snapshot();
    expect((await create(body)).status).toBe(409);
    expect(await snapshot()).toEqual(saved);
  });

  it.each([
    { targetRecordId: 'another-target-record' }, { targetEntityType: 'PumpLog' }, { sourceChildId: 'journal-replay-sibling' },
  ])('rejects a mismatched receipt with no surviving feed without inserting a replacement: %o', async change => {
    const body = request(); await create(body); await remove(body.requestId);
    await state.db.externalImportRecord.updateMany({ data: change });
    const saved = await snapshot();
    expect((await create(body)).status).toBe(409);
    expect(await snapshot()).toEqual(saved);
  });

  it('keeps authorized revision-aware corrections and legacy canonical bottles working', async () => {
    const body = request(); await create(body);
    const original = await state.db.feedLog.findUniqueOrThrow({ where: { id: body.requestId } });
    expect((await create({ ...body, bottle: { ...bottle, amount: 95 }, expectedUpdatedAt: original.updatedAt.toISOString() })).status).toBe(200);
    expect((await create({ ...body, bottle: { ...bottle, amount: 96 }, expectedUpdatedAt: original.updatedAt.toISOString() })).status).toBe(409);
    await state.db.externalImportRecord.deleteMany();
    const current = await state.db.feedLog.findUniqueOrThrow({ where: { id: body.requestId } });
    expect((await create({ ...body, bottle: { ...bottle, amount: 95 } })).status).toBe(200);
    expect((await create({ ...body, bottle: { ...bottle, amount: 96 }, expectedUpdatedAt: current.updatedAt.toISOString() })).status).toBe(200);
    expect(await state.db.externalImportRecord.count()).toBe(0);
  });

  it('allows a reviewed edit after a same-family child reassignment while preserving original receipt provenance', async () => {
    const body = request(); await create(body);
    await state.db.feedLog.update({ where: { id: body.requestId }, data: { babyId: 'journal-replay-sibling' } });
    const saved = await snapshot(), revision = saved.feeds[0].updatedAt.toISOString();
    const reassigned = { ...body, babyId: 'journal-replay-sibling', expectedScope: scope('journal-replay-sibling') };
    expect((await create(reassigned)).status).toBe(409);
    expect((await create({ ...reassigned, bottle: { ...bottle, amount: 95 }, expectedUpdatedAt: revision })).status).toBe(200);
    expect((await snapshot()).receipts).toEqual(saved.receipts);
    expect(await state.db.feedLog.findUnique({ where: { id: body.requestId } })).toMatchObject({ babyId: 'journal-replay-sibling', amount: 95 });
  });

  it('checks authentication and family access before reading or disclosing a receipt', async () => {
    const body = request(); await create(body); await remove(body.requestId);
    const saved = await snapshot();
    expect((await create(body, '')).status).toBe(401);
    expect((await create({ ...body, expectedScope: journalScope('journal-replay-other-family', `caretaker:${caretakerId}`, babyId) }, token('journal-replay-other-family'))).status).toBe(404);
    expect((await create({ ...body, expectedScope: scope('journal-replay-sibling') })).status).toBe(409);
    expect(await snapshot()).toEqual(saved);
  });
});
