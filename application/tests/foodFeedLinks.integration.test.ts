import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
import { GET, POST, PUT, DELETE } from '../app/api/food-log/route';
import { convertSolidsFeeds } from '../scripts/convert-solids-feeds-runner';

const familyId = 'food-link-family', foreignFamilyId = 'food-link-foreign-family';
const babyId = 'food-link-child', siblingId = 'food-link-sibling', foreignBabyId = 'food-link-foreign-child';
const caretakerId = 'food-link-caregiver', foreignCaretakerId = 'food-link-foreign-caregiver';
const foodId = 'food-link-pear', secondFoodId = 'food-link-carrot', foreignFoodId = 'food-link-foreign-pear';
const originalId = 'food-link-original';
const at = new Date('2026-10-20T12:00:00Z');
const targets = [
  ['foreign family', 'food-link-foreign-solids'],
  ['other child', 'food-link-sibling-solids'],
  ['wrong meal type', 'food-link-bottle'],
  ['missing feed', 'food-link-missing'],
] as const;
let db: PrismaClient, directory: string, secret: string, previousSecret: string | undefined;

function request(method: 'POST' | 'PUT' | 'GET' | 'DELETE', body?: unknown, id?: string, foreign = false, query = '') {
  const token = jwt.sign({
    id: foreign ? foreignCaretakerId : caretakerId,
    familyId: foreign ? foreignFamilyId : familyId,
    role: 'USER', type: 'parent',
  }, secret, { expiresIn: '10m' });
  return new NextRequest(`http://localhost/api/food-log${id ? `?id=${id}` : query}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const createBody = (extra: Record<string, unknown> = {}) => ({ babyId, foodId, time: at.toISOString(), ...extra });
const snapshot = async () => ({
  foodLogs: await db.foodLog.findMany({ orderBy: { id: 'asc' } }),
  feeds: await db.feedLog.findMany({ orderBy: { id: 'asc' } }),
  foods: await db.food.findMany({ orderBy: { id: 'asc' } }),
  photoLinks: await db.photoLink.findMany({ orderBy: { id: 'asc' } }),
});

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-food-links-'));
  const url = `file:${path.join(directory, 'synthetic.db')}`;
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
  });
  previousSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = secret = randomBytes(32).toString('hex');
  state.db = db = new PrismaClient({ adapter: createPrismaAdapter(url) });
  await db.family.createMany({ data: [familyId, foreignFamilyId].map(id => ({ id, slug: id, name: 'Synthetic food-link family', setupStage: 3 })) });
  await db.caretaker.createMany({ data: [
    { id: caretakerId, familyId }, { id: foreignCaretakerId, familyId: foreignFamilyId },
  ].map(value => ({ ...value, name: 'Synthetic food caregiver', role: 'USER', type: 'parent', loginId: '01', securityPin: '123456' })) });
  await db.baby.createMany({ data: [
    { id: babyId, familyId }, { id: siblingId, familyId }, { id: foreignBabyId, familyId: foreignFamilyId },
  ].map(value => ({ ...value, firstName: 'Synthetic', lastName: 'Child', birthDate: new Date('2026-01-01T00:00:00Z') })) });
}, 90_000);

beforeEach(async () => {
  await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS synthetic_food_write_failure');
  await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS synthetic_feed_delete_failure');
  await db.photoLink.deleteMany(); await db.photo.deleteMany();
  await db.foodLog.deleteMany(); await db.feedLog.deleteMany(); await db.food.deleteMany();
  await db.food.createMany({ data: [
    { id: foodId, familyId, name: 'Synthetic pear' },
    { id: secondFoodId, familyId, name: 'Synthetic carrot' },
    { id: 'food-link-removed-food', familyId, name: 'Removed synthetic food', deletedAt: at },
    { id: foreignFoodId, familyId: foreignFamilyId, name: 'Synthetic foreign pear' },
  ] });
  await db.feedLog.createMany({ data: ([
    { id: 'food-link-own-solids', familyId, babyId, caretakerId, type: 'SOLIDS' },
    { id: 'food-link-sibling-solids', familyId, babyId: siblingId, caretakerId, type: 'SOLIDS' },
    { id: 'food-link-foreign-solids', familyId: foreignFamilyId, babyId: foreignBabyId, caretakerId: foreignCaretakerId, type: 'SOLIDS' },
    { id: 'food-link-foreign-control', familyId: foreignFamilyId, babyId: foreignBabyId, caretakerId: foreignCaretakerId, type: 'SOLIDS' },
    { id: 'food-link-bottle', familyId, babyId, caretakerId, type: 'BOTTLE' },
  ] as const).map(value => ({ ...value, time: at, amount: 3, food: 'Synthetic pear', notes: `Private source ${value.id}` })) });
  await db.foodLog.create({ data: { id: originalId, familyId, babyId, caretakerId, foodId, time: at, notes: 'Original synthetic try' } });
});

afterAll(async () => {
  await db?.$disconnect();
  if (directory) rmSync(directory, { recursive: true, force: true });
  if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
});

describe('ordinary food form controls and scope', () => {
  it('creates, reads and updates an ordinary unlinked food try with the current form payload', async () => {
    const created = await POST(request('POST', {
      babyId, foods: [{ foodId, hadReaction: false, reactionDescription: null }], time: at.toISOString(),
      amount: 2, unitAbbr: 'TBSP', enjoyment: 'LIKED', notes: 'Reviewed synthetic meal',
    }));
    expect(created.status).toBe(200);
    const entry = (await created.json()).data;
    expect(entry).toMatchObject({ familyId, babyId, foodId, amount: 2, unitAbbr: 'TBSP', feedLogId: null });
    const edited = await PUT(request('PUT', { babyId, notes: 'Reviewed correction' }, entry.id));
    expect(edited.status).toBe(200);
    expect((await edited.json()).data).toMatchObject({ familyId, babyId, notes: 'Reviewed correction', feedLogId: null });
    const read = await GET(request('GET', undefined, entry.id));
    expect(read.status).toBe(200);
    expect((await read.json()).data.id).toBe(entry.id);
  });

  it.each([null, ''])('accepts own-child SOLIDS links and preserves omission versus clearing with %j', async clear => {
    const feedsBefore = await db.feedLog.findMany({ orderBy: { id: 'asc' } });
    const created = await POST(request('POST', createBody({ feedLogId: 'food-link-own-solids' })));
    expect(created.status).toBe(200);
    const entry = (await created.json()).data;
    expect(entry.feedLogId).toBe('food-link-own-solids');
    const omitted = await PUT(request('PUT', { notes: 'Reviewed correction' }, entry.id));
    expect(omitted.status).toBe(200); expect((await omitted.json()).data.feedLogId).toBe('food-link-own-solids');
    const cleared = await PUT(request('PUT', { feedLogId: clear }, entry.id));
    expect(cleared.status).toBe(200); expect((await cleared.json()).data.feedLogId).toBeNull();
    const unlinked = await POST(request('POST', createBody({ feedLogId: clear })));
    expect(unlinked.status).toBe(200); expect((await unlinked.json()).data.feedLogId).toBeNull();
    expect(await db.feedLog.findMany({ orderBy: { id: 'asc' } })).toEqual(feedsBefore);
  });

  it('does not expose a foreign feed body through the echoed link or bypass foreign food-log GET scope', async () => {
    const foreignLog = await db.foodLog.create({ data: {
      familyId: foreignFamilyId, babyId: foreignBabyId, caretakerId: foreignCaretakerId,
      foodId: foreignFoodId, time: at, notes: 'Private foreign food try',
    } });
    expect((await GET(request('GET', undefined, foreignLog.id))).status).toBe(404);
    // Historical invalid associations are preserved, not retroactively repaired.
    const entry = await db.foodLog.update({ where: { id: originalId }, data: { feedLogId: 'food-link-foreign-solids' } });
    const response = await GET(request('GET', undefined, entry.id));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('food-link-foreign-solids');
    expect(text).not.toContain('Private source'); expect(text).not.toContain('Private foreign food try');
    expect(JSON.parse(text).data).not.toHaveProperty('feedLog');
  });
});

describe.each(['POST', 'PUT'] as const)('%s feed relationship boundary', method => {
  it.each(targets)('rejects a %s link before changing a food try', async (label, target) => {
    const before = await snapshot();
    const response = method === 'POST'
      ? await POST(request(method, createBody({ feedLogId: target })))
      : await PUT(request(method, { feedLogId: target, notes: 'Unreviewed relink' }, originalId));
    const after = await snapshot();
    expect(response.status).toBe(404);
    expect(after).toEqual(before);
  });

  it('rejects a new link to a removed source without changing the food try', async () => {
    await db.feedLog.update({ where: { id: 'food-link-own-solids' }, data: { deletedAt: at } });
    const before = await snapshot();
    const response = method === 'POST'
      ? await POST(request(method, createBody({ feedLogId: 'food-link-own-solids' })))
      : await PUT(request(method, { feedLogId: 'food-link-own-solids' }, originalId));
    expect(response.status).toBe(404); expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['boolean', false], ['zero', 0], ['number', 42], ['array', []], ['object', {}],
    ['operator', { set: 'food-link-own-solids' }], ['whitespace', '   '],
  ])('rejects a %s feedLogId without mutation', async (_label, feedLogId) => {
    const before = await snapshot();
    const response = method === 'POST'
      ? await POST(request(method, createBody({ feedLogId })))
      : await PUT(request(method, { feedLogId, notes: 'Rejected change' }, originalId));
    expect(response.status).toBe(400); expect(await snapshot()).toEqual(before);
  });

  it('leaves the source and food try unchanged when a validated write fails in SQLite', async () => {
    await db.$executeRawUnsafe(`CREATE TRIGGER synthetic_food_write_failure BEFORE ${method === 'POST' ? 'INSERT' : 'UPDATE'} ON FoodLog
      WHEN NEW.notes = 'Synthetic rejected write' BEGIN SELECT RAISE(ABORT, 'synthetic food write failure'); END`);
    const before = await snapshot();
    const data = { feedLogId: 'food-link-own-solids', notes: 'Synthetic rejected write' };
    const response = method === 'POST'
      ? await POST(request(method, createBody(data)))
      : await PUT(request(method, data, originalId));
    expect(response.status).toBe(500); expect(await snapshot()).toEqual(before);
  });
});

describe('historical provenance and canonical child ownership', () => {
  it.each(targets)('preserves an unchanged historical %s link during ordinary edits', async (_label, feedLogId) => {
    await db.foodLog.update({ where: { id: originalId }, data: { feedLogId } });
    const feedsBefore = await db.feedLog.findMany({ orderBy: { id: 'asc' } });
    const omitted = await PUT(request('PUT', { notes: 'Reviewed historical entry' }, originalId));
    expect(omitted.status).toBe(200);
    expect((await omitted.json()).data.feedLogId).toBe(feedLogId);
    const echoed = await PUT(request('PUT', { feedLogId, notes: 'Reviewed historical provenance' }, originalId));
    expect(echoed.status).toBe(200);
    expect((await echoed.json()).data).toMatchObject({ feedLogId, babyId, familyId });
    expect(await db.feedLog.findMany({ orderBy: { id: 'asc' } })).toEqual(feedsBefore);
  });

  it('allows a validated replacement but never uses an ignored child echo to authorize a sibling link', async () => {
    await db.foodLog.update({ where: { id: originalId }, data: { feedLogId: 'food-link-old-source' } });
    const replaced = await PUT(request('PUT', { babyId: siblingId, feedLogId: 'food-link-own-solids' }, originalId));
    expect(replaced.status).toBe(200);
    expect((await replaced.json()).data).toMatchObject({ babyId, feedLogId: 'food-link-own-solids' });
    const before = await snapshot();
    const rejected = await PUT(request('PUT', { babyId: siblingId, feedLogId: 'food-link-sibling-solids' }, originalId));
    expect(rejected.status).toBe(404); expect(await snapshot()).toEqual(before);
  });

  it('does not modify another family’s food log even with a valid owned feed link', async () => {
    const foreign = await db.foodLog.create({ data: {
      familyId: foreignFamilyId, babyId: foreignBabyId, foodId: foreignFoodId, time: at,
    } });
    const before = await snapshot();
    const response = await PUT(request('PUT', { feedLogId: 'food-link-own-solids', notes: 'Rejected' }, foreign.id));
    expect(response.status).toBe(404); expect(await snapshot()).toEqual(before);
  });
});

describe('food catalog validation remains unchanged', () => {
  it.each([foreignFoodId, 'food-link-removed-food', 'food-link-missing-food'])('rejects invalid catalog food %s in single and multi-food writes', async invalidFoodId => {
    for (const method of ['POST', 'PUT'] as const) {
      for (const fields of [{ foodId: invalidFoodId }, { foods: [{ foodId }, { foodId: invalidFoodId }] }]) {
        const before = await snapshot();
        const data = { ...fields, feedLogId: 'food-link-own-solids', notes: 'Rejected catalog change' };
        const response = method === 'POST'
          ? await POST(request(method, createBody(data)))
          : await PUT(request(method, data, originalId));
        expect(response.status).toBe(404); expect(await snapshot()).toEqual(before);
      }
    }
  });

  it('preserves the actual multi-food form’s nullable amounts and per-food reactions', async () => {
    const created = await POST(request('POST', {
      babyId, time: at.toISOString(), amount: null, unitAbbr: null, enjoyment: null,
      foods: [{ foodId, hadReaction: false }, { foodId: secondFoodId, hadReaction: true, reactionDescription: 'Synthetic rash' }],
    }));
    expect(created.status).toBe(200);
    const entry = (await created.json()).data;
    expect(entry).toMatchObject({ foodId: null, amount: null, unitAbbr: null, feedLogId: null, hadReaction: true });
    expect(entry.foodItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ foodId, hadReaction: false }),
      expect.objectContaining({ foodId: secondFoodId, hadReaction: true, reactionDescription: 'Synthetic rash' }),
    ]));
    const corrected = await PUT(request('PUT', {
      foods: [{ foodId, hadReaction: false }], amount: null, unitAbbr: null, enjoyment: null, notes: null,
    }, entry.id));
    expect(corrected.status).toBe(200);
    expect((await corrected.json()).data).toMatchObject({ foodId, hadReaction: false, reactionDescription: null, amount: null, unitAbbr: null, notes: null });
  });
});

describe('actual startup and restore conversion consumer', () => {
  it('ignores a removed legacy cross-family link without rewriting it or suppressing the foreign source', async () => {
    const foreignBefore = await db.feedLog.findUniqueOrThrow({ where: { id: 'food-link-foreign-solids' } });
    const entry = await db.foodLog.update({ where: { id: originalId }, data: { feedLogId: foreignBefore.id } });
    expect((await DELETE(request('DELETE', undefined, entry.id))).status).toBe(200);
    const removedBefore = await db.foodLog.findUniqueOrThrow({ where: { id: entry.id } });
    const first = await convertSolidsFeeds(db);
    const second = await convertSolidsFeeds(db);
    const targetAfter = await db.feedLog.findUnique({ where: { id: foreignBefore.id } });
    const correctCopy = await db.foodLog.findMany({ where: { familyId: foreignFamilyId, babyId: foreignBabyId, feedLogId: foreignBefore.id } });
    const controlCopy = await db.foodLog.findMany({ where: { familyId: foreignFamilyId, babyId: foreignBabyId, feedLogId: 'food-link-foreign-control' } });
    const victimRead = await GET(request('GET', undefined, undefined, true, `?babyId=${foreignBabyId}`));
    const victimData = (await victimRead.json()).data;
    expect(controlCopy).toHaveLength(1);
    expect(first).toMatchObject({ total: 4, converted: 4, skipped: 0, errors: 0 });
    expect(correctCopy).toHaveLength(1); expect(targetAfter).toBeNull();
    expect(correctCopy[0]).toMatchObject({ familyId: foreignFamilyId, babyId: foreignBabyId, time: foreignBefore.time, amount: foreignBefore.amount, notes: foreignBefore.notes });
    expect(victimData.map((log: { feedLogId: string | null }) => log.feedLogId)).toContain(foreignBefore.id);
    expect(await db.foodLog.findUniqueOrThrow({ where: { id: entry.id } })).toEqual(removedBefore);
    expect(second).toMatchObject({ total: 0, converted: 0, skipped: 0, errors: 0 });
  });

  it('ignores a wrong-child legacy link without moving the old try or suppressing the sibling meal', async () => {
    const previous = await db.foodLog.update({ where: { id: originalId }, data: { feedLogId: 'food-link-sibling-solids' } });
    const result = await convertSolidsFeeds(db);
    const siblingCopies = await db.foodLog.findMany({ where: { babyId: siblingId, feedLogId: 'food-link-sibling-solids' } });
    expect(result).toMatchObject({ total: 4, converted: 4, skipped: 0, errors: 0 });
    expect(siblingCopies).toHaveLength(1);
    expect(await db.foodLog.findUniqueOrThrow({ where: { id: originalId } })).toEqual(previous);
    expect(await db.feedLog.findUnique({ where: { id: 'food-link-sibling-solids' } })).toBeNull();
  });

  it('does not resurrect a matching removed food try on either converter run', async () => {
    const source = await db.feedLog.findUniqueOrThrow({ where: { id: 'food-link-own-solids' } });
    const removed = await db.foodLog.update({ where: { id: originalId }, data: { feedLogId: source.id, deletedAt: at } });
    const first = await convertSolidsFeeds(db);
    const second = await convertSolidsFeeds(db);
    expect(first).toMatchObject({ total: 4, converted: 3, skipped: 1, errors: 0 });
    expect(second).toMatchObject({ total: 1, converted: 0, skipped: 1, errors: 0 });
    expect(await db.foodLog.findMany({ where: { familyId, babyId, feedLogId: source.id } })).toEqual([removed]);
    expect(await db.feedLog.findUniqueOrThrow({ where: { id: source.id } })).toEqual(source);
  });

  it('preserves a converted food try’s missing source during an ordinary edit and exact ID echo', async () => {
    const converted = await convertSolidsFeeds(db);
    expect(converted).toMatchObject({ total: 4, converted: 4, errors: 0 });
    const entry = await db.foodLog.findFirstOrThrow({ where: { familyId, babyId, feedLogId: 'food-link-own-solids' } });
    expect(await db.feedLog.findUnique({ where: { id: entry.feedLogId! } })).toBeNull();
    const omitted = await PUT(request('PUT', { notes: 'Reviewed converted meal' }, entry.id));
    expect(omitted.status).toBe(200); expect((await omitted.json()).data.feedLogId).toBe(entry.feedLogId);
    const echoed = await PUT(request('PUT', { feedLogId: entry.feedLogId, enjoyment: 'LIKED' }, entry.id));
    expect(echoed.status).toBe(200);
    expect((await echoed.json()).data).toMatchObject({ feedLogId: entry.feedLogId, notes: 'Reviewed converted meal', enjoyment: 'LIKED' });
    expect(await convertSolidsFeeds(db)).toMatchObject({ total: 0, converted: 0, errors: 0 });
    expect(await db.feedLog.count()).toBe(1); // The unrelated bottle remains.
  });

  it('rolls back the converted copy and photo movement if deleting the source fails, then retries once', async () => {
    const source = await db.feedLog.findUniqueOrThrow({ where: { id: 'food-link-own-solids' } });
    const photo = await db.photo.create({ data: {
      familyId, babyId, caretakerId, originalName: 'synthetic.jpg', storedName: 'synthetic.enc', thumbStoredName: 'synthetic-thumb.enc',
      mimeType: 'image/jpeg', fileSize: 1, thumbSize: 1, takenAt: at,
    } });
    const link = await db.photoLink.create({ data: { photoId: photo.id, activityType: 'feed', activityId: source.id } });
    await db.$executeRawUnsafe(`CREATE TRIGGER synthetic_feed_delete_failure BEFORE DELETE ON FeedLog
      WHEN OLD.id = '${source.id}' BEGIN SELECT RAISE(ABORT, 'synthetic source delete failure'); END`);
    const failed = await convertSolidsFeeds(db);
    expect(failed).toMatchObject({ total: 4, converted: 3, skipped: 0, errors: 1 });
    expect(await db.feedLog.findUniqueOrThrow({ where: { id: source.id } })).toEqual(source);
    expect(await db.foodLog.count({ where: { familyId, babyId, feedLogId: source.id } })).toBe(0);
    expect(await db.photoLink.findUniqueOrThrow({ where: { id: link.id } })).toEqual(link);
    await db.$executeRawUnsafe('DROP TRIGGER synthetic_feed_delete_failure');
    expect(await convertSolidsFeeds(db)).toMatchObject({ total: 1, converted: 1, skipped: 0, errors: 0 });
    const copies = await db.foodLog.findMany({ where: { familyId, babyId, feedLogId: source.id } });
    expect(copies).toHaveLength(1);
    expect(await db.photoLink.findUniqueOrThrow({ where: { id: link.id } })).toMatchObject({ activityType: 'foodLog', activityId: copies[0].id });
    expect(await convertSolidsFeeds(db)).toMatchObject({ total: 0, converted: 0, errors: 0 });
  });
});
