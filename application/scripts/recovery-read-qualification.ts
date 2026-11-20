/** Invoke production readers only in a disposable, already-recovered provider fixture. No server/startup/seed. */
import assert from 'node:assert/strict';
import { closeSync, constants, existsSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { NextRequest } from 'next/server';
import type { PrismaClient } from '@prisma/client';
import { parsePortableSchema } from '../src/lib/portable-recovery/schema';
import { encodePortableRow, portableTableHash, type PortableProvider, type PortableRow } from '../src/lib/portable-recovery/metadata-codec';

interface ReaderInput {
  format: 'sat-tracker.recovery-reader-input'; version: 1; syntheticOnly: true;
  qualificationId: string; gitRevision: string; provider: PortableProvider; databaseUrl: string;
  generatedClientPath: string; applicationRoot: string; destinationRoot: string; sourceKey: string; clockInstant: string;
  media: { storagePath: string; plaintextSha256: string; plaintextBytes: number }[];
  ocrIds: Record<'retained' | 'transit-expired' | 'already-expired' | 'purged', string>;
}
const requiredChecks = ['production_auth', 'photo_full_owner', 'photo_thumbnail_owner', 'photo_foreign_denied',
  'photo_trash_restricted', 'vaccine_owner', 'vaccine_foreign_denied', 'feedback_owner', 'feedback_foreign_admin_denied',
  'ocr_source_owner', 'ocr_preview_owner', 'ocr_foreign_denied', 'ocr_expired_unavailable', 'anonymous_denied', 'read_side_effects_bounded'] as const;
type CheckId = typeof requiredChecks[number];
const RealDate = Date;
const applicationRoot = path.resolve(__dirname, '..');
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const report = {
  format: 'sat-tracker.recovery-reader-qualification', version: 1, syntheticOnly: true,
  qualificationId: '', gitRevision: '', provider: '' as PortableProvider | '', clockInstant: '',
  startedAt: new RealDate().toISOString(), completedAt: '', status: 'FAIL' as 'PASS' | 'FAIL',
  normalStartupUsed: false, recoveryModeRetained: false,
  checks: [] as { id: CheckId; status: 'PASS' | 'FAIL'; durationMs: number }[],
  retention: { purgedDocumentCount: 0, addedAuditCount: 0, unchangedModelCount: 0, filesUnchanged: false },
  errors: [] as { phase: string; code: string }[],
  cleanup: { clientClosed: false, clockRestored: false, syntheticSecretsCleared: false, errors: [] as string[] },
};
let phase = 'guard', output = '', client: PrismaClient | undefined;
const writeReport = () => { if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); };
const deadline = setTimeout(() => {
  report.errors.push({ phase, code: 'READER_DEADLINE' }); report.completedAt = new RealDate().toISOString(); writeReport(); process.exit(1);
}, 50_000);

function fileHashes(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const filename = path.join(directory, name), info = lstatSync(filename);
      assert.equal(info.isSymbolicLink(), false);
      if (info.isDirectory()) visit(filename);
      else { assert.equal(info.isFile(), true); result[path.relative(root, filename).split(path.sep).join('/')] = hash(readFileSync(filename)); }
    }
  };
  visit(root); return result;
}

function readInput(): ReaderInput {
  assert.equal(process.env.SAT_TRACKER_SYNTHETIC_TEST, '1');
  assert.equal(process.argv.length, 3);
  const filename = path.resolve(process.argv[2]), info = lstatSync(filename);
  assert.equal(info.isFile() && !info.isSymbolicLink(), true); assert.ok(info.size < 2 * 1024 * 1024);
  if (process.platform !== 'win32') assert.equal(info.mode & 0o077, 0);
  const descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  let input: ReaderInput;
  try { input = JSON.parse(readFileSync(descriptor, 'utf8')) as ReaderInput; } finally { closeSync(descriptor); }
  assert.equal(input.format, 'sat-tracker.recovery-reader-input'); assert.equal(input.version, 1); assert.equal(input.syntheticOnly, true);
  assert.match(input.qualificationId, /^[a-f0-9]{32}$/); assert.match(input.gitRevision, /^[a-f0-9]{40}$/);
  assert.ok(['sqlite', 'postgresql'].includes(input.provider)); assert.match(input.sourceKey, /^[a-fA-F0-9]{64}$/);
  assert.equal(input.applicationRoot, applicationRoot); assert.equal(process.cwd(), applicationRoot);
  assert.equal(path.resolve(input.destinationRoot), path.dirname(filename));
  assert.match(path.basename(input.destinationRoot), /^destination-[0-3]$/);
  const temporary = path.dirname(input.destinationRoot);
  assert.equal(path.dirname(temporary), realpathSync(tmpdir())); assert.match(path.basename(temporary), /^sat-recovery-qualification-[A-Za-z0-9]+$/);
  assert.equal(realpathSync(input.destinationRoot), input.destinationRoot);
  assert.equal(input.generatedClientPath, path.join(temporary, input.provider, 'client', 'index.js'));
  assert.equal(realpathSync(input.generatedClientPath), input.generatedClientPath);
  assert.equal(new RealDate(input.clockInstant).toISOString(), input.clockInstant);
  if (input.provider === 'sqlite') {
    assert.equal(input.databaseUrl, 'file:' + path.join(input.destinationRoot, 'application.db'));
    assert.equal(lstatSync(input.databaseUrl.slice(5)).isFile(), true);
  } else {
    const url = new URL(input.databaseUrl), schema = `sat_recovery_${input.qualificationId}_${path.basename(input.destinationRoot).replaceAll('-', '_')}`;
    assert.ok(['postgres:', 'postgresql:'].includes(url.protocol)); assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/sat_tracker_recovery_test'); assert.equal(url.search, '?schema=' + schema); assert.equal(url.hash, '');
  }
  assert.equal(existsSync(path.join(input.destinationRoot, '.env')), false);
  assert.ok(Array.isArray(input.media) && input.media.length <= 20_000);
  const names = new Set<string>();
  for (const media of input.media) {
    assert.match(media.storagePath, /^[A-Za-z0-9][A-Za-z0-9._/-]+\.enc$/); assert.ok(!media.storagePath.split('/').includes('..'));
    assert.equal(names.has(media.storagePath), false); names.add(media.storagePath);
    assert.match(media.plaintextSha256, /^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(media.plaintextBytes) && media.plaintextBytes > 0);
  }
  assert.deepEqual(Object.keys(input.ocrIds).sort(), ['already-expired', 'purged', 'retained', 'transit-expired']);
  for (const id of Object.values(input.ocrIds)) assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  output = path.join(input.destinationRoot, 'reader-report.json');
  Object.assign(report, { qualificationId: input.qualificationId, gitRevision: input.gitRevision, provider: input.provider, clockInstant: input.clockInstant });
  return input;
}

async function main(): Promise<void> {
  const input = readInput(), registry = parsePortableSchema(readFileSync(path.join(applicationRoot, 'prisma/schema.prisma'), 'utf8'));
  process.chdir(input.destinationRoot);
  Object.assign(process.env, {
    NODE_ENV: 'test', SAT_TRACKER_RECOVERY_MODE: '1', DATABASE_PROVIDER: input.provider, DATABASE_URL: input.databaseUrl,
    LOG_DATABASE_URL: 'file:' + path.join(input.destinationRoot, 'diagnostic-never-opened.db'), ENC_HASH: input.sourceKey,
    JWT_SECRET: randomBytes(32).toString('hex'), ENABLE_LOG: 'false', ENABLE_NOTIFICATIONS: 'false', DEPLOYMENT_MODE: 'selfhosted',
    BABYTRACKER_OCR_ENABLED: 'true', BABYTRACKER_OCR_FILES_DIR: path.join(input.destinationRoot, 'Files', 'ocr'), AUTH_LIFE: '3600',
  });
  // Import the production adapter only after the guarded cwd/env are in place.
  const { createPrismaAdapter } = await import('../prisma/prisma-adapter');
  const adapter = createPrismaAdapter(input.databaseUrl);
  const requireClient = createRequire(path.join(applicationRoot, 'package.json'));
  const Constructor = (requireClient(input.generatedClientPath) as { PrismaClient: new (options: unknown) => PrismaClient }).PrismaClient;
  const db = new Constructor({ adapter, log: [] }); client = db;
  assert.equal((db as unknown as { _engineConfig: { activeProvider: string } })._engineConfig.activeProvider, input.provider);
  (globalThis as unknown as Record<string, unknown>).__sprout_prisma = db;
  // API logging is disabled. Do not construct an operational log database even as a side effect of imports.
  (globalThis as unknown as Record<string, unknown>).logPrisma = { $disconnect: async () => {}, apiLog: { create: () => { throw new Error('DIAGNOSTIC_WRITE_FORBIDDEN'); } } };
  const clock = new RealDate(input.clockInstant).getTime();
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args) { return Reflect.construct(target, args.length ? args : [clock]); },
    apply() { return new RealDate(clock).toString(); },
    get(target, name, receiver) { return name === 'now' ? () => clock : Reflect.get(target, name, receiver); },
  });

  const snapshot = async (): Promise<Record<string, PortableRow[]>> => {
    const tables: Record<string, PortableRow[]> = {};
    for (const model of registry.models) {
      const delegate = (db as unknown as Record<string, { findMany(args: unknown): Promise<Record<string, unknown>[]> }>)[model.name[0].toLowerCase() + model.name.slice(1)];
      const rows = await delegate.findMany({ select: Object.fromEntries(model.fields.map(field => [field.name, true])) });
      tables[model.name] = rows.map((row, index) => encodePortableRow(model, row, index));
    }
    return tables;
  };
  const before = await snapshot(), filesBefore = fileHashes(path.join(input.destinationRoot, 'Files'));
  assert.equal(Object.values(before).reduce((sum, rows) => sum + rows.length, 0), 77);
  const { POST: login } = await import('../app/api/auth/route');
  const { getAuthenticatedUser } = await import('../app/api/utils/auth');
  const photo = await import('../app/api/photos/file/[id]/route');
  const vaccine = await import('../app/api/vaccine-log/file/[id]/route');
  const feedback = await import('../app/api/feedback/file/[id]/route');
  const ocr = await import('../app/api/ocr/documents/[id]/source/route');
  const { openOcrState } = await import('../src/lib/ocr/crypto');
  type Handler = (request: NextRequest) => Promise<Response>;
  const request = (url: string, token?: string, method = 'GET') => new NextRequest('http://synthetic.invalid' + url, {
    method, headers: token ? { Authorization: 'Bearer ' + token } : {},
  });
  const tokens: Record<string, string> = {};
  const owner = before.Caretaker.find(row => row.loginId === '11')!, foreign = before.Caretaker.find(row => row.loginId === '22')!;
  const ownerFamily = before.Family.find(row => row.slug === 'synthetic-recovery-family')!, foreignFamily = before.Family.find(row => row.slug === 'synthetic-recovery-foreign')!;
  assert.ok(owner && foreign && ownerFamily && foreignFamily); assert.notEqual(ownerFamily.id, foreignFamily.id);
  const expectedMedia = new Map(input.media.map(file => [file.storagePath, file]));
  const check = async (id: CheckId, action: () => Promise<void>) => {
    phase = id; const start = performance.now();
    try { await action(); report.checks.push({ id, status: 'PASS', durationMs: Math.round(performance.now() - start) }); }
    catch (error) { report.checks.push({ id, status: 'FAIL', durationMs: Math.round(performance.now() - start) }); throw error; }
  };
  const readable = async (handler: Handler, url: string, storagePath: string, mimeType: string) => {
    const response = await handler(request(url, tokens.owner)); assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), mimeType); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const expected = expectedMedia.get(storagePath); assert.ok(expected);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, expected.plaintextBytes); assert.equal(hash(bytes), expected.plaintextSha256); bytes.fill(0);
  };
  const denied = async (handler: Handler, url: string, token: string | undefined, status = 404, method = 'GET') => {
    const response = await handler(request(url, token, method)); assert.equal(response.status, status);
    assert.equal((await response.json()).success, false);
  };

  await check('production_auth', async () => {
    for (const [name, actor, family] of [['owner', owner, ownerFamily], ['foreign', foreign, foreignFamily]] as const) {
      assert.equal(actor.familyId, family.id); assert.equal(actor.role, 'ADMIN');
      const response = await login(new NextRequest('http://synthetic.invalid/api/auth', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginId: actor.loginId, securityPin: actor.securityPin, familySlug: family.slug }) }));
      assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.success, true); assert.equal(body.data.id, actor.id);
      tokens[name] = body.data.token; assert.equal(typeof tokens[name], 'string');
      const auth = await getAuthenticatedUser(request('/api/photos/file/synthetic', tokens[name]));
      assert.equal(auth.authenticated, true); assert.equal(auth.familyId, family.id); assert.equal(auth.caretakerRole, 'ADMIN'); assert.equal(auth.isSysAdmin, false);
    }
  });
  const live = before.Photo.find(row => row.deletedAt === null)!, trash = before.Photo.find(row => row.deletedAt !== null)!;
  const vaccineRow = before.VaccineDocument[0], feedbackRow = before.FeedbackAttachment[0];
  const retained = before.OcrDocument.find(row => row.id === input.ocrIds.retained)!;
  assert.ok(live && trash && retained); assert.equal(live.familyId, ownerFamily.id);
  const photoUrl = '/api/photos/file/' + live.id, trashUrl = '/api/photos/file/' + trash.id;
  const vaccineUrl = '/api/vaccine-log/file/' + vaccineRow.id, feedbackUrl = '/api/feedback/file/' + feedbackRow.id;
  const ocrUrl = '/api/ocr/documents/' + retained.id + '/source';
  const photoPath = (row: PortableRow, field: string) => `photos/${row.familyId}/${row[field]}`;
  await check('photo_full_owner', () => readable(photo.GET, photoUrl, photoPath(live, 'storedName'), String(live.mimeType)));
  await check('photo_thumbnail_owner', () => readable(photo.GET, photoUrl + '?size=thumb', photoPath(live, 'thumbStoredName'), 'image/jpeg'));
  await check('photo_foreign_denied', async () => { await denied(photo.GET, photoUrl, tokens.foreign); await denied(photo.GET, photoUrl + '?size=thumb', tokens.foreign); });
  await check('photo_trash_restricted', async () => {
    await denied(photo.GET, trashUrl, tokens.owner); await denied(photo.GET, trashUrl + '?trash=true', tokens.foreign);
    await readable(photo.GET, trashUrl + '?trash=true', photoPath(trash, 'storedName'), String(trash.mimeType));
  });
  await check('vaccine_owner', () => readable(vaccine.GET, vaccineUrl, String(vaccineRow.storedName), String(vaccineRow.mimeType)));
  await check('vaccine_foreign_denied', () => denied(vaccine.GET, vaccineUrl, tokens.foreign));
  await check('feedback_owner', () => readable(feedback.GET, feedbackUrl, 'feedback/' + feedbackRow.storedName, String(feedbackRow.mimeType)));
  await check('feedback_foreign_admin_denied', async () => { await denied(feedback.GET, feedbackUrl, tokens.foreign); await denied(feedback.DELETE, feedbackUrl, tokens.foreign, 404, 'DELETE'); });
  await check('ocr_source_owner', () => readable(ocr.GET, ocrUrl, 'ocr/' + retained.sourceFile, String(retained.mimeType)));
  const previews = JSON.parse(String(retained.previewFiles)) as { page: number; file: string }[];
  assert.equal(previews.length, 1);
  await check('ocr_preview_owner', () => readable(ocr.GET, ocrUrl + '?page=1', 'ocr/' + previews[0].file, 'image/png'));
  await check('ocr_foreign_denied', async () => { await denied(ocr.GET, ocrUrl, tokens.foreign); await denied(ocr.GET, ocrUrl + '?page=1', tokens.foreign); });
  await check('ocr_expired_unavailable', async () => {
    for (const label of ['transit-expired', 'already-expired', 'purged'] as const) {
      const url = '/api/ocr/documents/' + input.ocrIds[label] + '/source';
      await denied(ocr.GET, url, tokens.owner, 410); await denied(ocr.GET, url + '?page=1', tokens.owner, 410);
    }
  });
  await check('anonymous_denied', async () => {
    for (const [handler, url] of [[photo.GET, photoUrl], [vaccine.GET, vaccineUrl], [feedback.GET, feedbackUrl], [ocr.GET, ocrUrl]] as const) await denied(handler, url, undefined, 401);
  });
  await check('read_side_effects_bounded', async () => {
    const after = await snapshot(), expired = new Set([input.ocrIds['transit-expired'], input.ocrIds['already-expired']]);
    for (const model of registry.models) if (!['OcrDocument', 'OcrAudit'].includes(model.name)) {
      assert.equal(portableTableHash(model, after[model.name]), portableTableHash(model, before[model.name])); report.retention.unchangedModelCount++;
    }
    assert.equal(after.OcrDocument.length, before.OcrDocument.length);
    for (const original of before.OcrDocument) {
      const actual = after.OcrDocument.find(row => row.id === original.id)!; assert.ok(actual);
      if (expired.has(String(original.id))) {
        assert.deepEqual(actual, { ...original, sourceFile: null, previewFiles: '[]', purgedAt: input.clockInstant, updatedAt: actual.updatedAt });
        assert.notEqual(actual.updatedAt, original.updatedAt); report.retention.purgedDocumentCount++;
      } else assert.deepEqual(actual, original);
    }
    const originalAudits = new Set(before.OcrAudit.map(row => row.id));
    for (const original of before.OcrAudit) assert.deepEqual(after.OcrAudit.find(row => row.id === original.id), original);
    const added = after.OcrAudit.filter(row => !originalAudits.has(row.id)); assert.equal(added.length, 2);
    assert.deepEqual(new Set(added.map(row => row.documentId)), expired);
    for (const audit of added) {
      assert.equal(audit.action, 'purge-source'); assert.equal(audit.actorId, owner.id);
      const payload = openOcrState<{ sourceHash: string; cleanup: string }>(String(audit.snapshot), `${ownerFamily.id}:${audit.documentId}:audit`);
      assert.deepEqual(payload, { sourceHash: before.OcrDocument.find(row => row.id === audit.documentId)!.sourceHash, cleanup: 'scheduled-after-commit' });
    }
    report.retention.addedAuditCount = added.length;
    assert.deepEqual(fileHashes(path.join(input.destinationRoot, 'Files')), filesBefore); report.retention.filesUnchanged = true;
    assert.equal(existsSync(path.join(input.destinationRoot, 'diagnostic-never-opened.db')), false);
    assert.equal(process.env.SAT_TRACKER_RECOVERY_MODE, '1'); report.recoveryModeRetained = true;
  });
  assert.deepEqual(report.checks.map(check => check.id), requiredChecks); report.status = 'PASS';
}

main().catch(error => {
  report.errors.push({ phase, code: typeof error?.code === 'string' ? error.code : 'READER_QUALIFICATION_FAILED' });
  console.error(`Production recovery reader check failed during ${phase}.`);
  console.error(String(error?.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 4).join('\n'));
}).finally(async () => {
  globalThis.Date = RealDate; report.cleanup.clockRestored = globalThis.Date === RealDate;
  for (const name of ['ENC_HASH', 'JWT_SECRET']) delete process.env[name]; report.cleanup.syntheticSecretsCleared = !process.env.ENC_HASH && !process.env.JWT_SECRET;
  if (client) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([client.$disconnect(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DISCONNECT_TIMEOUT')), 5000); })]);
      report.cleanup.clientClosed = true;
    } catch { report.cleanup.errors.push('CLIENT_DISCONNECT_FAILED'); }
    finally { if (timer) clearTimeout(timer); }
  }
  if (report.cleanup.errors.length || !report.cleanup.clientClosed) report.status = 'FAIL';
  report.completedAt = new RealDate().toISOString(); writeReport(); clearTimeout(deadline);
  // Imported production auth has maintenance intervals; all database cleanup is awaited above.
  process.exit(report.status === 'PASS' ? 0 : 1);
});
