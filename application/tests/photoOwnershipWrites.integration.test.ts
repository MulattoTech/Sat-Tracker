import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';
import { PHOTO_ACTIVITY_TYPES } from '@/app/api/photos/photo-ownership';

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
vi.mock('../app/api/db', () => ({ get default() { return state.db; } }));
vi.mock('../app/api/utils/api-logger', () => ({ logApiCall: vi.fn(async () => {}), getClientInfo: () => ({}) }));
import { POST as attach, DELETE as detach } from '../app/api/photos/links/route';
import { PATCH as patchPhoto, DELETE as trashPhoto } from '../app/api/photos/[id]/route';
import { POST as uploadPhoto } from '../app/api/photos/upload/route';
import { POST as createPhotoLog, PUT as updatePhotoLog, DELETE as deletePhotoLog } from '../app/api/photo-log/route';
import { POST as bulkPhoto } from '../app/api/photos/bulk/route';
import { POST as restorePhoto } from '../app/api/photos/[id]/restore/route';

const familyId = 'synthetic-photo-' + randomUUID(), foreignFamilyId = 'synthetic-photo-foreign-' + randomUUID();
const babyId = 'synthetic-photo-child', siblingId = 'synthetic-photo-sibling', foreignBabyId = 'synthetic-photo-foreign-child';
const caretakerId = 'synthetic-photo-carer';
const at = new Date('2026-11-01T12:34:56.789Z');
const fileDir = path.join(process.cwd(), 'Files/photos', familyId);
let db: PrismaClient, directory: string, secret: string, previousSecret: string | undefined, previousKey: string | undefined, png: Buffer;
const request = (method: string, route: string, body?: unknown, authFamily: string | null = familyId, authenticated = true) => new NextRequest('http://localhost/api/' + route, {
  method, headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${jwt.sign({ id: caretakerId, familyId: authFamily, role: 'USER', type: 'parent' }, secret, { expiresIn: '10m' })}` } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const ref = (type: string) => ({ activityType: type, activityId: 'target-' + type });
const link = (photoId: string, type = 'milestone') => attach(request('POST', 'photos/links', { photoId, ...ref(type) }));
const fileSnapshot = () => existsSync(fileDir) ? readdirSync(fileDir).sort().map(name => [name, createHash('sha256').update(readFileSync(path.join(fileDir, name))).digest('hex')]) : [];
const snapshot = async () => ({
  families: await db.family.findMany({ orderBy: { id: 'asc' } }), babies: await db.baby.findMany({ orderBy: { id: 'asc' } }),
  photos: await db.photo.findMany({ orderBy: { id: 'asc' } }), links: await db.photoLink.findMany({ orderBy: { id: 'asc' } }),
  photoLogs: await db.photoLog.findMany({ orderBy: { id: 'asc' } }), milestones: await db.milestone.findMany({ orderBy: { id: 'asc' } }), files: fileSnapshot(),
});

async function upload(milestoneId: string | null = 'target-milestone', child = babyId, count = 1) {
  const form = new FormData(); form.append('babyId', child); form.append('takenAt', at.toISOString());
  if (milestoneId !== null) form.append('milestoneId', milestoneId);
  for (let i = 0; i < count; i++) form.append('files', new File([new Uint8Array(png)], `synthetic-${i}.png`, { type: 'image/png' }));
  const token = jwt.sign({ id: caretakerId, familyId, role: 'USER', type: 'parent' }, secret, { expiresIn: '10m' });
  return uploadPhoto(new NextRequest('http://localhost/api/photos/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }));
}

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-photo-writers-'));
  const url = 'file:' + path.join(directory, 'synthetic.db');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000 });
  previousSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = secret = randomBytes(32).toString('hex');
  previousKey = process.env.ENC_HASH; process.env.ENC_HASH = randomBytes(32).toString('hex');
  state.db = db = new PrismaClient({ adapter: createPrismaAdapter(url) });
  await db.appConfig.create({ data: { adminPass: 'synthetic-unused-password', rootDomain: 'synthetic.invalid', enablePhotos: true } });
  await db.family.createMany({ data: [familyId, foreignFamilyId].map(id => ({ id, slug: id, name: 'Synthetic photo family', setupStage: 3 })) });
  await db.baby.createMany({ data: [babyId, siblingId, foreignBabyId].map(id => ({ id, familyId: id === foreignBabyId ? foreignFamilyId : familyId, firstName: 'Synthetic', lastName: 'Photo fixture', birthDate: at })) });
  await db.caretaker.create({ data: { id: caretakerId, familyId, name: 'Synthetic photo caregiver', loginId: '41', securityPin: '123456', role: 'USER' } });
  await db.food.create({ data: { id: 'synthetic-photo-food', familyId, name: 'Synthetic food' } });
  png = await sharp({ create: { width: 12, height: 10, channels: 3, background: { r: 20, g: 100, b: 150 } } }).png().toBuffer();
}, 90_000);

beforeEach(async () => {
  await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS synthetic_photo_link_failure');
  await db.photoLink.deleteMany(); await db.photoFavorite.deleteMany(); await db.photo.deleteMany();
  await db.photoLog.deleteMany(); await db.milestone.deleteMany(); await db.feedLog.deleteMany();
  await db.bathLog.deleteMany(); await db.playLog.deleteMany(); await db.measurement.deleteMany(); await db.foodLog.deleteMany(); await db.diaperLog.deleteMany();
  await db.baby.updateMany({ data: { deletedAt: null } });
  await db.appConfig.updateMany({ data: { enablePhotos: true } });
  rmSync(fileDir, { recursive: true, force: true });
  const owner = { familyId, babyId, caretakerId };
  await db.photoLog.create({ data: { ...owner, id: 'target-photo', time: at } });
  await db.feedLog.create({ data: { ...owner, id: 'target-feed', time: at, type: 'BOTTLE' } });
  await db.milestone.createMany({ data: [
    { id: 'target-milestone', ...owner }, { id: 'sibling-milestone', ...owner, babyId: siblingId },
    { id: 'foreign-milestone', familyId: foreignFamilyId, babyId: foreignBabyId },
    { id: 'removed-milestone', ...owner, deletedAt: at }, { id: 'unknown-milestone', ...owner, familyId: null },
  ].map(value => ({ ...value, date: at, title: 'Synthetic milestone', category: 'MOTOR' as const })) });
  await db.bathLog.create({ data: { ...owner, id: 'target-bath', time: at } });
  await db.playLog.create({ data: { ...owner, id: 'target-play', startTime: at, type: 'TUMMY_TIME' } });
  await db.measurement.create({ data: { ...owner, id: 'target-measurement', date: at, type: 'WEIGHT', value: 4, unit: 'kg' } });
  await db.foodLog.create({ data: { ...owner, id: 'target-foodLog', time: at, foodId: 'synthetic-photo-food' } });
  await db.diaperLog.create({ data: { ...owner, id: 'target-diaper', time: at, type: 'WET' } });
  await db.photo.createMany({ data: [
    ...Array.from({ length: 7 }, (_, index) => ({ id: 'photo-' + index, ...owner })),
    { id: 'sibling-photo', ...owner, babyId: siblingId }, { id: 'foreign-photo', familyId: foreignFamilyId, babyId: foreignBabyId },
    { id: 'unknown-photo', ...owner, familyId: null }, { id: 'trashed-photo', ...owner, deletedAt: at },
  ].map(value => ({ ...value, originalName: 'synthetic.png', storedName: value.id + '.enc', thumbStoredName: value.id + '-thumb.enc', mimeType: 'image/png', fileSize: 1, thumbSize: 1, takenAt: at, caption: 'Synthetic caption' })) });
});

afterAll(async () => {
  await db?.$disconnect(); if (directory) rmSync(directory, { recursive: true, force: true });
  rmSync(fileDir, { recursive: true, force: true });
  if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
  if (previousKey === undefined) delete process.env.ENC_HASH; else process.env.ENC_HASH = previousKey;
});

describe('photo attachment writers with real authorization and migrated SQLite', () => {
  it.each(PHOTO_ACTIVITY_TYPES)('%s accepts its own child and rejects sibling/foreign/null/trash photos without partial writes', async type => {
    for (const photoId of ['sibling-photo', 'foreign-photo', 'unknown-photo', 'trashed-photo']) {
      const before = await snapshot();
      expect((await link(photoId, type)).status).toBe(404);
      expect(await snapshot()).toEqual(before);
    }
    const family = await db.family.findUniqueOrThrow({ where: { id: familyId } });
    expect((await link('photo-0', type)).status).toBe(200);
    expect(await db.photoLink.findMany()).toEqual([expect.objectContaining({ photoId: 'photo-0', ...ref(type) })]);
    expect(await db.family.findUniqueOrThrow({ where: { id: familyId } })).toEqual(family);
  });

  it.each(['sibling-milestone', 'foreign-milestone', 'removed-milestone', 'unknown-milestone', 'missing-milestone'])(
    'rejects %s through direct links, upload tags and photo PATCH', async milestoneId => {
      const before = await snapshot();
      expect((await attach(request('POST', 'photos/links', { photoId: 'photo-0', activityType: 'milestone', activityId: milestoneId }))).status).toBe(404);
      expect((await patchPhoto(request('PATCH', 'photos/photo-0', { caption: 'Must not save', milestoneId }))).status).toBe(404);
      const response = await upload(milestoneId);
      if (response.status === 200) { const data = (await response.json()).data; expect(data.photos).toEqual([]); expect(data.errors).toHaveLength(1); }
      else expect(response.status).toBe(404);
      expect(await snapshot()).toEqual(before);
    },
  );

  it('rejects new links and uploads after the owner child is removed', async () => {
    await db.baby.update({ where: { id: babyId }, data: { deletedAt: at } });
    const before = await snapshot();
    expect((await link('photo-0')).status).toBe(404);
    expect((await upload(null)).status).toBe(404);
    expect((await createPhotoLog(request('POST', 'photo-log', { babyId, time: at.toISOString(), photoIds: ['photo-0'] }))).status).toBe(404);
    expect(await snapshot()).toEqual(before);
  });

  it('counts retained trash and scalar-only tags while duplicate links succeed unchanged at the four-photo cap', async () => {
    for (const photoId of ['photo-0', 'photo-1', 'trashed-photo']) await db.photoLink.create({ data: { photoId, ...ref('milestone') } });
    await db.photo.update({ where: { id: 'photo-2' }, data: { milestoneId: 'target-milestone' } });
    const before = await snapshot();
    expect((await link('photo-0')).status).toBe(200);
    expect(await snapshot()).toEqual(before);
    expect((await link('photo-3')).status).toBe(400);
    expect((await patchPhoto(request('PATCH', 'photos/photo-3', { caption: 'Must not save', milestoneId: 'target-milestone' }))).status).toBe(400);
    expect(await snapshot()).toEqual(before);
    const uploaded = await upload(); expect(uploaded.status).toBe(200);
    expect((await uploaded.json()).data).toMatchObject({ photos: [], errors: [expect.objectContaining({ index: 0 })] });
    expect(await snapshot()).toEqual(before);
    expect((await link('photo-2')).status).toBe(200); // Completes its explicitly requested, already reserved edge.
    expect(await db.photoLink.count()).toBe(4);
  });

  it('switches milestone tags atomically and tolerates an already present manual destination edge', async () => {
    await db.milestone.create({ data: { id: 'second-milestone', familyId, babyId, date: at, title: 'Synthetic second', category: 'MOTOR' } });
    await db.photo.update({ where: { id: 'photo-0' }, data: { milestoneId: 'target-milestone' } });
    await db.photoLink.createMany({ data: [ref('milestone'), { activityType: 'milestone', activityId: 'second-milestone' }].map(value => ({ ...value, photoId: 'photo-0' })) });
    const photo = await db.photo.findUniqueOrThrow({ where: { id: 'photo-0' } });
    const destination = await db.photoLink.findFirstOrThrow({ where: { photoId: photo.id, activityId: 'second-milestone' } });
    const response = await patchPhoto(request('PATCH', 'photos/photo-0', { milestoneId: 'second-milestone' }));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ milestoneId: 'second-milestone', takenAt: at.toISOString(), caption: photo.caption });
    expect(await db.photoLink.findMany()).toEqual([destination]);
  });

  it('preserves hidden and trashed PhotoLog links during visible-set replacement and does not reset retained link timestamps', async () => {
    for (const photoId of ['photo-0', 'sibling-photo', 'foreign-photo', 'trashed-photo']) await db.photoLink.create({ data: { photoId, ...ref('photo') } });
    const before = await snapshot();
    const replacement = await updatePhotoLog(request('PUT', 'photo-log?id=target-photo', { photoIds: ['photo-1'] }));
    expect(replacement.status).toBe(200);
    expect((await replacement.json()).data).toMatchObject({ retainedLinkCount: 4, photos: [expect.objectContaining({ id: 'photo-1' })] });
    for (const old of before.links.filter(row => row.photoId !== 'photo-0')) expect(await db.photoLink.findUnique({ where: { id: old.id } })).toEqual(old);
    const current = await snapshot();
    expect((await updatePhotoLog(request('PUT', 'photo-log?id=target-photo', { photoIds: ['photo-1', 'photo-2'] }))).status).toBe(400);
    expect(await snapshot()).toEqual(current);
    const unchangedLinks = current.links;
    expect((await updatePhotoLog(request('PUT', 'photo-log?id=target-photo', { time: at.toISOString() }))).status).toBe(200);
    expect(await db.photoLink.findMany({ orderBy: { id: 'asc' } })).toEqual(unchangedLinks);
  });

  it.each(['sibling-photo', 'foreign-photo', 'unknown-photo', 'trashed-photo'])('PhotoLog creation and replacement reject %s atomically', async photoId => {
    const before = await snapshot();
    expect((await createPhotoLog(request('POST', 'photo-log', { babyId, time: at.toISOString(), photoIds: ['photo-0', photoId] }))).status).toBe(404);
    expect((await updatePhotoLog(request('PUT', 'photo-log?id=target-photo', { time: '2026-11-02T00:00:00Z', photoIds: [photoId] }))).status).toBe(404);
    expect(await snapshot()).toEqual(before);
  });

  it('creates a PhotoLog with exact attribution/time and idempotently preserves the same replacement edges', async () => {
    const response = await createPhotoLog(request('POST', 'photo-log', { babyId, time: at.toISOString(), photoIds: ['photo-0', 'photo-1'] }));
    expect(response.status).toBe(200);
    const row = (await response.json()).data;
    expect(row).toMatchObject({ babyId, familyId, caretakerId, time: at.toISOString(), retainedLinkCount: 2 });
    const edges = await db.photoLink.findMany({ orderBy: { id: 'asc' } });
    expect((await updatePhotoLog(request('PUT', `photo-log?id=${row.id}`, { photoIds: ['photo-0', 'photo-1'] }))).status).toBe(200);
    expect(await db.photoLink.findMany({ orderBy: { id: 'asc' } })).toEqual(edges);
  });

  it('explicitly removes an empty PhotoLog visible set while preserving hidden reservations and rejects an empty creation', async () => {
    for (const photoId of ['photo-0', 'sibling-photo', 'trashed-photo']) await db.photoLink.create({ data: { photoId, ...ref('photo') } });
    const hidden = await db.photoLink.findMany({ where: { photoId: { not: 'photo-0' } }, orderBy: { id: 'asc' } });
    const photos = await db.photo.findMany({ orderBy: { id: 'asc' } });
    const response = await updatePhotoLog(request('PUT', 'photo-log?id=target-photo', { photoIds: [] }));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ photos: [], retainedLinkCount: 2 });
    expect(await db.photoLink.findMany({ orderBy: { id: 'asc' } })).toEqual(hidden);
    expect(await db.photo.findMany({ orderBy: { id: 'asc' } })).toEqual(photos);
    const before = await snapshot();
    expect((await createPhotoLog(request('POST', 'photo-log', { babyId, time: at.toISOString(), photoIds: [] }))).status).toBe(400);
    expect((await updatePhotoLog(request('PUT', 'photo-log?id=target-photo', { photoIds: [] }))).status).toBe(200);
    expect(await snapshot()).toEqual(before);
  });

  it('caption-only changes preserve invalid historical milestone tags and links without projecting their metadata', async () => {
    await db.photo.update({ where: { id: 'photo-0' }, data: { milestoneId: 'sibling-milestone' } });
    await db.photoLink.create({ data: { photoId: 'photo-0', activityType: 'milestone', activityId: 'sibling-milestone' } });
    const before = await snapshot();
    const response = await patchPhoto(request('PATCH', 'photos/photo-0', { caption: 'Edited synthetic caption' }));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ caption: 'Edited synthetic caption', milestoneId: null, milestoneTitle: null, unavailableMilestone: true, links: [], unavailableLinkIds: [before.links[0].id] });
    const after = await snapshot();
    expect(after.links).toEqual(before.links);
    const oldPhoto = before.photos.find(photo => photo.id === 'photo-0')!;
    const newPhoto = after.photos.find(photo => photo.id === 'photo-0')!;
    expect(newPhoto).toEqual({ ...oldPhoto, caption: 'Edited synthetic caption', updatedAt: newPhoto.updatedAt });
  });

  it('explicitly detaches owned malformed opaque links, keeps other links, and clears scalar-only tags by exact triple', async () => {
    const malformed = await db.photoLink.create({ data: { photoId: 'photo-0', activityType: 'legacy-unsupported', activityId: 'unresolved-target' } });
    const retained = await db.photoLink.create({ data: { photoId: 'photo-0', activityType: 'milestone', activityId: 'sibling-milestone' } });
    const beforePhoto = await db.photo.findUniqueOrThrow({ where: { id: 'photo-0' } });
    for (let i = 0; i < 2; i++) expect((await detach(request('DELETE', `photos/links?photoId=photo-0&linkId=${malformed.id}`))).status).toBe(200);
    expect(await db.photoLink.findMany()).toEqual([retained]);
    expect(await db.photo.findUniqueOrThrow({ where: { id: 'photo-0' } })).toEqual(beforePhoto);
    await db.photo.update({ where: { id: 'photo-0' }, data: { milestoneId: 'sibling-milestone' } });
    expect((await detach(request('DELETE', `photos/links?photoId=photo-0&linkId=${retained.id}`))).status).toBe(200);
    expect((await db.photo.findUniqueOrThrow({ where: { id: 'photo-0' } })).milestoneId).toBeNull();
    await db.photo.update({ where: { id: 'photo-0' }, data: { milestoneId: 'target-milestone' } });
    expect((await detach(request('DELETE', 'photos/links?photoId=photo-0&activityType=milestone&activityId=target-milestone'))).status).toBe(200);
    expect((await db.photo.findUniqueOrThrow({ where: { id: 'photo-0' } })).milestoneId).toBeNull();
    const before = await snapshot();
    expect((await detach(request('DELETE', 'photos/links?photoId=foreign-photo&linkId=arbitrary'))).status).toBe(404);
    expect((await detach(request('DELETE', 'photos/links?photoId=unknown-photo&linkId=arbitrary'))).status).toBe(404);
    expect(await snapshot()).toEqual(before);
  });

  it('rejects malformed input, missing authentication and missing family before persistence', async () => {
    const before = await snapshot();
    expect((await attach(request('POST', 'photos/links', { photoId: 'photo-0', ...ref('milestone') }, familyId, false))).status).toBe(401);
    expect((await attach(request('POST', 'photos/links', { photoId: 'photo-0', ...ref('milestone') }, null))).status).toBe(403);
    for (const body of [null, [], { photoId: { not: null }, ...ref('milestone') }, { photoId: 'photo-0', ...ref('milestone'), familyId: foreignFamilyId }]) {
      expect((await attach(request('POST', 'photos/links', body))).status).toBe(400);
    }
    for (const body of [{ milestoneId: { set: 'target-milestone' } }, { caption: false }, { takenAt: 'invalid' }]) {
      expect((await patchPhoto(request('PATCH', 'photos/photo-0', body))).status).toBe(400);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back a failed upload link and cleans its new encrypted files before a later successful upload', async () => {
    await db.$executeRawUnsafe('CREATE TRIGGER synthetic_photo_link_failure BEFORE INSERT ON "PhotoLink" BEGIN SELECT RAISE(ABORT, \'synthetic write failure\'); END');
    const before = await snapshot();
    const failed = await upload(); expect(failed.status).toBe(200);
    expect((await failed.json()).data).toMatchObject({ photos: [], errors: [expect.objectContaining({ index: 0 })] });
    expect(await snapshot()).toEqual(before);
    await db.$executeRawUnsafe('DROP TRIGGER synthetic_photo_link_failure');
    const success = await upload(); expect(success.status).toBe(200);
    const data = (await success.json()).data;
    expect(data.errors).toEqual([]); expect(data.photos).toHaveLength(1); expect(fileSnapshot()).toHaveLength(2);
    expect(data.photos[0]).toMatchObject({ babyId, caretakerId, milestoneId: 'target-milestone', takenAt: at.toISOString() });
  });

  it('commits only the available upload slot in a partial batch and removes the rejected file pair', async () => {
    for (const photoId of ['photo-0', 'photo-1', 'photo-2']) await db.photoLink.create({ data: { photoId, ...ref('milestone') } });
    const beforePhotos = await db.photo.count();
    const response = await upload('target-milestone', babyId, 2);
    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    expect(data.photos).toHaveLength(1); expect(data.errors).toHaveLength(1); expect(data.errors[0].index).toBe(1);
    expect(await db.photo.count()).toBe(beforePhotos + 1); expect(await db.photoLink.count()).toBe(4);
    expect(fileSnapshot()).toHaveLength(2);
  });

  it('cleans files when the integrity transaction rejects before its callback starts', async () => {
    const before = await snapshot();
    const transaction = vi.spyOn(db, '$transaction').mockRejectedValueOnce(new Error('Synthetic transaction rejected before callback'));
    let response: Response;
    try { response = await upload(); } finally { transaction.mockRestore(); }
    expect(response!.status).toBe(200);
    expect((await response!.json()).data).toMatchObject({ photos: [], errors: [expect.objectContaining({ index: 0 })] });
    expect(await snapshot()).toEqual(before);
  });

  it('retains encrypted bytes after an injected lost acknowledgement of a real committed upload', async () => {
    const execute = db.$transaction.bind(db);
    const transaction = vi.spyOn(db, '$transaction').mockImplementationOnce(async (callback, options) => {
      await execute(callback, options);
      throw new Error('Synthetic acknowledgement lost after commit');
    });
    let response: Response;
    try { response = await upload(); } finally { transaction.mockRestore(); }
    expect(response!.status).toBe(200);
    expect((await response!.json()).data).toMatchObject({ photos: [], errors: [expect.objectContaining({ index: 0 })] });
    const committed = await db.photo.findMany({ where: { originalName: 'synthetic-0.png' } });
    expect(committed).toHaveLength(1); expect(committed[0].milestoneId).toBe('target-milestone');
    expect(await db.photoLink.findMany()).toEqual([expect.objectContaining({ photoId: committed[0].id, ...ref('milestone') })]);
    expect(fileSnapshot().map(([name]) => name).sort()).toEqual([committed[0].storedName, committed[0].thumbStoredName].sort());
  });

  it('keeps reserved links through trash/restore and only cascades them on explicit purge', async () => {
    expect((await link('photo-0')).status).toBe(200);
    const edge = await db.photoLink.findFirstOrThrow();
    expect((await trashPhoto(request('DELETE', 'photos/photo-0'))).status).toBe(200);
    expect(await db.photoLink.findUnique({ where: { id: edge.id } })).toEqual(edge);
    expect((await restorePhoto(request('POST', 'photos/photo-0/restore'))).status).toBe(200);
    expect(await db.photoLink.findUnique({ where: { id: edge.id } })).toEqual(edge);
    expect((await bulkPhoto(request('POST', 'photos/bulk', { action: 'trash', ids: ['photo-0'] }))).status).toBe(200);
    expect((await bulkPhoto(request('POST', 'photos/bulk', { action: 'purge', ids: ['photo-0'] }))).status).toBe(200);
    expect(await db.photo.findUnique({ where: { id: 'photo-0' } })).toBeNull(); expect(await db.photoLink.count()).toBe(0);
  });

  it('PhotoLog deletion preserves photos and rejects malformed references before deleting anything', async () => {
    await db.photoLink.create({ data: { photoId: 'sibling-photo', ...ref('photo') } });
    const before = await snapshot();
    expect((await deletePhotoLog(request('DELETE', 'photo-log?id=target-photo'))).status).toBe(409);
    expect(await snapshot()).toEqual(before);
    expect((await detach(request('DELETE', 'photos/links?photoId=sibling-photo&activityType=photo&activityId=target-photo'))).status).toBe(200);
    expect((await link('photo-0', 'photo')).status).toBe(200);
    const photos = await db.photo.findMany({ orderBy: { id: 'asc' } });
    expect((await deletePhotoLog(request('DELETE', 'photo-log?id=target-photo'))).status).toBe(200);
    expect((await db.photoLog.findUniqueOrThrow({ where: { id: 'target-photo' } })).deletedAt).toBeInstanceOf(Date);
    expect(await db.photoLink.count()).toBe(0); expect(await db.photo.findMany({ orderBy: { id: 'asc' } })).toEqual(photos);
  });
});
