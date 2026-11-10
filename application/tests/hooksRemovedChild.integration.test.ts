import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
vi.mock('../app/api/db', () => ({ get default() { return state.db; } }));
vi.mock('../app/api/utils/api-logger', () => ({ logApiCall: vi.fn(async () => {}), getClientInfo: () => ({}) }));
vi.mock('../src/lib/notifications/activityHook', () => ({
  notifyActivityCreated: vi.fn(async () => {}), resetTimerNotificationState: vi.fn(async () => {}),
}));
// Both API-key middleware and canonical JWT auth remain real.
import { GET as listBabies } from '../app/api/hooks/v1/babies/route';
import { GET as listActivities, POST as createActivity } from '../app/api/hooks/v1/babies/[babyId]/activities/route';
import { PUT as updateActivity, DELETE as deleteActivity } from '../app/api/hooks/v1/babies/[babyId]/activities/[activityId]/route';
import { GET as getStatus } from '../app/api/hooks/v1/babies/[babyId]/status/route';
import { GET as getReference } from '../app/api/hooks/v1/babies/[babyId]/reference/route';
import { GET as getMeasurements } from '../app/api/hooks/v1/babies/[babyId]/measurements/latest/route';
import { DELETE as removeBaby } from '../app/api/baby/route';
import { POST as createKey } from '../app/api/api-keys/route';

const familyId = 'hooks-lifecycle-family', otherFamilyId = 'hooks-lifecycle-other-family';
const babyId = 'hooks-lifecycle-child', siblingId = 'hooks-lifecycle-sibling';
const inactiveId = 'hooks-lifecycle-inactive', foreignId = 'hooks-lifecycle-foreign';
const caretakerId = 'hooks-lifecycle-caregiver', feedId = 'hooks-lifecycle-feed';
let db: PrismaClient, directory: string, secret: string, previousSecret: string | undefined, apiToken: string;
const parentToken = () => jwt.sign({ id: caretakerId, familyId, role: 'ADMIN', type: 'parent' }, secret, { expiresIn: '10m' });
const context = (child = babyId) => ({ params: Promise.resolve({ babyId: child, activityId: feedId }) });
const request = (method: string, suffix: string, body?: unknown, token: string | null = apiToken) => new NextRequest(
  'http://localhost' + suffix, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
);
const childRequest = (method: string, suffix: string, body?: unknown, token: string | null = apiToken, child = babyId) =>
  request(method, `/api/hooks/v1/babies/${child}/${suffix}`, body, token);
const logBottle = (token: string | null = apiToken, child = babyId) => createActivity(childRequest('POST', 'activities', {
  type: 'feed', feedType: 'BOTTLE', amount: 90, unitAbbr: 'ML', bottleType: 'formula', time: '2026-10-20T13:00:00Z',
}, token, child), context(child));
const careRows = async () => ({ feeds: await db.feedLog.findMany({ orderBy: { id: 'asc' } }),
  pumps: await db.pumpLog.findMany({ orderBy: { id: 'asc' } }), medicines: await db.medicineLog.findMany({ orderBy: { id: 'asc' } }) });

async function key(data: Record<string, unknown> = {}) {
  const token = 'st_live_synthetic_' + randomUUID();
  await db.apiKey.create({ data: { name: 'Synthetic lifecycle key', keyPrefix: token.slice(0, 16),
    keyHash: createHash('sha256').update(token).digest('hex'), familyId, scopes: JSON.stringify(['read', 'write']), ...data } });
  return token;
}
async function removeThroughApp() {
  const response = await removeBaby(request('DELETE', `/api/baby?id=${babyId}`, undefined, parentToken()));
  expect(response.status).toBe(200);
  const baby = await db.baby.findUniqueOrThrow({ where: { id: babyId } });
  expect(baby.deletedAt).toBeInstanceOf(Date);
  expect(baby.inactive).toBe(false); // Deletion and the independent inactive flag are distinct.
}

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-hooks-removed-child-'));
  const url = 'file:' + path.join(directory, 'synthetic.db');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
  });
  previousSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = secret = randomBytes(32).toString('hex');
  state.db = db = new PrismaClient({ adapter: createPrismaAdapter(url) });
  await db.family.createMany({ data: [familyId, otherFamilyId].map(id => ({ id, slug: id, name: 'Synthetic Family' })) });
  await db.baby.createMany({ data: [babyId, siblingId, inactiveId, foreignId].map(id => ({ id,
    familyId: id === foreignId ? otherFamilyId : familyId, inactive: id === inactiveId,
    firstName: 'Synthetic', lastName: 'Child', birthDate: new Date('2026-01-01T00:00:00Z') })) });
  await db.caretaker.create({ data: { id: caretakerId, familyId, name: 'Synthetic Caregiver', type: 'Parent', role: 'ADMIN',
    loginId: 'lifecycle', securityPin: '123456' } });
  await db.unit.create({ data: { unitAbbr: 'ML', unitName: 'Milliliters' } });
}, 90_000);

beforeEach(async () => {
  await db.feedLog.deleteMany(); await db.pumpLog.deleteMany(); await db.apiKey.deleteMany();
  await db.baby.update({ where: { id: babyId }, data: { deletedAt: null, inactive: false } });
  await db.feedLog.create({ data: { id: feedId, familyId, babyId, caretakerId, type: 'BOTTLE',
    amount: 60, unitAbbr: 'ML', bottleType: 'Formula', time: new Date('2026-10-20T12:00:00Z') } });
  apiToken = await key();
});

afterAll(async () => {
  await db?.$disconnect();
  if (directory) rmSync(directory, { recursive: true, force: true });
  if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
});

describe('removed-child hook boundaries with real JWT/API-key auth and migrated SQLite', () => {
  it('excludes a canonically removed child from family and restricted-key discovery', async () => {
    const restricted = await key({ babyId });
    await removeThroughApp();
    const response = await listBabies(request('GET', '/api/hooks/v1/babies'));
    expect(response.status).toBe(200);
    expect((await response.json()).data.babies.map((baby: { id: string }) => baby.id)).toEqual([siblingId]);
    const scoped = await listBabies(request('GET', '/api/hooks/v1/babies', undefined, restricted));
    expect(scoped.status).toBe(200); expect((await scoped.json()).data.babies).toEqual([]);
  });

  it('rejects a later care write after canonical removal without changing retained history', async () => {
    await removeThroughApp(); const before = await careRows();
    const response = await logBottle();
    expect.soft(response.status).toBe(404);
    expect.soft(await response.json()).toMatchObject({ success: false, error: { code: 'BABY_NOT_FOUND' } });
    expect(await careRows()).toEqual(before);
  });

  it('applies the same removed-child boundary to activities, status, reference and measurements reads', async () => {
    await removeThroughApp(); const before = await careRows();
    for (const [suffix, handler] of [
      ['activities?since=2026-01-01T00:00:00Z', listActivities], ['status', getStatus],
      ['reference?type=units', getReference], ['measurements/latest', getMeasurements],
    ] as const) {
      const response = await handler(childRequest('GET', suffix), context());
      expect.soft(response.status, suffix).toBe(404);
      expect.soft(await response.json(), suffix).toMatchObject({ success: false, error: { code: 'BABY_NOT_FOUND' } });
    }
    expect(await careRows()).toEqual(before);
  });

  it('prevents existing hook keys from changing or deleting retained care records after removal', async () => {
    await removeThroughApp(); const before = await careRows();
    const updated = await updateActivity(childRequest('PUT', `activities/${feedId}?type=feed`, { type: 'feed', amount: 120 }), context());
    expect.soft(updated.status).toBe(404); expect.soft(await careRows()).toEqual(before);
    const deleted = await deleteActivity(childRequest('DELETE', `activities/${feedId}?type=feed`), context());
    expect.soft(deleted.status).toBe(404); expect(await careRows()).toEqual(before);
  });

  it('does not issue a new child-restricted key for a removed child', async () => {
    await removeThroughApp(); const before = await db.apiKey.count();
    const response = await createKey(request('POST', '/api/api-keys', { name: 'Synthetic blocked key',
      scopes: ['read', 'write'], babyId }, parentToken()));
    expect.soft(response.status).toBe(400); expect(await db.apiKey.count()).toBe(before);
  });

  it('keeps active siblings usable without changing an existing removed-child key restriction', async () => {
    const restricted = await key({ babyId });
    await removeThroughApp();
    expect((await logBottle(apiToken, siblingId)).status).toBe(200);
    const before = await careRows();
    expect((await logBottle(restricted, siblingId)).status).toBe(403);
    expect(await careRows()).toEqual(before);
    const response = await createKey(request('POST', '/api/api-keys', { name: 'Synthetic sibling key',
      scopes: ['read'], babyId: siblingId }, parentToken()));
    expect(response.status).toBe(200);
  });

  it('retains inactive, family and key-permission checks for otherwise valid requests', async () => {
    const before = await careRows();
    expect((await logBottle(apiToken, inactiveId)).status).toBe(404);
    expect((await logBottle(apiToken, foreignId)).status).toBe(404);
    expect((await logBottle(await key({ scopes: JSON.stringify(['read']) }))).status).toBe(403);
    expect((await logBottle(await key({ revoked: true }))).status).toBe(401);
    expect((await logBottle(await key({ expiresAt: new Date('2020-01-01T00:00:00Z') }))).status).toBe(401);
    expect((await logBottle(null)).status).toBe(401);
    expect(await careRows()).toEqual(before);
  });
});
