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
import { DIAPER_RASH_TEXT_LIMITS } from '@/src/utils/diaperRash';

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
  pumps: await db.pumpLog.findMany({ orderBy: { id: 'asc' } }), medicines: await db.medicineLog.findMany({ orderBy: { id: 'asc' } }),
  diapers: await db.diaperLog.findMany({ orderBy: { id: 'asc' } }) });

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
  await db.feedLog.deleteMany(); await db.pumpLog.deleteMany(); await db.diaperLog.deleteMany(); await db.apiKey.deleteMany();
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

describe('diaper rash hooks with real API-key authorization and migrated SQLite', () => {
  const time = '2026-10-20T13:14:15.678Z';
  const unknownRash = { rashObserved: null, rashLocation: null, rashDescription: null, rashProductsApplied: null, rashFollowUpNotes: null };
  const rashText = { rashLocation: ' Synthetic location ', rashDescription: 'Synthetic caregiver wording\nSecond line', rashProductsApplied: 'Synthetic product record', rashFollowUpNotes: 'Synthetic follow-up' };
  const create = (patch: Record<string, unknown> = {}, token: string | null = apiToken, child = babyId) => createActivity(childRequest('POST', 'activities', {
    type: 'diaper', diaperType: 'WET', time, ...patch,
  }, token, child), context(child));
  const edit = (id: string, patch: Record<string, unknown>, token: string | null = apiToken, child = babyId) => updateActivity(childRequest('PUT', `activities/${id}`, {
    type: 'diaper', ...patch,
  }, token, child), { params: Promise.resolve({ babyId: child, activityId: id }) });
  const list = (token: string | null = apiToken, child = babyId) => listActivities(childRequest('GET', 'activities?type=diaper&since=2026-01-01T00:00:00Z', undefined, token, child), context(child));
  const snapshot = async () => ({ ...await careRows(), babies: await db.baby.findMany({ orderBy: { id: 'asc' } }), families: await db.family.findMany({ orderBy: { id: 'asc' } }), caretakers: await db.caretaker.findMany({ orderBy: { id: 'asc' } }) });

  it.each([
    { diaperType: 'WET', rashObserved: true }, { diaperType: 'DIRTY', rashObserved: false },
    { diaperType: 'BOTH', rashObserved: null }, { diaperType: 'DRY', rashObserved: undefined },
  ])('creates and lists $diaperType rash state $rashObserved without inference', async ({ diaperType, rashObserved }) => {
    const before = await snapshot();
    const rash = rashObserved === undefined ? {} : { rashObserved, ...rashText };
    const expected = rashObserved === undefined ? unknownRash : rash;
    const response = await create({ diaperType, creamApplied: true, notes: 'Synthetic note mentions rash without inference', ...rash });
    expect(response.status).toBe(200);
    const created = (await response.json()).data;
    expect(created).toMatchObject({ activityType: 'diaper', time, details: { type: diaperType, ...expected } });
    expect(await db.diaperLog.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ familyId, babyId, ...expected });
    const listed = await list();
    expect(listed.status).toBe(200);
    expect((await listed.json()).data.activities).toEqual([expect.objectContaining({ id: created.id, time, details: expect.objectContaining(expected) })]);
    const after = await snapshot();
    expect({ ...after, diapers: after.diapers.filter(row => row.id !== created.id) }).toEqual(before);
  });

  it('preserves omitted observations and timestamps while explicit false and independent clears round-trip through edit summaries', async () => {
    const original = await db.diaperLog.create({ data: { id: 'synthetic-rash-hook-edit', familyId, babyId, caretakerId, time: new Date(time), type: 'BOTH', rashObserved: true, ...rashText } });
    let expected: Record<string, unknown> = { rashObserved: true, ...rashText };
    let notes = original.notes;
    for (const patch of [
      { notes: 'Legacy client notes correction' }, { rashObserved: undefined, rashLocation: undefined },
      { rashObserved: false }, { rashLocation: null }, { rashObserved: null }, unknownRash,
    ]) {
      // Empty hook updates retain their existing rejection; use an unchanged
      // notes echo when JSON omits all undefined rash values.
      const response = await edit(original.id, { notes, ...patch });
      expect(response.status).toBe(200);
      for (const [key, value] of Object.entries(patch)) if (key !== 'notes' && value !== undefined) expected[key] = value;
      if ('notes' in patch) notes = patch.notes!;
      expect((await response.json()).data).toMatchObject({ id: original.id, babyId, time, status: 'updated', details: expected });
      const stored = await db.diaperLog.findUniqueOrThrow({ where: { id: original.id } });
      expect(stored).toEqual({ ...original, ...expected, notes, updatedAt: stored.updatedAt });
    }
  });

  it.each(Object.entries(DIAPER_RASH_TEXT_LIMITS))('accepts the %s text boundary and rejects wrong types or excess length without partial writes', async (field, limit) => {
    const value = ' ' + 'é'.repeat(limit - 3) + '\n ';
    const response = await create({ [field]: value });
    expect(response.status).toBe(200);
    const created = (await response.json()).data;
    expect(created.details[field]).toBe(value);
    const update = await edit(created.id, { [field]: value });
    expect(update.status).toBe(200);
    expect((await update.json()).data.details[field]).toBe(value);
    const before = await snapshot();
    for (const invalid of ['x'.repeat(limit + 1), 1, false, [], { set: 'Synthetic' }]) {
      expect((await create({ rashObserved: true, [field]: invalid })).status).toBe(400);
      expect((await edit(created.id, { rashObserved: false, [field]: invalid })).status).toBe(400);
      expect(await snapshot()).toEqual(before);
    }
  });

  it.each(['true', 'false', '', 0, 1, [], { set: true }].map(value => ({ value })))(
    'rejects rash boolean $value without coercion on both hook write paths', async ({ value }) => {
      const original = await db.diaperLog.create({ data: { familyId, babyId, time: new Date(time), type: 'WET', rashObserved: true } });
      const before = await snapshot();
      expect((await create({ rashObserved: value })).status).toBe(400);
      expect((await edit(original.id, { rashObserved: value, notes: 'Must not save' })).status).toBe(400);
      expect(await snapshot()).toEqual(before);
    },
  );

  it('retains write-scope, revoked-key, family, child restriction and removed-child checks for rash fields', async () => {
    const original = await db.diaperLog.create({ data: { familyId, babyId, time: new Date(time), type: 'WET', rashObserved: true } });
    const foreign = await db.diaperLog.create({ data: { familyId: otherFamilyId, babyId: foreignId, time: new Date(time), type: 'DRY', rashObserved: false, rashDescription: 'Foreign synthetic observation' } });
    const sibling = await db.diaperLog.create({ data: { familyId, babyId: siblingId, time: new Date(time), type: 'BOTH', rashObserved: false } });
    const before = await snapshot();
    for (const [token, status] of [[await key({ scopes: JSON.stringify(['read']) }), 403], [await key({ revoked: true }), 401], [null, 401]] as const) {
      expect((await create({ rashObserved: true }, token)).status).toBe(status);
      expect((await edit(original.id, { rashObserved: false }, token)).status).toBe(status);
    }
    expect((await create({ rashObserved: true }, apiToken, foreignId)).status).toBe(404);
    expect((await edit(foreign.id, { rashObserved: true })).status).toBe(404);
    expect((await edit(sibling.id, { rashObserved: true })).status).toBe(404);
    const restricted = await key({ babyId });
    expect((await create({ rashObserved: true }, restricted, siblingId)).status).toBe(403);
    expect((await edit(sibling.id, { rashObserved: true }, restricted, siblingId)).status).toBe(403);
    expect((await list(apiToken, foreignId)).status).toBe(404);
    for (const injection of [{ familyId: otherFamilyId }, { babyId: foreignId }, { caretakerId }, { baby: { connect: { id: foreignId } } }]) {
      expect((await create({ rashObserved: true, ...injection })).status).toBe(400);
      expect((await edit(original.id, { rashObserved: false, ...injection })).status).toBe(400);
    }
    expect(await snapshot()).toEqual(before);
    const listed = await list();
    expect(listed.status).toBe(200);
    expect((await listed.json()).data.activities.map((row: { id: string }) => row.id)).toEqual([original.id]);
    await removeThroughApp();
    const removed = await snapshot();
    expect((await create({ rashObserved: true })).status).toBe(404);
    expect((await edit(original.id, { rashObserved: false })).status).toBe(404);
    expect((await list()).status).toBe(404);
    expect(await snapshot()).toEqual(removed);
  });
});
