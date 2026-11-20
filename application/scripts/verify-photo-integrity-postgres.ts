/** Authenticated production routes and real overlapping writers on disposable PostgreSQL only. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';
import type { PrismaClient } from '@prisma/client';
import { PHOTO_ACTIVITY_TYPES } from '../app/api/photos/photo-ownership';
import { PHOTO_RACE_CASES, runPhotoRace } from './photo-integrity-concurrency';

const runId = randomUUID(), familyId = 'synthetic-photo-pg-' + runId, foreignFamilyId = 'synthetic-photo-pg-foreign-' + runId;
const babyId = familyId + '-baby', siblingId = familyId + '-sibling', foreignBabyId = foreignFamilyId + '-baby';
const caretakerId = familyId + '-carer', foreignCaretakerId = foreignFamilyId + '-carer';
const reportDir = path.join(process.cwd(), 'test-results'), reportPath = path.join(reportDir, 'photo-integrity-postgres-report.json');
const fileDirs = [familyId, foreignFamilyId].map(id => path.join(process.cwd(), 'Files/photos', id));
const at = new Date('2026-11-01T12:34:56.789Z');
const report = {
  runId, syntheticOnly: true, provider: 'postgresql', gitRevision: null as string | null,
  startedAt: new Date().toISOString(), completedAt: null as string | null, serverVersion: null as string | null,
  status: 'FAIL' as 'PASS' | 'FAIL', authentication: 'Actual production PIN authentication and JWT route middleware',
  scope: 'Eight photo target types, encrypted upload writers, retained capacity, safe reads/repair, production lifecycle guards, and nine independent-process PostgreSQL lock races. No production or full-installation restore acceptance.',
  checks: [] as { name: string; status: 'PASS' | 'FAIL'; error?: string }[],
  races: [] as Awaited<ReturnType<typeof runPhotoRace>>[], errors: [] as string[],
  cleanup: { attempted: false, ownedFixturesRemoved: false, ownedFilesRemoved: false, clientsClosed: false, errors: [] as string[] },
};
const safeError = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/postgres(?:ql)?:\/\/[^\s"']+/g, 'postgresql://[synthetic URL redacted]');
async function check(name: string, action: () => Promise<void>) {
  try { await action(); report.checks.push({ name, status: 'PASS' }); }
  catch (error) { report.checks.push({ name, status: 'FAIL', error: safeError(error) }); throw error; }
}
async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' exceeded its deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}
const fileSnapshot = () => fileDirs.flatMap(directory => existsSync(directory) ? readdirSync(directory).sort().map(name => ({
  file: path.basename(directory) + '/' + name, sha256: createHash('sha256').update(readFileSync(path.join(directory, name))).digest('hex'),
})) : []);

async function main() {
  let db: PrismaClient | undefined, logDb: { $disconnect(): Promise<void> } | undefined, ownsFixtures = false;
  try {
    assert.equal(process.env.SAT_TRACKER_SYNTHETIC_TEST, '1');
    assert.equal(process.env.DATABASE_PROVIDER, 'postgresql');
    const url = new URL(process.env.DATABASE_URL ?? '');
    assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/sat_tracker_photo_test');
    assert.ok(url.search === '' || url.search === '?schema=public');
    assert.match(readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8'), /datasource\s+db\s*\{\s*provider\s*=\s*"postgresql"/);
    report.gitRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 }).trim();
    process.env.JWT_SECRET = randomBytes(32).toString('hex'); process.env.ENC_HASH = randomBytes(32).toString('hex');
    process.env.DEPLOYMENT_MODE = 'selfhosted'; process.env.ENABLE_LOG = 'false'; process.env.ENABLE_NOTIFICATIONS = 'false';
    process.env.LOG_DATABASE_URL = url.toString();
    const { PrismaClient } = await import('@prisma/client');
    const { createPrismaAdapter } = await import('../prisma/prisma-adapter');
    db = new PrismaClient({ adapter: createPrismaAdapter(url.toString()) });
    (globalThis as Record<string, unknown>).__sprout_prisma = db;
    const prisma = db;
    await check('Guarded empty PostgreSQL target accepts the current schema with no migration/provider substitutions', async () => {
      const current = await prisma.$queryRaw<{ name: string; version: string }[]>`SELECT current_database() AS name, version() AS version`;
      assert.equal(current[0].name, 'sat_tracker_photo_test'); report.serverVersion = current[0].version;
      assert.deepEqual(await prisma.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`, []);
      execFileSync(process.execPath, [path.join(process.cwd(), 'node_modules/prisma/build/index.js'), 'db', 'push'], {
        cwd: process.cwd(), env: process.env, stdio: 'pipe', timeout: 60_000,
      });
    });
    const loginRoute = await import('../app/api/auth/route');
    const linksRoute = await import('../app/api/photos/links/route');
    const photoRoute = await import('../app/api/photos/[id]/route');
    const uploadRoute = await import('../app/api/photos/upload/route');
    const photoLogRoute = await import('../app/api/photo-log/route');
    const attachmentRoute = await import('../app/api/photos/attachments/route');
    const galleryRoute = await import('../app/api/photos/route');
    const milestoneRoute = await import('../app/api/milestone-log/route');
    logDb = (await import('../prisma/log-db')).default;
    const png = await sharp({ create: { width: 16, height: 12, channels: 3, background: { r: 22, g: 120, b: 155 } } }).png().toBuffer();
    const tokens: Record<string, string> = {};
    const req = (method: string, route: string, body?: unknown, family = familyId) => new NextRequest('http://localhost/api/' + route, {
      method, headers: { Authorization: 'Bearer ' + tokens[family], 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const readBody = async (response: Response, expected = 200) => { const body = await response.json(); assert.equal(response.status, expected, JSON.stringify(body)); return body; };
    const snapshot = async () => ({
      families: await prisma.family.findMany({ orderBy: { id: 'asc' } }), babies: await prisma.baby.findMany({ orderBy: { id: 'asc' } }),
      photos: await prisma.photo.findMany({ orderBy: { id: 'asc' } }), links: await prisma.photoLink.findMany({ orderBy: { id: 'asc' } }),
      milestones: await prisma.milestone.findMany({ orderBy: { id: 'asc' } }), logs: await prisma.photoLog.findMany({ orderBy: { id: 'asc' } }), files: fileSnapshot(),
    });
    const upload = async (count = 1, options: { child?: string; milestoneId?: string; family?: string } = {}) => {
      const form = new FormData(); form.append('babyId', options.child ?? babyId); form.append('takenAt', at.toISOString());
      if (options.milestoneId) form.append('milestoneId', options.milestoneId);
      for (let index = 0; index < count; index++) form.append('files', new File([new Uint8Array(png)], `synthetic-pg-${index}.png`, { type: 'image/png' }));
      return uploadRoute.POST(new NextRequest('http://localhost/api/photos/upload', { method: 'POST',
        headers: { Authorization: 'Bearer ' + tokens[options.family ?? familyId] }, body: form }));
    };
    const milestone = (id: string, child = babyId, family = familyId) => prisma.milestone.create({ data: {
      id, familyId: family, babyId: child, date: at, title: 'Synthetic private milestone ' + id, category: 'MOTOR',
    } });
    let photos: string[] = [], siblingPhoto = '', foreignPhoto = '';
    await check('Real PIN-authenticated uploads store encrypted owned images for both family and sibling controls', async () => {
      await prisma.appConfig.create({ data: { id: 'synthetic-photo-config-' + runId,
        adminPass: 'synthetic-unused-password', rootDomain: 'synthetic.invalid', enablePhotos: true } });
      await prisma.unit.create({ data: { unitAbbr: 'ML', unitName: 'Milliliters' } });
      await prisma.family.createMany({ data: [{ id: familyId, slug: 'photo-pg-' + runId }, { id: foreignFamilyId, slug: 'photo-f-' + runId }]
        .map(value => ({ ...value, name: 'Synthetic photo PostgreSQL family', setupStage: 3 })) }); ownsFixtures = true;
      await prisma.baby.createMany({ data: [babyId, siblingId, foreignBabyId].map(id => ({ id, familyId: id === foreignBabyId ? foreignFamilyId : familyId,
        firstName: 'Synthetic', lastName: 'Photo fixture', birthDate: at })) });
      for (const [family, id] of [[familyId, caretakerId], [foreignFamilyId, foreignCaretakerId]]) {
        await prisma.caretaker.create({ data: { id, familyId: family, name: 'Synthetic Photo Reviewer', loginId: '43', securityPin: '684239', role: 'USER', type: 'parent' } });
        await prisma.settings.create({ data: { familyId: family, familyName: 'Synthetic photo PostgreSQL family', authType: 'CARETAKER' } });
        const owned = await prisma.family.findUniqueOrThrow({ where: { id: family } });
        const body = await readBody(await loginRoute.POST(new NextRequest('http://localhost/api/auth', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ familySlug: owned.slug, loginId: '43', securityPin: '684239' }),
        })));
        assert.equal(body.data.id, id); assert.equal(body.data.role, 'USER');
        assert.equal((jwt.verify(body.data.token, process.env.JWT_SECRET!) as jwt.JwtPayload).familyId, family);
        tokens[family] = body.data.token;
      }
      for (const count of [4, 3]) {
        const body = await readBody(await upload(count)); assert.deepEqual(body.data.errors, []); photos.push(...body.data.photos.map((photo: { id: string }) => photo.id));
      }
      siblingPhoto = (await readBody(await upload(1, { child: siblingId }))).data.photos[0].id;
      foreignPhoto = (await readBody(await upload(1, { child: foreignBabyId, family: foreignFamilyId }))).data.photos[0].id;
      assert.equal(fileSnapshot().length, 18);
      for (const photo of await prisma.photo.findMany()) {
        const content = readFileSync(path.join(process.cwd(), 'Files/photos', photo.familyId!, photo.storedName));
        assert.notDeepEqual(content, png); assert.equal(content.length, photo.fileSize + 32);
      }
    });
    await check('All eight authenticated target writers enforce family, child and live state with atomic PhotoLog validation', async () => {
      const owner = { familyId, babyId, caretakerId };
      await prisma.food.create({ data: { id: familyId + '-food', familyId, name: 'Synthetic photo food' } });
      await prisma.photoLog.create({ data: { ...owner, id: 'pg-target-photo', time: at } });
      await prisma.feedLog.create({ data: { ...owner, id: 'pg-target-feed', time: at, type: 'BOTTLE' } });
      await milestone('pg-target-milestone');
      await prisma.bathLog.create({ data: { ...owner, id: 'pg-target-bath', time: at } });
      await prisma.playLog.create({ data: { ...owner, id: 'pg-target-play', startTime: at, type: 'TUMMY_TIME' } });
      await prisma.measurement.create({ data: { ...owner, id: 'pg-target-measurement', date: at, type: 'WEIGHT', value: 4, unit: 'kg' } });
      await prisma.foodLog.create({ data: { ...owner, id: 'pg-target-foodLog', time: at, foodId: familyId + '-food' } });
      await prisma.diaperLog.create({ data: { ...owner, id: 'pg-target-diaper', time: at, type: 'WET' } });
      for (const activityType of PHOTO_ACTIVITY_TYPES) {
        const ref = { activityType, activityId: 'pg-target-' + activityType };
        for (const photoId of [siblingPhoto, foreignPhoto]) {
          const before = await snapshot(); await readBody(await linksRoute.POST(req('POST', 'photos/links', { photoId, ...ref })), 404); assert.deepEqual(await snapshot(), before);
        }
        await readBody(await linksRoute.POST(req('POST', 'photos/links', { photoId: photos[0], ...ref })));
      }
      for (const target of [await milestone('pg-sibling-target', siblingId), await milestone('pg-foreign-target', foreignBabyId, foreignFamilyId)]) {
        const before = await snapshot();
        await readBody(await photoRoute.PATCH(req('PATCH', 'photos/' + photos[1], { caption: 'Must not save', milestoneId: target.id })), 404);
        const badUpload = await upload(1, { milestoneId: target.id });
        if (badUpload.status === 200) { const body = await badUpload.json(); assert.equal(body.data.photos.length, 0); assert.equal(body.data.errors.length, 1); }
        else assert.equal(badUpload.status, 404);
        assert.deepEqual(await snapshot(), before);
      }
      for (const photoId of [siblingPhoto, foreignPhoto]) {
        const before = await snapshot();
        await readBody(await photoLogRoute.POST(req('POST', 'photo-log', { babyId, time: at.toISOString(), photoIds: [photos[0], photoId] })), 404);
        await readBody(await photoLogRoute.PUT(req('PUT', 'photo-log?id=pg-target-photo', { photoIds: [photoId], time: '2026-11-02T00:00:00Z' })), 404);
        assert.deepEqual(await snapshot(), before);
      }
      await prisma.baby.update({ where: { id: babyId }, data: { deletedAt: at } });
      const before = await snapshot(); await readBody(await linksRoute.POST(req('POST', 'photos/links', { photoId: photos[1], activityType: 'diaper', activityId: 'pg-target-diaper' })), 404);
      assert.deepEqual(await snapshot(), before); await prisma.baby.update({ where: { id: babyId }, data: { deletedAt: null } });
    });
    await check('Retained union capacity, exact retries and mixed route writers preserve tags, rows and encrypted files', async () => {
      const target = await milestone('pg-cap-target'), ref = { activityType: 'milestone', activityId: target.id };
      await prisma.photoLink.createMany({ data: photos.slice(0, 3).map(photoId => ({ photoId, ...ref })) });
      await prisma.photo.update({ where: { id: photos[2] }, data: { deletedAt: at } });
      await prisma.photo.update({ where: { id: photos[3] }, data: { milestoneId: target.id } });
      const before = await snapshot();
      await readBody(await linksRoute.POST(req('POST', 'photos/links', { photoId: photos[0], ...ref })));
      assert.deepEqual(await snapshot(), before);
      await readBody(await linksRoute.POST(req('POST', 'photos/links', { photoId: photos[4], ...ref })), 400);
      await readBody(await photoRoute.PATCH(req('PATCH', 'photos/' + photos[4], { caption: 'Rejected draft', milestoneId: target.id })), 400);
      const rejected = await readBody(await upload(1, { milestoneId: target.id })); assert.deepEqual(rejected.data.photos, []); assert.equal(rejected.data.errors.length, 1);
      assert.deepEqual(await snapshot(), before);
      await readBody(await linksRoute.POST(req('POST', 'photos/links', { photoId: photos[3], ...ref })));
      const mixed = await milestone('pg-mixed-target');
      await prisma.photoLink.createMany({ data: [photos[0], photos[1], photos[3]].map(photoId => ({ photoId, activityType: 'milestone', activityId: mixed.id })) });
      const countBefore = await prisma.photo.count(), filesBefore = fileSnapshot().length;
      const results = await Promise.all([
        linksRoute.POST(req('POST', 'photos/links', { photoId: photos[4], activityType: 'milestone', activityId: mixed.id })),
        photoRoute.PATCH(req('PATCH', 'photos/' + photos[5], { caption: 'Only if tagged', milestoneId: mixed.id })),
        upload(1, { milestoneId: mixed.id }),
      ]);
      const bodies = await Promise.all(results.map(result => result.json()));
      assert.equal(Number(results[0].status === 200) + Number(results[1].status === 200) + bodies[2].data.photos.length, 1);
      assert.equal(await prisma.photoLink.count({ where: { activityType: 'milestone', activityId: mixed.id } }), 4);
      assert.equal(await prisma.photo.count(), countBefore + bodies[2].data.photos.length);
      assert.equal(fileSnapshot().length, filesBefore + bodies[2].data.photos.length * 2);
      if (results[1].status !== 200) assert.equal((await prisma.photo.findUniqueOrThrow({ where: { id: photos[5] } })).caption, null);
      await prisma.photo.update({ where: { id: photos[2] }, data: { deletedAt: null } });
    });
    await check('Hidden historical links are sanitized, reserved and repaired only by the owning photo identity', async () => {
      const target = await milestone('pg-hidden-foreign', foreignBabyId, foreignFamilyId);
      await prisma.photo.update({ where: { id: photos[6] }, data: { milestoneId: target.id } });
      const edge = await prisma.photoLink.create({ data: { photoId: photos[6], activityType: 'milestone', activityId: target.id } });
      const direct = await readBody(await photoRoute.GET(req('GET', 'photos/' + photos[6])));
      assert.equal(direct.data.milestoneId, null); assert.equal(direct.data.milestoneTitle, null); assert.equal(direct.data.unavailableMilestone, true);
      assert.deepEqual(direct.data.unavailableLinkIds, [edge.id]); assert.deepEqual(direct.data.links, []);
      const gallery = await readBody(await galleryRoute.GET(req('GET', 'photos?babyId=' + babyId)));
      assert.equal(JSON.stringify(gallery).includes(target.title), false);
      const before = await prisma.photoLink.findUniqueOrThrow({ where: { id: edge.id } });
      await readBody(await photoRoute.PATCH(req('PATCH', 'photos/' + photos[6], { caption: 'Own caption remains editable' })));
      assert.equal((await prisma.photo.findUniqueOrThrow({ where: { id: photos[6] } })).milestoneId, target.id);
      assert.deepEqual(await prisma.photoLink.findUniqueOrThrow({ where: { id: edge.id } }), before);
      await readBody(await linksRoute.DELETE(req('DELETE', `photos/links?photoId=${photos[6]}&linkId=${edge.id}`, undefined, foreignFamilyId)), 404);
      await readBody(await linksRoute.DELETE(req('DELETE', `photos/links?photoId=${photos[6]}&linkId=${edge.id}`)));
      assert.equal(await prisma.photoLink.findUnique({ where: { id: edge.id } }), null);
      assert.equal((await prisma.photo.findUniqueOrThrow({ where: { id: photos[6] } })).milestoneId, null);
      await readBody(await linksRoute.DELETE(req('DELETE', `photos/links?photoId=${photos[6]}&linkId=${edge.id}`)));
      const attachments = await readBody(await attachmentRoute.GET(req('GET', 'photos/attachments?activityType=milestone&activityId=pg-cap-target')));
      assert.equal(attachments.data.retainedLinkCount, 4); assert.equal(attachments.data.maxPhotos, 4);
      await readBody(await photoRoute.GET(req('GET', 'photos/' + photos[0], undefined, foreignFamilyId)), 404);
    });
    await check('Actual target routes block moves or malformed deletion and atomically preserve files on authorized deletion', async () => {
      const target = await milestone('pg-delete-target');
      const ref = { activityType: 'milestone', activityId: target.id };
      await prisma.photoLink.create({ data: { photoId: siblingPhoto, ...ref } });
      const before = await snapshot();
      await readBody(await milestoneRoute.PUT(req('PUT', 'milestone-log?id=' + target.id, { babyId: siblingId })), 409);
      await readBody(await milestoneRoute.DELETE(req('DELETE', 'milestone-log?id=' + target.id)), 409);
      assert.deepEqual(await snapshot(), before);
      await readBody(await linksRoute.DELETE(req('DELETE', `photos/links?photoId=${siblingPhoto}&activityType=milestone&activityId=${target.id}`)));
      await readBody(await photoRoute.PATCH(req('PATCH', 'photos/' + photos[6], { milestoneId: target.id })));
      const files = fileSnapshot(), photoCount = await prisma.photo.count();
      await readBody(await milestoneRoute.DELETE(req('DELETE', 'milestone-log?id=' + target.id)));
      assert.equal(await prisma.milestone.findUnique({ where: { id: target.id } }), null);
      assert.equal(await prisma.photoLink.count({ where: ref }), 0);
      assert.equal((await prisma.photo.findUniqueOrThrow({ where: { id: photos[6] } })).milestoneId, null);
      assert.equal(await prisma.photo.count(), photoCount); assert.deepEqual(fileSnapshot(), files);
    });
    for (const scenario of PHOTO_RACE_CASES) {
      await check(`Independent PostgreSQL overlap: ${scenario}, both lock orderings and post-contention committed writes`, async () => {
        report.races.push(await runPhotoRace(prisma, { databaseUrl: url.toString(), familyId, babyId, siblingId, caretakerId, scenario }));
      });
    }
    report.status = 'PASS';
  } catch (error) { report.errors.push(safeError(error)); }
  finally {
    report.cleanup.attempted = true;
    if (db && ownsFixtures) {
      try {
        const families = [familyId, foreignFamilyId];
        await db.$transaction(async tx => {
          await tx.photo.deleteMany({ where: { familyId: { in: families } } });
          await tx.foodLog.deleteMany({ where: { familyId: { in: families } } });
          await tx.food.deleteMany({ where: { familyId: { in: families } } });
          await tx.baby.deleteMany({ where: { familyId: { in: families } } });
          await tx.caretaker.deleteMany({ where: { familyId: { in: families } } });
          await tx.settings.deleteMany({ where: { familyId: { in: families } } });
          await tx.family.deleteMany({ where: { id: { in: families } } });
          await tx.appConfig.deleteMany({ where: { id: 'synthetic-photo-config-' + runId } });
          await tx.unit.deleteMany({ where: { unitAbbr: 'ML' } });
        }, { timeout: 15_000 });
        assert.equal(await db.family.count({ where: { id: { in: families } } }), 0);
        assert.equal(await db.photo.count({ where: { familyId: { in: families } } }), 0);
        report.cleanup.ownedFixturesRemoved = true;
      } catch (error) { report.cleanup.errors.push(safeError(error)); }
    }
    try {
      for (const directory of fileDirs) { assert.match(path.basename(directory), /^synthetic-photo-pg-/); rmSync(directory, { recursive: true, force: true }); assert.equal(existsSync(directory), false); }
      report.cleanup.ownedFilesRemoved = true;
    } catch (error) { report.cleanup.errors.push(safeError(error)); }
    try { await bounded(Promise.all([db?.$disconnect(), logDb?.$disconnect()]), 5000, 'Owned PostgreSQL client disconnect'); report.cleanup.clientsClosed = true; }
    catch (error) { report.cleanup.errors.push(safeError(error)); }
    if (report.errors.length || report.cleanup.errors.length || !report.cleanup.ownedFixturesRemoved) report.status = 'FAIL';
    report.completedAt = new Date().toISOString(); mkdirSync(reportDir, { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  }
}

// Route auth owns an hourly blacklist timer; exit only after every owned resource and report is finalized.
main().then(() => process.exit(report.status === 'PASS' ? 0 : 1), error => { console.error(safeError(error)); process.exit(1); });
