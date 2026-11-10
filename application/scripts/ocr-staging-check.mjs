// Run only inside the explicitly marked disposable OCR staging container.
// Credentials go to a private file; stdout/stderr contain only bounded metadata.
import { createRequire } from 'node:module';
import { randomInt, randomUUID, createHash } from 'node:crypto';
import { mkdir, open, readFile, lstat, rename, unlink } from 'node:fs/promises';

const BASE = 'http://127.0.0.1:3000';
const ACCESS = '/app/env/ocr-staging-access.json';
const FIXTURE = Object.freeze({ familyId: 'ocr-staging-family', familySlug: 'ocr-staging',
  babyId: 'ocr-staging-child', caretakerId: 'ocr-staging-caretaker', settingsId: 'ocr-staging-settings', loginId: '01' });
const report = { status: 'FAIL', syntheticOnly: true, checks: [], startedAt: new Date().toISOString() };
let db, phase = 'staging-guard', token;
const ensure = (condition, code) => { if (!condition) throw new Error(code); };
const checked = name => report.checks.push(name);

async function writeAccess(value) {
  const temporary = `${ACCESS}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  try { await rename(temporary, ACCESS); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  ensure(((await lstat(ACCESS)).mode & 0o777) === 0o600, 'PRIVATE_ACCESS_FILE_MODE');
}

async function jsonRequest(path, init = {}) {
  ensure(path.startsWith('/') && !path.startsWith('//'), 'LOOPBACK_PATH_REQUIRED');
  const response = await fetch(BASE + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(90_000),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers } });
  ensure(response.ok, `HTTP_${response.status}`);
  const body = await response.json();
  ensure(body.success === true && body.data !== undefined, 'HTTP_SUCCESS_ENVELOPE_REQUIRED');
  return body.data;
}
const jsonBody = value => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const counts = async () => ({ feed: await db.feedLog.count(), diaper: await db.diaperLog.count(), sleep: await db.sleepLog.count() });
async function requireNoCareWrites() {
  const value = await counts();
  ensure(value.feed === 0 && value.diaper === 0 && value.sleep === 0, 'UNEXPECTED_CARE_WRITES');
}
async function requireSyntheticBabies() {
  ensure(await db.baby.count({ where: { id: { not: FIXTURE.babyId } } }) === 0, 'NON_SYNTHETIC_BABY_PRESENT');
  const baby = await db.baby.findUnique({ where: { id: FIXTURE.babyId } });
  if (baby) ensure(baby.familyId === FIXTURE.familyId && baby.firstName === 'Synthetic' && baby.lastName === 'Fixture'
    && baby.birthDate.toISOString() === '2026-01-01T00:00:00.000Z' && !baby.deletedAt && !baby.inactive, 'FIXTURE_BABY_MISMATCH');
  return baby;
}

try {
  ensure(process.env.BABYTRACKER_SYNTHETIC_STAGING === 'true', 'SYNTHETIC_STAGING_FLAG_REQUIRED');
  ensure(process.env.BABYTRACKER_OCR_ENABLED === 'true', 'OCR_ENABLED_FLAG_REQUIRED');
  ensure(Boolean(process.env.DATABASE_URL?.trim()), 'EXPLICIT_DATABASE_URL_REQUIRED');
  const require = createRequire(import.meta.url);
  const { PrismaClient } = require('@prisma/client');
  const { createPrismaAdapter } = require('../prisma/prisma-adapter.js');
  const sharp = require('sharp');
  db = new PrismaClient({ adapter: createPrismaAdapter(process.env.DATABASE_URL), log: [] });
  phase = 'database-preflight';
  const existingBaby = await requireSyntheticBabies();
  const family = await db.family.findUnique({ where: { id: FIXTURE.familyId } });
  if (family) ensure(family.slug === FIXTURE.familySlug && family.name === 'Synthetic OCR staging' && family.isActive, 'FIXTURE_FAMILY_MISMATCH');
  ensure(!await db.family.findFirst({ where: { slug: FIXTURE.familySlug, id: { not: FIXTURE.familyId } } }), 'FIXTURE_SLUG_COLLISION');
  const caretaker = await db.caretaker.findUnique({ where: { id: FIXTURE.caretakerId } });
  if (caretaker) ensure(caretaker.familyId === FIXTURE.familyId && caretaker.loginId === FIXTURE.loginId
    && caretaker.role === 'ADMIN' && !caretaker.deletedAt && !caretaker.inactive, 'FIXTURE_CARETAKER_MISMATCH');
  ensure(await db.caretaker.count({ where: { familyId: FIXTURE.familyId, id: { not: FIXTURE.caretakerId } } }) === 0, 'UNEXPECTED_FIXTURE_CARETAKER');
  const settings = await db.settings.findMany({ where: { familyId: FIXTURE.familyId } });
  ensure(settings.length <= 1 && settings.every(value => value.id === FIXTURE.settingsId && value.authType === 'CARETAKER'), 'FIXTURE_SETTINGS_MISMATCH');
  ensure(Boolean(await db.unit.findUnique({ where: { unitAbbr: 'ML' } })), 'SEEDED_ML_UNIT_REQUIRED');
  ensure(await db.ocrDocument.count({ where: { OR: [{ babyId: { not: FIXTURE.babyId } }, { familyId: { not: FIXTURE.familyId } }] } }) === 0, 'NON_FIXTURE_DOCUMENT_PRESENT');
  const documents = await db.ocrDocument.findMany({ where: { babyId: FIXTURE.babyId, familyId: FIXTURE.familyId } });
  ensure(documents.length <= 1, 'MULTIPLE_FIXTURE_DOCUMENTS');
  if (!documents[0]?.committedAt) await requireNoCareWrites();
  checked('Explicit staging flags and synthetic-only database verified');

  // The generated fixture must contain actual glyphs on minimal Alpine images.
  // Copy this known font into staging before running; never accept empty text.
  phase = 'fixture-font-preflight';
  const fontPaths = ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf'];
  const fonts = await Promise.all(fontPaths.map(path => lstat(path).then(value => value.isFile() && value.size > 1000).catch(() => false)));
  ensure(fonts.some(Boolean), 'DEJAVU_SANS_FIXTURE_FONT_REQUIRED');
  checked('DejaVu Sans fixture font is available');

  phase = 'private-access-file';
  let access;
  try {
    const info = await lstat(ACCESS);
    ensure(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o600, 'UNSAFE_ACCESS_FILE');
    access = JSON.parse(await readFile(ACCESS, 'utf8'));
    ensure(access.version === 1 && Object.entries(FIXTURE).every(([key, value]) => access[key] === value)
      && /^\d{8}$/.test(access.securityPin), 'ACCESS_FILE_FIXTURE_MISMATCH');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    ensure(!caretaker && !documents.length, 'EXISTING_FIXTURE_REQUIRES_ACCESS_FILE');
    access = { version: 1, ...FIXTURE, securityPin: String(randomInt(10_000_000, 100_000_000)), baseUrl: BASE };
    await mkdir('/app/env', { recursive: true, mode: 0o700 });
    await writeAccess(access);
  }
  if (caretaker) ensure(caretaker.securityPin === access.securityPin, 'FIXTURE_PIN_MISMATCH');

  phase = 'synthetic-fixture';
  // No global settings, units, existing rows or non-fixture data are updated.
  if (!family || !existingBaby || !caretaker || !settings.length) {
    ensure(!documents[0]?.committedAt, 'COMMITTED_FIXTURE_MUST_BE_COMPLETE');
    await db.$transaction(async tx => {
      ensure(await tx.baby.count({ where: { id: { not: FIXTURE.babyId } } }) === 0, 'NON_SYNTHETIC_BABY_PRESENT');
      if (!family) await tx.family.create({ data: { id: FIXTURE.familyId, slug: FIXTURE.familySlug, name: 'Synthetic OCR staging', setupStage: 3 } });
      if (!existingBaby) await tx.baby.create({ data: { id: FIXTURE.babyId, familyId: FIXTURE.familyId, firstName: 'Synthetic', lastName: 'Fixture', birthDate: new Date('2026-01-01T00:00:00Z') } });
      if (!caretaker) await tx.caretaker.create({ data: { id: FIXTURE.caretakerId, familyId: FIXTURE.familyId, loginId: FIXTURE.loginId,
        name: 'Synthetic Reviewer', role: 'ADMIN', type: 'parent', securityPin: access.securityPin, lastSeenVersion: '1.6.7' } });
      if (!settings.length) await tx.settings.create({ data: { id: FIXTURE.settingsId, familyId: FIXTURE.familyId,
        familyName: 'Synthetic OCR staging', authType: 'CARETAKER', securityPin: access.securityPin } });
    });
  }

  phase = 'real-authentication';
  const auth = await jsonRequest('/api/auth', { method: 'POST', ...jsonBody({ familySlug: FIXTURE.familySlug, loginId: FIXTURE.loginId, securityPin: access.securityPin }) });
  ensure(auth.id === FIXTURE.caretakerId && auth.familyId === FIXTURE.familyId && auth.role === 'ADMIN'
    && typeof auth.token === 'string' && auth.token.length > 20, 'AUTHENTICATED_FIXTURE_MISMATCH');
  token = auth.token;
  access = { ...access, token, authenticatedAt: new Date().toISOString() };
  await writeAccess(access);
  checked('Real caretaker login through loopback /api/auth');

  phase = 'synthetic-image';
  const image = await sharp(Buffer.from('<svg width="1700" height="700" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><g font-family="DejaVu Sans" font-size="48"><text x="60" y="130">08:15 bottle formula 90 mL</text><text x="60" y="280">09:30 wet diaper</text></g></svg>')).png().toBuffer();
  const sourceHash = createHash('sha256').update(image).digest('hex');
  if (documents[0]) ensure(documents[0].sourceHash === sourceHash, 'EXISTING_DOCUMENT_SOURCE_MISMATCH');
  let view;
  if (documents[0]) {
    phase = 'existing-fixture-receipt';
    view = await jsonRequest(`/api/ocr/documents/${encodeURIComponent(documents[0].id)}`);
  } else {
    phase = 'http-upload';
    await requireSyntheticBabies();
    const form = new FormData();
    form.set('file', new Blob([image], { type: 'image/png' }), 'synthetic-staging-care-log.png');
    for (const [key, value] of Object.entries({ babyId: FIXTURE.babyId, defaultDate: '2026-10-20', timeFormat: '24h',
      timeZone: 'America/Chicago', rotation: '0', retentionDays: '30' })) form.set(key, value);
    view = await jsonRequest('/api/ocr/documents', { method: 'POST', body: form });
    await requireNoCareWrites();
    checked('HTTP upload and native OCR create only a review draft');
  }
  ensure(view.babyId === FIXTURE.babyId && view.sourceTimezone === 'America/Chicago', 'DOCUMENT_CONTEXT_MISMATCH');
  report.mode = view.committedAt ? 'verify-existing' : 'create-and-verify';
  if (!view.committedAt) {
    phase = 'draft-review';
    ensure(view.rows.length === 2, 'EXPECTED_TWO_OCR_ROWS');
    const feed = view.rows.find(row => row.eventType === 'feed');
    const diaper = view.rows.find(row => row.eventType === 'diaper');
    ensure(feed?.localTime === '08:15' && feed.feedType === 'BOTTLE' && feed.bottleType === 'Formula'
      && feed.unit === 'ML' && (feed.amount === 90 || feed.amount === 95), 'EXPECTED_PRINTED_FEED_EXTRACTION');
    ensure(diaper?.localTime === '09:30' && diaper.diaperType === 'WET', 'EXPECTED_PRINTED_DIAPER_EXTRACTION');
    ensure(view.originalRows.find(row => row.id === feed.id)?.amount === 90, 'ORIGINAL_OCR_AMOUNT_MISMATCH');
    const rows = view.rows.map(row => ({ ...row, ...(row.id === feed.id ? { amount: 95 } : {}), approved: true }));
    let review = { revision: view.revision, rows, timeZone: 'America/Chicago', utcOffsets: {}, duplicateDecisions: {} };
    await requireSyntheticBabies();
    view = await jsonRequest(`/api/ocr/documents/${view.id}`, { method: 'PATCH', ...jsonBody(review) });
    await requireNoCareWrites();
    checked('HTTP PATCH preserves zero care writes and saves the 95 mL correction');
    review = { ...review, revision: view.revision, rows: view.rows };
    phase = 'http-preview';
    const preview = await jsonRequest(`/api/ocr/documents/${view.id}/preview`, { method: 'POST', ...jsonBody(review) });
    ensure(preview.issues.every(issue => issue.errors.length === 0) && preview.duplicates.length === 0, 'PREVIEW_MUST_BE_VALID_AND_UNIQUE');
    await requireNoCareWrites();
    checked('HTTP preview validates both rows without care writes');
    phase = 'http-commit-and-exact-retry';
    await requireSyntheticBabies();
    const commit = { method: 'POST', ...jsonBody({ ...review, acknowledgeWarnings: true }) };
    view = await jsonRequest(`/api/ocr/documents/${view.id}/commit`, commit);
    const retry = await jsonRequest(`/api/ocr/documents/${view.id}/commit`, commit);
    ensure(JSON.stringify(retry) === JSON.stringify(view), 'EXACT_RETRY_RECEIPT_MISMATCH');
    checked('Approved HTTP commit and exact retry return the same durable receipt');
  } else checked('Existing committed fixture reopened without upload, review or commit mutations');

  phase = 'canonical-database-and-timeline';
  await requireSyntheticBabies();
  const value = await counts();
  ensure(value.feed === 1 && value.diaper === 1 && value.sleep === 0, 'CANONICAL_EVENT_COUNT_MISMATCH');
  const feed = await db.feedLog.findFirst({ where: { babyId: FIXTURE.babyId, familyId: FIXTURE.familyId, deletedAt: null } });
  const diaper = await db.diaperLog.findFirst({ where: { babyId: FIXTURE.babyId, familyId: FIXTURE.familyId, deletedAt: null } });
  ensure(feed?.amount === 95 && feed.unitAbbr === 'ML' && feed.type === 'BOTTLE' && feed.bottleType === 'Formula'
    && feed.time.toISOString() === '2026-10-20T13:15:00.000Z', 'CANONICAL_FEED_VALUE_MISMATCH');
  ensure(diaper?.type === 'WET' && diaper.time.toISOString() === '2026-10-20T14:30:00.000Z', 'CANONICAL_DIAPER_VALUE_MISMATCH');
  ensure(view.committedAt && view.result?.created === 2 && view.result.duplicates === 0
    && (view.result.skipped || 0) === 0, 'COMMITTED_RECEIPT_MISMATCH');
  ensure(view.rows.length === 2 && view.rows.every(row => row.approved) && view.rows.some(row =>
    row.eventType === 'feed' && row.amount === 95 && row.unit === 'ML' && row.localDate === '2026-10-20' && row.localTime === '08:15'), 'SAVED_REVIEW_MISMATCH');
  ensure(view.originalRows.some(row => row.eventType === 'feed' && row.amount === 90), 'IMMUTABLE_ORIGINAL_MISMATCH');
  ensure(await db.ocrAudit.count({ where: { documentId: view.id, action: 'commit' } }) === 1, 'COMMIT_AUDIT_COUNT_MISMATCH');
  const timeline = await jsonRequest(`/api/timeline?babyId=${FIXTURE.babyId}&startDate=2026-10-20T00:00:00Z&endDate=2026-10-21T00:00:00Z`);
  ensure(Array.isArray(timeline) && timeline.some(row => row.id === feed.id && row.amount === 95)
    && timeline.some(row => row.id === diaper.id), 'ORDINARY_TIMELINE_MISMATCH');
  checked('Ordinary timeline and canonical database contain exactly the corrected feed and diaper at the expected UTC times');
  phase = 'original-source';
  const original = await fetch(`${BASE}/api/ocr/documents/${view.id}/source`, { redirect: 'error',
    signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${token}` } });
  ensure(original.ok && Buffer.from(await original.arrayBuffer()).equals(image), 'ORIGINAL_SOURCE_BYTES_MISMATCH');
  checked('Authorized original source download exactly matches the synthetic PNG');
  await writeAccess({ ...access, documentId: view.id, sourceHash, verifiedAt: new Date().toISOString() });
  report.status = 'PASS';
  report.fixture = { familyId: FIXTURE.familyId, babyId: FIXTURE.babyId, documentId: view.id };
  report.events = { feed: 1, diaper: 1, sleep: 0 };
} catch (error) {
  // Do not print Prisma/HTTP bodies, stack traces, environment values or credentials.
  report.phase = phase;
  report.reason = /^[A-Z][A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'STAGING_CHECK_FAILED';
  process.exitCode = 1;
} finally {
  try { await db?.$disconnect(); } catch { process.exitCode = 1; report.status = 'FAIL'; report.reason = 'DATABASE_DISCONNECT_FAILED'; }
  report.completedAt = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
}
