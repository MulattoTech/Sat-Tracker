import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient, type Prisma } from '@prisma/client';
import { NextRequest } from 'next/server';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
vi.mock('../app/api/db', () => ({ get default() { return state.db; } }));
vi.mock('../app/api/utils/api-logger', () => ({ logApiCall: vi.fn(async () => {}), getClientInfo: () => ({ ip: '127.0.0.67' }) }));
import { POST as login } from '../app/api/auth/route';
import { GET as listPhotos } from '../app/api/photos/route';
import { GET as getPhoto } from '../app/api/photos/[id]/route';
import { GET as getPhotoFile } from '../app/api/photos/file/[id]/route';
import { GET as attachments } from '../app/api/photos/attachments/route';
import { GET as getPhotoLog } from '../app/api/photo-log/route';
import { GET as timeline } from '../app/api/timeline/route';

const family = 'photo-read-family', foreignFamily = 'photo-read-foreign';
const child = 'photo-read-child', sibling = 'photo-read-sibling', foreignChild = 'photo-read-foreign-child', removedChild = 'photo-read-removed-child';
const at = new Date('2026-11-20T12:00:00.123Z');
let db: PrismaClient, directory: string, token: string, foreignToken: string;
let previousSecret: string | undefined, previousMode: string | undefined;

function request(url: string, credential: string | null = token, method = 'GET', body?: unknown) {
  return new NextRequest(`http://localhost${url}`, { method,
    headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function data(response: Response) {
  expect(response.status).toBe(200);
  const result = await response.json(); expect(result.success).toBe(true); return result.data;
}
const target = (type: string, id: string, credential = token) => attachments(request(`/api/photos/attachments?activityType=${type}&activityId=${id}`, credential));
const rawPhotos = async () => ({
  photos: await db.photo.findMany({ orderBy: { id: 'asc' } }),
  links: await db.photoLink.findMany({ orderBy: { id: 'asc' } }),
});
const photo = (id: string, extra: Partial<Prisma.PhotoUncheckedCreateInput> = {}) => db.photo.create({ data: {
  id, familyId: family, babyId: child, originalName: `${id}.jpg`, storedName: `${id}.enc`, thumbStoredName: `${id}-thumb.enc`,
  mimeType: 'image/jpeg', fileSize: 10, thumbSize: 5, takenAt: at, caption: `Synthetic ${id}`, ...extra,
} });
const link = (photoId: string, activityType: string, activityId: string, id = `${photoId}-${activityType}-${activityId}`) =>
  db.photoLink.create({ data: { id, photoId, activityType, activityId } });

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-photo-read-boundaries-'));
  const url = `file:${path.join(directory, 'synthetic.db')}`;
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60000,
  });
  previousSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = randomBytes(32).toString('hex');
  previousMode = process.env.DEPLOYMENT_MODE; process.env.DEPLOYMENT_MODE = 'selfhosted';
  state.db = db = new PrismaClient({ adapter: createPrismaAdapter(url) });
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at);
  await db.family.createMany({ data: [family, foreignFamily].map(id => ({ id, slug: id, name: 'Synthetic photo family', setupStage: 3 })) });
  await db.settings.createMany({ data: [family, foreignFamily].map(familyId => ({ familyId, authType: 'CARETAKER' })) });
  await db.appConfig.create({ data: { adminPass: 'synthetic-unused-password', rootDomain: 'photo-read.invalid', enablePhotos: true } });
  await db.baby.createMany({ data: [
    { id: child, familyId: family }, { id: sibling, familyId: family },
    { id: foreignChild, familyId: foreignFamily }, { id: removedChild, familyId: family, deletedAt: at },
  ].map(value => ({ ...value, firstName: 'Synthetic', lastName: 'Photo child', birthDate: new Date('2026-01-01T00:00:00Z') })) });
  await db.caretaker.createMany({ data: [family, foreignFamily].map((familyId, index) => ({
    id: `${familyId}-caregiver`, familyId, name: 'Synthetic caregiver', loginId: `p${index}`, securityPin: '830271', type: 'Parent', role: 'USER',
  })) });
  const tokens: string[] = [];
  for (const [index, familySlug] of [family, foreignFamily].entries()) {
    const result = await data(await login(request('/api/auth', null, 'POST', { loginId: `p${index}`, securityPin: '830271', familySlug })));
    tokens.push(result.token);
  }
  [token, foreignToken] = tokens;
}, 90000);

beforeEach(async () => {
  await db.photo.deleteMany(); await db.photoLog.deleteMany(); await db.feedLog.deleteMany();
  await db.diaperLog.deleteMany(); await db.milestone.deleteMany();
  await db.feedLog.createMany({ data: [
    { id: 'own-feed', familyId: family, babyId: child },
    { id: 'sibling-feed', familyId: family, babyId: sibling },
    { id: 'foreign-feed', familyId: foreignFamily, babyId: foreignChild },
    { id: 'deleted-feed', familyId: family, babyId: child, deletedAt: at },
    { id: 'null-family-feed', familyId: null, babyId: child },
    { id: 'removed-child-feed', familyId: family, babyId: removedChild },
  ].map(value => ({ ...value, time: at, type: 'BOTTLE' })) });
  await db.diaperLog.create({ data: { id: 'own-diaper', familyId: family, babyId: child, time: at, type: 'WET' } });
  await db.photoLog.create({ data: { id: 'own-photo-log', familyId: family, babyId: child, time: at } });
  await db.milestone.createMany({ data: [
    { id: 'own-milestone', babyId: child }, { id: 'sibling-milestone', babyId: sibling },
  ].map(value => ({ ...value, familyId: family, date: at, title: `PRIVATE_${value.id}`, category: 'CUSTOM' })) });
});

afterAll(async () => {
  await db?.$disconnect(); if (directory) rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
  if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
  if (previousMode === undefined) delete process.env.DEPLOYMENT_MODE; else process.env.DEPLOYMENT_MODE = previousMode;
});

describe('photo reads through real family auth and migrated SQLite', () => {
  it('suppresses malformed targets and milestone metadata while retaining identifiable owned handles and unchanged storage', async () => {
    await photo('owned', { milestoneId: 'sibling-milestone' });
    await link('owned', 'feed', 'own-feed', 'valid-link');
    for (const [index, [kind, id]] of [
      ['feed', 'sibling-feed'], ['feed', 'foreign-feed'], ['feed', 'deleted-feed'],
      ['feed', 'null-family-feed'], ['feed', 'removed-child-feed'], ['feed', 'missing-feed'], ['unknown-legacy-type', 'legacy-target'],
    ].entries()) await link('owned', kind, id, `unavailable-handle-${index}`);
    const before = await rawPhotos();
    const list = await data(await listPhotos(request(`/api/photos?babyId=${child}`)));
    const single = await data(await getPhoto(request('/api/photos/owned')));
    expect(list.photos).toHaveLength(1); expect(list.photos[0]).toEqual(single);
    expect(single.links).toEqual([{ activityType: 'feed', activityId: 'own-feed' }]);
    expect(single).toMatchObject({ milestoneId: null, milestoneTitle: null, unavailableMilestone: true });
    expect(single.unavailableLinkIds).toHaveLength(7);
    expect(JSON.stringify(single)).not.toContain('PRIVATE_sibling');
    for (const hidden of ['sibling-feed', 'foreign-feed', 'deleted-feed', 'sibling-milestone', 'legacy-target']) {
      expect(JSON.stringify(single)).not.toContain(hidden);
    }
    expect(single.links.some((value: any) => value.activityId === 'foreign-feed')).toBe(false);
    expect(await rawPhotos()).toEqual(before);
  });

  it('loads old attachments directly beyond both gallery page sizes and retains hidden slot capacity', async () => {
    await photo('old-attached', { takenAt: new Date(at.getTime() - 10000) });
    await photo('sibling-photo', { babyId: sibling });
    await photo('foreign-photo', { familyId: foreignFamily, babyId: foreignChild });
    await photo('trashed-photo', { deletedAt: at });
    for (const id of ['old-attached', 'sibling-photo', 'foreign-photo', 'trashed-photo']) await link(id, 'feed', 'own-feed');
    await db.photo.createMany({ data: Array.from({ length: 201 }, (_, index) => ({
      id: `newer-${index}`, familyId: family, babyId: child, originalName: 'synthetic.jpg',
      storedName: `newer-${index}.enc`, thumbStoredName: `newer-${index}-thumb.enc`, mimeType: 'image/jpeg',
      fileSize: 10, thumbSize: 5, takenAt: new Date(at.getTime() + index),
    })) });
    const gallery = await data(await listPhotos(request(`/api/photos?babyId=${child}&limit=200`)));
    expect(gallery.photos.some((value: any) => value.id === 'old-attached')).toBe(false);
    const result = await data(await target('feed', 'own-feed'));
    expect(result.photos.map((value: any) => value.id)).toEqual(['old-attached']);
    expect(result).toMatchObject({ retainedLinkCount: 4, maxPhotos: 4 });
    expect((await data(await getPhoto(request('/api/photos/old-attached')))).id).toBe('old-attached');
  });

  it('projects same-child diaper and PhotoLog attachments without revealing wrong-child photos', async () => {
    await photo('valid-photo'); await photo('wrong-child-photo', { babyId: sibling });
    for (const [type, id] of [['diaper', 'own-diaper'], ['photo', 'own-photo-log']]) {
      await link('valid-photo', type, id); await link('wrong-child-photo', type, id);
      const result = await data(await target(type, id));
      expect(result.photos.map((value: any) => value.id)).toEqual(['valid-photo']);
      expect(result.retainedLinkCount).toBe(2);
    }
    const log = await data(await getPhotoLog(request('/api/photo-log?id=own-photo-log')));
    expect(log.photos.map((value: any) => value.id)).toEqual(['valid-photo']); expect(log.retainedLinkCount).toBe(2);
    const rows = await data(await timeline(request(`/api/timeline?babyId=${child}&limit=100`)));
    expect(rows.find((row: any) => row.id === 'own-diaper').photos).toEqual([{ id: 'valid-photo', caption: 'Synthetic valid-photo' }]);
    expect(JSON.stringify(rows)).not.toContain('wrong-child-photo');
  });

  it('includes valid scalar-only milestone tags exactly once without creating a missing edge', async () => {
    await photo('scalar-only', { milestoneId: 'own-milestone' });
    await photo('scalar-and-link', { milestoneId: 'own-milestone' });
    await link('scalar-and-link', 'milestone', 'own-milestone');
    const before = await rawPhotos();
    const result = await data(await target('milestone', 'own-milestone'));
    expect(result.photos.map((value: any) => value.id)).toEqual(['scalar-and-link', 'scalar-only']);
    expect(result.retainedLinkCount).toBe(2);
    expect(result.photos.every((value: any) => value.milestoneTitle === 'PRIVATE_own-milestone')).toBe(true);
    expect(await rawPhotos()).toEqual(before);
  });

  it('rejects unauthorized, deleted, unresolved and invalid direct targets without data', async () => {
    await photo('owned');
    expect((await attachments(request('/api/photos/attachments?activityType=feed&activityId=own-feed', null))).status).toBe(401);
    expect((await target('feed', 'own-feed', foreignToken)).status).toBe(404);
    for (const id of ['foreign-feed', 'deleted-feed', 'null-family-feed', 'removed-child-feed', 'missing-feed']) {
      const result = await target('feed', id); expect(result.status).toBe(404); expect((await result.json()).data).toBeUndefined();
    }
    expect((await target('legacy-unsupported', 'own-feed')).status).toBe(400);
    expect((await getPhoto(request('/api/photos/owned', foreignToken))).status).toBe(404);
    expect((await getPhotoFile(request('/api/photos/file/owned', foreignToken))).status).toBe(404);
  });

  it('does not project photos whose family and child ownership disagree', async () => {
    await photo('wrong-baby-family', { babyId: foreignChild });
    await photo('removed-baby', { babyId: removedChild });
    await photo('no-family', { familyId: null });
    expect((await data(await listPhotos(request('/api/photos')))).photos).toEqual([]);
    for (const id of ['wrong-baby-family', 'removed-baby', 'no-family']) {
      expect((await getPhoto(request(`/api/photos/${id}`))).status).toBe(404);
      expect((await getPhotoFile(request(`/api/photos/file/${id}`))).status).toBe(404);
    }
  });
});
