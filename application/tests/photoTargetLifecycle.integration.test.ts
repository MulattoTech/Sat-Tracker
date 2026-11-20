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
vi.mock('../src/lib/notifications/activityHook', () => ({ notifyActivityCreated: vi.fn(async () => {}), resetTimerNotificationState: vi.fn(async () => {}) }));
import { PUT as putFeed, DELETE as deleteFeed } from '../app/api/feed-log/route';
import { DELETE as deleteDiaper } from '../app/api/diaper-log/route';
import { PUT as putBath, DELETE as deleteBath } from '../app/api/bath-log/route';
import { DELETE as deletePlay } from '../app/api/play-log/route';
import { PUT as putMeasurement, DELETE as deleteMeasurement } from '../app/api/measurement-log/route';
import { PUT as putMilestone, DELETE as deleteMilestone } from '../app/api/milestone-log/route';
import { DELETE as deleteFood } from '../app/api/food-log/route';
import { DELETE as deleteBaby } from '../app/api/baby/route';
import { DELETE as hookDelete } from '../app/api/hooks/v1/babies/[babyId]/activities/[activityId]/route';
import { POST as attach, DELETE as detach } from '../app/api/photos/links/route';

const familyId = 'photo-lifecycle-family', foreign = 'photo-lifecycle-foreign';
const babyId = 'photo-lifecycle-child', sibling = 'photo-lifecycle-sibling', caretakerId = 'photo-lifecycle-caregiver';
const at = new Date('2026-11-01T12:00:00Z');
const targets = [
  ['feed', 'feed-log', deleteFeed], ['diaper', 'diaper-log', deleteDiaper], ['bath', 'bath-log', deleteBath],
  ['play', 'play-log', deletePlay], ['measurement', 'measurement-log', deleteMeasurement],
  ['milestone', 'milestone-log', deleteMilestone], ['foodLog', 'food-log', deleteFood],
] as const;
const moves = [
  ['feed', 'feed-log', putFeed], ['bath', 'bath-log', putBath],
  ['measurement', 'measurement-log', putMeasurement], ['milestone', 'milestone-log', putMilestone],
] as const;
let db: PrismaClient, directory: string, secret: string, previousSecret: string | undefined, apiToken: string;
const token = () => jwt.sign({ id: caretakerId, familyId, role: 'USER', type: 'parent' }, secret, { expiresIn: '10m' });
const request = (method: string, route: string, body?: unknown, auth = token()) => new NextRequest(`http://localhost/api/${route}`, {
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const ref = (type: string) => ({ activityType: type, activityId: 'target-' + type });
const snapshot = async () => ({
  family: await db.family.findMany({ orderBy: { id: 'asc' } }), babies: await db.baby.findMany({ orderBy: { id: 'asc' } }),
  photos: await db.photo.findMany({ orderBy: { id: 'asc' } }), links: await db.photoLink.findMany({ orderBy: { id: 'asc' } }),
  feeds: await db.feedLog.findMany({ orderBy: { id: 'asc' } }), diapers: await db.diaperLog.findMany({ orderBy: { id: 'asc' } }),
  baths: await db.bathLog.findMany({ orderBy: { id: 'asc' } }), play: await db.playLog.findMany({ orderBy: { id: 'asc' } }),
  measurements: await db.measurement.findMany({ orderBy: { id: 'asc' } }), milestones: await db.milestone.findMany({ orderBy: { id: 'asc' } }),
  foods: await db.foodLog.findMany({ orderBy: { id: 'asc' } }),
});
const newPhoto = (id: string, extra: Record<string, unknown> = {}) => db.photo.create({ data: {
  id, familyId, babyId, originalName: 'synthetic.png', storedName: `${id}.enc`, thumbStoredName: `${id}-thumb.enc`,
  fileSize: 10, thumbSize: 5, mimeType: 'image/png', takenAt: at, caption: 'Retain this memory', ...extra,
} });
const add = (photoId: string, type: string) => attach(request('POST', 'photos/links', { photoId, ...ref(type) }));

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-photo-lifecycle-'));
  const url = 'file:' + path.join(directory, 'synthetic.db');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
  });
  previousSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = secret = randomBytes(32).toString('hex');
  state.db = db = new PrismaClient({ adapter: createPrismaAdapter(url) });
  await db.appConfig.create({ data: { adminPass: 'synthetic-unused', rootDomain: 'photo-lifecycle.invalid', enablePhotos: true } });
  await db.family.createMany({ data: [familyId, foreign].map(id => ({ id, slug: id, name: 'Synthetic photo lifecycle family' })) });
  await db.baby.createMany({ data: [babyId, sibling, foreign].map(id => ({ id, familyId: id === foreign ? foreign : familyId,
    firstName: 'Synthetic', lastName: 'Child', birthDate: at })) });
  await db.caretaker.create({ data: { id: caretakerId, familyId, name: 'Synthetic caregiver', loginId: '72', securityPin: '123456', role: 'USER' } });
  await db.food.create({ data: { id: 'lifecycle-food', familyId, name: 'Synthetic food' } });
  apiToken = 'st_live_synthetic_' + randomUUID();
  await db.apiKey.create({ data: { name: 'Synthetic lifecycle', keyPrefix: apiToken.slice(0, 16),
    keyHash: createHash('sha256').update(apiToken).digest('hex'), familyId, scopes: JSON.stringify(['read', 'write']) } });
}, 90_000);

beforeEach(async () => {
  await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS synthetic_target_delete_failure');
  await db.photoLink.deleteMany(); await db.photo.deleteMany();
  await db.feedLog.deleteMany(); await db.diaperLog.deleteMany(); await db.bathLog.deleteMany(); await db.playLog.deleteMany();
  await db.measurement.deleteMany(); await db.milestone.deleteMany(); await db.foodLog.deleteMany();
  await db.baby.updateMany({ data: { deletedAt: null } });
  const owner = { familyId, babyId, caretakerId };
  await db.feedLog.createMany({ data: ['target-feed', 'other-feed'].map(id => ({ ...owner, id, time: at, type: 'BOTTLE' as const })) });
  await db.diaperLog.create({ data: { ...owner, id: 'target-diaper', time: at, type: 'WET' } });
  await db.bathLog.create({ data: { ...owner, id: 'target-bath', time: at } });
  await db.playLog.create({ data: { ...owner, id: 'target-play', startTime: at, type: 'TUMMY_TIME' } });
  await db.measurement.create({ data: { ...owner, id: 'target-measurement', date: at, type: 'WEIGHT', value: 4, unit: 'kg' } });
  await db.milestone.create({ data: { ...owner, id: 'target-milestone', date: at, title: 'Synthetic milestone', category: 'MOTOR' } });
  await db.foodLog.create({ data: { ...owner, id: 'target-foodLog', time: at, foodId: 'lifecycle-food' } });
});

afterAll(async () => {
  await db?.$disconnect(); if (directory) rmSync(directory, { recursive: true, force: true });
  if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
});

describe('photo target lifecycle through real JWT and API-key routes', () => {
  it.each(targets)('explicit %s deletion detaches owned live/trashed references while retaining photo content and unrelated links', async (type, route, remove) => {
    const primary = type === 'milestone' ? { milestoneId: 'target-milestone' } : {};
    const first = await newPhoto('first', primary), trashed = await newPhoto('trashed', { ...primary, deletedAt: at });
    await db.photoLink.createMany({ data: [first, trashed].map(photo => ({ photoId: photo.id, ...ref(type) })) });
    const other = await db.photoLink.create({ data: { photoId: first.id, activityType: 'feed', activityId: 'other-feed' } });
    const families = await db.family.findMany();
    expect((await remove(request('DELETE', `${route}?id=target-${type}`))).status).toBe(200);
    expect(await db.photoLink.findMany()).toEqual([other]);
    for (const photo of [first, trashed]) {
      const after = await db.photo.findUniqueOrThrow({ where: { id: photo.id } });
      expect(after).toEqual(type === 'milestone' ? { ...photo, milestoneId: null, updatedAt: expect.any(Date) } : photo);
    }
    expect(await db.family.findMany()).toEqual(families);
    if (type === 'foodLog') expect((await db.foodLog.findUniqueOrThrow({ where: { id: 'target-foodLog' } })).deletedAt).not.toBeNull();
    expect((await add(first.id, type)).status).toBe(404);
  });

  it.each(targets)('malformed sibling association blocks %s deletion atomically until explicit owned detach', async (type, route, remove) => {
    await newPhoto('sibling-photo', { babyId: sibling });
    const link = await db.photoLink.create({ data: { photoId: 'sibling-photo', ...ref(type) } });
    const before = await snapshot();
    expect((await remove(request('DELETE', `${route}?id=target-${type}`))).status).toBe(409);
    expect(await snapshot()).toEqual(before);
    expect((await detach(request('DELETE', `photos/links?photoId=sibling-photo&linkId=${link.id}`))).status).toBe(200);
    expect((await remove(request('DELETE', `${route}?id=target-${type}`))).status).toBe(200);
    expect(await db.photo.count()).toBe(1);
  });

  it.each(moves)('%s child move rejects retained photos and succeeds after explicit detach', async (type, route, update) => {
    await newPhoto('move-photo', { deletedAt: at });
    const link = await db.photoLink.create({ data: { photoId: 'move-photo', ...ref(type) } });
    const before = await snapshot();
    expect((await update(request('PUT', `${route}?id=target-${type}`, { babyId: sibling }))).status).toBe(409);
    expect(await snapshot()).toEqual(before);
    expect((await detach(request('DELETE', `photos/links?photoId=move-photo&linkId=${link.id}`))).status).toBe(200);
    expect((await update(request('PUT', `${route}?id=target-${type}`, { babyId: sibling }))).status).toBe(200);
    await db.photo.update({ where: { id: 'move-photo' }, data: { deletedAt: null } });
    expect((await add('move-photo', type)).status).toBe(404);
  });

  it.each(['foreign', 'null-family', 'sibling'] as const)('scalar-only %s milestone tag reserves ownership and blocks delete/move without leaking or clearing it', async bad => {
    await newPhoto('tag-only', { milestoneId: 'target-milestone',
      ...(bad === 'foreign' ? { familyId: foreign, babyId: foreign } : bad === 'null-family' ? { familyId: null } : { babyId: sibling }) });
    const before = await snapshot();
    expect((await putMilestone(request('PUT', 'milestone-log?id=target-milestone', { babyId: sibling }))).status).toBe(409);
    expect((await deleteMilestone(request('DELETE', 'milestone-log?id=target-milestone'))).status).toBe(409);
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back detachment and primary milestone clearing when target deletion fails', async () => {
    await newPhoto('rollback-photo', { milestoneId: 'target-milestone' });
    await db.photoLink.create({ data: { photoId: 'rollback-photo', ...ref('milestone') } });
    await db.$executeRawUnsafe("CREATE TRIGGER synthetic_target_delete_failure BEFORE DELETE ON Milestone BEGIN SELECT RAISE(ABORT, 'synthetic target failure'); END");
    const before = await snapshot();
    expect((await deleteMilestone(request('DELETE', 'milestone-log?id=target-milestone'))).status).toBe(500);
    expect(await snapshot()).toEqual(before);
  });

  it.each(['feed', 'diaper', 'play', 'bath', 'measurement'])('hook %s deletion follows the same detach/review policy with real API-key auth', async type => {
    await newPhoto('hook-photo');
    await db.photoLink.create({ data: { photoId: 'hook-photo', ...ref(type) } });
    const url = `hooks/v1/babies/${babyId}/activities/target-${type}?type=${type}`;
    const ctx = { params: Promise.resolve({ babyId, activityId: `target-${type}` }) };
    const before = await db.photo.findMany();
    expect((await hookDelete(request('DELETE', url, undefined, apiToken), ctx)).status).toBe(200);
    expect(await db.photo.findMany()).toEqual(before);
    expect(await db.photoLink.count()).toBe(0);
  });

  it('rejects a target and photo whose matching child ID belongs to another family', async () => {
    await db.feedLog.update({ where: { id: 'target-feed' }, data: { babyId: foreign } });
    await newPhoto('foreign-child-photo', { babyId: foreign });
    await db.photoLink.create({ data: { photoId: 'foreign-child-photo', ...ref('feed') } });
    const before = await snapshot();
    expect((await deleteFeed(request('DELETE', 'feed-log?id=target-feed'))).status).toBe(409);
    expect(await snapshot()).toEqual(before);
  });

  it('child soft deletion retains historical attachments and rejects later new attachments', async () => {
    await newPhoto('history-photo');
    expect((await add('history-photo', 'diaper')).status).toBe(200);
    const photos = await db.photo.findMany(), links = await db.photoLink.findMany();
    expect((await deleteBaby(request('DELETE', `baby?id=${babyId}`))).status).toBe(200);
    expect(await db.photo.findMany()).toEqual(photos); expect(await db.photoLink.findMany()).toEqual(links);
    expect((await add('history-photo', 'feed')).status).toBe(404);
  });
});
