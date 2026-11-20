// Supplementary, independent recovery gate. Never changes the existing care/photo gates.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { chromium } from 'playwright';
import jwt from 'jsonwebtoken';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { createRecoveryBrowserFixture } from './recovery-browser-fixture.ts';
import { exportMetadata, validatePortableMetadata } from '../src/lib/portable-recovery/metadata.ts';
import { decryptFixtureFile } from './recovery-qualification-fixtures.ts';
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const appRoot = process.cwd(), reportDir = path.join(appRoot, 'test-results');
const invocation = randomUUID(), cancellation = new AbortController();
const report = { format: 'sat-tracker.portable-recovery-browser', version: 1, syntheticOnly: true, invocation,
  gitRevision: '', workflowSha: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null, startedAt: new Date().toISOString(), status: 'FAIL',
  checks: [], screenshots: [], errors: [], cleanup: { errors: [], browserClosed: false, serverExited: false,
    databaseClosed: false, ownedFilesRemoved: false, canonicalClientUnchanged: false } };
let scratch, stage, fixture, db, server, browser, browserServer, context, page, serverOutput = '', currentCheck = '', workSettled = false;
const original = new Map();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const snapshotPaths = ['prisma/schema.prisma', 'prisma/log-schema.prisma', 'node_modules/.prisma/client/schema.prisma', 'node_modules/.prisma/log-client/schema.prisma'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const http = (url, options = {}) => fetch(url, { ...options,
  signal: AbortSignal.any([cancellation.signal, options.signal ?? AbortSignal.timeout(10000)]) });
async function bounded(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' exceeded its deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(action, label, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) { cancellation.signal.throwIfAborted(); if (await action()) return; if (Date.now() >= end) throw new Error('Timed out waiting for ' + label); await sleep(50); }
}
async function check(id, action) {
  cancellation.signal.throwIfAborted();
  currentCheck = id; const started = Date.now();
  try { await action(); report.checks.push({ id, status: 'PASS', durationMs: Date.now() - started }); }
  catch (error) { report.checks.push({ id, status: 'FAIL', durationMs: Date.now() - started }); throw error; }
}
function linkDirectory(source, target) { symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir'); }
function prepareStage() {
  stage = path.join(scratch, 'isolated-app'); mkdirSync(stage);
  for (const file of ['package.json', 'tsconfig.json', 'prisma.config.ts', 'next.config.ts']) cpSync(path.join(appRoot, file), path.join(stage, file));
  cpSync(path.join(appRoot, 'prisma'), path.join(stage, 'prisma'), { recursive: true });
  cpSync(path.join(appRoot, 'src/lib/portable-recovery'), path.join(stage, 'src/lib/portable-recovery'), { recursive: true });
  mkdirSync(path.join(stage, 'scripts'));
  for (const file of ['recovery-startup.ts', 'prisma-provider.js']) cpSync(path.join(appRoot, 'scripts', file), path.join(stage, 'scripts', file));
  cpSync(path.join(appRoot, '.next'), path.join(stage, '.next'), {
    recursive: true, filter: source => !path.relative(path.join(appRoot, '.next'), source).split(path.sep).includes('cache'),
  });
  mkdirSync(path.join(stage, 'public'));
  for (const file of ['favicon.ico', 'sat-tracker.svg']) if (existsSync(path.join(appRoot, 'public', file))) cpSync(path.join(appRoot, 'public', file), path.join(stage, 'public', file));
  // Prisma generation owns its copied wrappers/output. Every other dependency is read-only shared.
  mkdirSync(path.join(stage, 'node_modules'));
  for (const entry of readdirSync(path.join(appRoot, 'node_modules'))) {
    if (entry === '.prisma' || entry === '@prisma') continue;
    const from = path.join(appRoot, 'node_modules', entry), to = path.join(stage, 'node_modules', entry);
    if (lstatSync(from).isDirectory()) linkDirectory(from, to); else symlinkSync(from, to);
  }
  mkdirSync(path.join(stage, 'node_modules/@prisma'));
  for (const entry of readdirSync(path.join(appRoot, 'node_modules/@prisma'))) {
    const from = path.join(appRoot, 'node_modules/@prisma', entry), to = path.join(stage, 'node_modules/@prisma', entry);
    if (entry === 'client') cpSync(from, to, { recursive: true }); else linkDirectory(from, to);
  }
  mkdirSync(path.join(stage, 'node_modules/.prisma'));
  for (const name of ['client', 'log-client']) if (existsSync(path.join(appRoot, 'node_modules/.prisma', name))) {
    cpSync(path.join(appRoot, 'node_modules/.prisma', name), path.join(stage, 'node_modules/.prisma', name), { recursive: true });
  }
  assert.equal(existsSync(path.join(stage, '.env')), false);
  assert.equal(existsSync(path.join(stage, 'Files')), false);
}
async function screenshot(name) {
  const file = path.join(reportDir, name + '.png');
  await page.screenshot({ path: file, fullPage: true }); report.screenshots.push(path.basename(file));
}
async function verifyEmpty() {
  for (const model of fixture.registry.models) {
    const rows = await db.$queryRawUnsafe(`SELECT COUNT(*) AS count FROM "${model.name}"`);
    assert.equal(Number(rows[0].count), 0, model.name + ' must still be empty');
  }
  assert.equal(existsSync(path.join(stage, 'Files')), false, 'Rejected requests must not create media');
  assert.equal(existsSync(path.join(stage, '.env')), false, 'Normal environment must not be created');
}
async function verifyDraft() {
  assert.equal(await page.getByLabel('Recovery operator token', { exact: true }).inputValue(), fixture.operatorToken);
  assert.equal(await page.getByLabel('Source recovery key', { exact: true }).inputValue(), fixture.sourceKey);
  assert.equal(await page.getByLabel('Backup archive', { exact: true }).evaluate(input => input.files?.[0]?.name), 'synthetic-portable.zip');
}
async function run() {
  assert.equal(process.env.SAT_TRACKER_SYNTHETIC_TEST, '1', 'Explicit synthetic-test opt-in is required');
  assert.equal(process.platform, 'linux', 'The recovery browser runner requires Linux process-group ownership');
  assert.ok(existsSync(path.join(appRoot, '.next/BUILD_ID')), 'A production build of the exact checked-out source is required');
  report.gitRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: appRoot, encoding: 'utf8', timeout: 10000 }).trim();
  for (const file of snapshotPaths) original.set(file, existsSync(path.join(appRoot, file)) ? digest(readFileSync(path.join(appRoot, file))) : null);
  scratch = mkdtempSync(path.join(tmpdir(), 'sat-recovery-browser-'));
  fixture = await createRecoveryBrowserFixture(path.join(scratch, 'private-fixture'), report.gitRevision, cancellation.signal);
  cancellation.signal.throwIfAborted();
  assert.ok(fixture.bytes.length > 10 * 1024 * 1024, 'The real browser must upload beyond the framework default proxy limit');
  assert.equal(fixture.prepared.mediaToRestore.length, 8, 'Retained OCR media must remain covered on future CI dates');
  assert.equal(fixture.prepared.omissions.length, 3, 'Expired, transit-expired and purged OCR remain explicit omissions');
  report.retentionOmissionCount = fixture.prepared.omissions.length;
  report.archiveBytes = fixture.bytes.length;
  report.archiveSha256 = fixture.archiveSha256;
  prepareStage();
  cancellation.signal.throwIfAborted();
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`, databaseUrl = 'file:' + path.join(scratch, 'destination.db');
  const env = { ...process.env, SAT_TRACKER_RECOVERY_MODE: '1', SAT_TRACKER_RECOVERY_TOKEN: fixture.operatorToken,
    SAT_TRACKER_RECOVERY_DATABASE_URL: databaseUrl, SAT_TRACKER_RECOVERY_STATE_DIR: path.join(scratch, 'private-state'),
    DATABASE_URL: databaseUrl, DATABASE_PROVIDER: 'sqlite', LOG_DATABASE_URL: databaseUrl, ENC_HASH: '', JWT_SECRET: '',
    ENABLE_LOG: 'false', ENABLE_NOTIFICATIONS: 'false', NEXT_TELEMETRY_DISABLED: '1', DEPLOYMENT_MODE: 'selfhosted',
    BABYTRACKER_OCR_FILES_DIR: path.join(stage, 'Files/ocr') };
  server = spawn(process.execPath, ['--import', 'tsx', 'scripts/recovery-startup.ts', process.execPath,
    path.join(stage, 'node_modules/next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: stage, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  });
  server.stdout.on('data', chunk => { serverOutput = (serverOutput + chunk).slice(-16000); });
  server.stderr.on('data', chunk => { serverOutput = (serverOutput + chunk).slice(-16000); });
  let spawnError; server.once('error', error => { spawnError = error; });
  await until(async () => {
    if (spawnError || server.exitCode !== null || server.signalCode !== null) throw new Error('The isolated recovery server exited before readiness');
    try { const response = await http(base + '/recovery', { signal: AbortSignal.timeout(1000) }); await response.body?.cancel(); return response.status === 200; }
    catch { return false; }
  }, 'actual recovery startup and page', 60000);
  cancellation.signal.throwIfAborted();
  db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: databaseUrl }), log: [] });
  const headers = { 'X-Sat-Recovery-Token': fixture.operatorToken };
  await check('isolated_startup_and_api_gate', async () => {
    const response = await http(base + '/api/recovery/status', { headers });
    assert.equal(response.status, 200); assert.equal((await response.json()).data.state, 'empty');
    for (const endpoint of ['/api/auth', '/api/app-config/public', '/api/setup/start', '/api/database', '/api/notifications/cron', '/']) {
      const blocked = await http(base + endpoint, { signal: AbortSignal.timeout(5000) });
      assert.equal(blocked.status, 503, endpoint + ' must be gated'); await blocked.body?.cancel();
    }
    await verifyEmpty();
  });
  await check('operator_capability_not_family_auth', async () => {
    const familyToken = jwt.sign({ id: 'synthetic-Caretaker', role: 'ADMIN', familyId: 'synthetic-Family' }, randomBytes(32).toString('hex'), { expiresIn: '1h' });
    for (const authHeaders of [{}, { Authorization: 'Bearer ' + familyToken }, { 'X-Sat-Recovery-Token': '0'.repeat(64) }]) {
      const response = await http(base + '/api/recovery/inspect', { method: 'POST', headers: authHeaders, body: 'malformed body must not be parsed' });
      assert.equal(response.status, 401); assert.equal((await response.json()).code, 'RECOVERY_UNAUTHORIZED');
    }
    await verifyEmpty();
  });
  browserServer = await chromium.launchServer({ headless: true, executablePath: process.env.BABYTRACKER_TEST_BROWSER_PATH || undefined, timeout: 30000 });
  browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 15000 });
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US' });
  page = await context.newPage(); page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(15000);
  await check('mobile_keyboard_and_destination_status', async () => {
    await page.goto(base + '/recovery', { waitUntil: 'networkidle' });
    const tokenInput = page.getByLabel('Recovery operator token', { exact: true });
    await tokenInput.fill(fixture.operatorToken); await tokenInput.press('Tab');
    assert.equal(await page.getByRole('button', { name: 'Check recovery destination', exact: true }).evaluate(element => document.activeElement === element), true);
    await page.keyboard.press('Enter');
    await page.getByTestId('recovery-destination-status').getByText('Destination is empty and ready.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await screenshot('recovery-mobile-empty');
  });
  await check('invalid_key_retains_selected_archive_and_draft', async () => {
    await page.getByLabel('Backup archive', { exact: true }).setInputFiles(fixture.archivePath);
    await page.getByLabel('Source recovery key', { exact: true }).fill('0'.repeat(64));
    const response = page.waitForResponse(response => response.url() === base + '/api/recovery/inspect' && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Inspect backup', exact: true }).click();
    assert.equal((await response).status(), 400); await page.getByRole('alert').waitFor();
    assert.equal(await page.getByLabel('Backup archive', { exact: true }).evaluate(input => input.files?.[0]?.name), 'synthetic-portable.zip');
    assert.equal(await page.getByLabel('Source recovery key', { exact: true }).inputValue(), '0'.repeat(64));
    assert.equal(await page.getByLabel('Recovery operator token', { exact: true }).inputValue(), fixture.operatorToken);
    await verifyEmpty(); await screenshot('recovery-mobile-rejected-key');
    await page.getByLabel('Source recovery key', { exact: true }).fill(fixture.sourceKey);
  });
  await check('complete_inspection_and_changed_input_invalidates_review', async () => {
    await page.getByRole('button', { name: 'Inspect backup', exact: true }).click();
    const inspection = page.getByTestId('recovery-inspection'); await inspection.waitFor();
    assert.ok((await inspection.textContent()).includes(fixture.archiveSha256));
    assert.ok((await inspection.textContent()).includes('Complete'));
    assert.equal(await inspection.getByText('Models', { exact: true }).locator('..').locator('dd').textContent(), '66');
    assert.equal(await inspection.getByText('Records', { exact: true }).locator('..').locator('dd').textContent(), '77');
    await verifyEmpty();
    await page.getByLabel('Source recovery key', { exact: true }).fill('0'.repeat(64));
    await inspection.waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('button', { name: 'Recover into this empty destination', exact: true }).count(), 0);
    await page.getByLabel('Source recovery key', { exact: true }).fill(fixture.sourceKey);
    await page.getByRole('button', { name: 'Inspect backup', exact: true }).click();
    await inspection.waitFor(); await screenshot('recovery-mobile-reviewed');
  });
  await check('rejected_commit_preserves_review_and_draft', async () => {
    await page.route(base + '/api/recovery/commit', async route => {
      await page.unroute(base + '/api/recovery/commit');
      const originalBody = route.request().postDataBuffer();
      assert.ok(originalBody?.includes(Buffer.from(fixture.archiveSha256)));
      const changed = Buffer.from(originalBody.toString('latin1').replace(fixture.archiveSha256, '0'.repeat(64)), 'latin1');
      await route.continue({ postData: changed });
    });
    const response = page.waitForResponse(response => response.url() === base + '/api/recovery/commit');
    await page.getByRole('button', { name: 'Recover into this empty destination', exact: true }).click();
    assert.equal((await response).status(), 409); await page.getByRole('alert').waitFor();
    await verifyDraft(); await verifyEmpty();
    assert.ok((await page.getByTestId('recovery-inspection').textContent()).includes(fixture.archiveSha256));
    await screenshot('recovery-mobile-rejected-commit');
  });
  await check('real_ui_commit_exact_metadata_and_media', async () => {
    const response = page.waitForResponse(response => response.url() === base + '/api/recovery/commit');
    await page.getByRole('button', { name: 'Recover into this empty destination', exact: true }).click();
    const result = await response; assert.equal(result.status(), 200);
    const receipt = (await result.json()).data;
    assert.equal(receipt.status, 'RECOVERED'); assert.equal(receipt.verified, true); assert.equal(receipt.activationRequired, true);
    assert.equal(receipt.recordsRestored, 77); assert.equal(receipt.tablesRestored, 66);
    assert.equal(receipt.filesRestored, 8);
    assert.deepEqual(receipt.omissions, ['3 OCR documents have expired or purged source media; their original metadata and retention dates are preserved.']);
    assert.equal(receipt.archiveSha256, fixture.archiveSha256);
    const metadata = await exportMetadata(db, { provider: 'sqlite', registry: fixture.registry, exportedAt: fixture.metadata.source.exportedAt });
    assert.deepEqual(validatePortableMetadata(metadata, fixture.registry).tableHashes, fixture.tableHashes);
    for (const media of fixture.prepared.mediaToRestore) {
      const bytes = readFileSync(path.join(stage, 'Files', ...media.storagePath.split('/')));
      assert.equal(digest(bytes), media.sha256); assert.deepEqual(decryptFixtureFile(bytes, fixture.sourceKey), fixture.files.get(media.storagePath).plaintext);
    }
    await page.getByTestId('recovery-receipt').waitFor();
    assert.ok((await page.getByTestId('recovery-receipt').textContent()).includes('Activation is required.'));
    assert.equal(new URL(page.url()).pathname, '/recovery');
    assert.equal(existsSync(path.join(stage, '.env')), false);
    const stateKey = readFileSync(path.join(scratch, 'private-state/recovery.env'), 'utf8');
    assert.ok(stateKey.includes(fixture.sourceKey));
    report.receipt = receipt; await screenshot('recovery-mobile-complete');
  });
  await check('complete_destination_is_sealed_and_not_activated', async () => {
    const status = await http(base + '/api/recovery/status', { headers });
    assert.equal(status.status, 200); const result = (await status.json()).data;
    assert.equal(result.state, 'complete'); assert.equal(result.ready, false);
    const replay = await http(base + '/api/recovery/commit', { method: 'POST', headers, body: 'malformed replay' });
    assert.equal(replay.status, 409); assert.equal((await replay.json()).code, 'RECOVERY_DESTINATION_BLOCKED');
    for (const endpoint of ['/api/app-config/public', '/api/auth', '/api/photos', '/api/setup/start']) {
      const response = await http(base + endpoint); assert.equal(response.status, 503); await response.body?.cancel();
    }
    const browserStorage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    assert.equal(browserStorage.includes(fixture.sourceKey), false); assert.equal(browserStorage.includes(fixture.operatorToken), false);
    const after = await exportMetadata(db, { provider: 'sqlite', registry: fixture.registry, exportedAt: fixture.metadata.source.exportedAt });
    assert.deepEqual(validatePortableMetadata(after, fixture.registry).tableHashes, fixture.tableHashes);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  });
  assert.equal(report.checks.length, 8); assert.ok(report.checks.every(check => check.status === 'PASS'));
}

try {
  mkdirSync(reportDir, { recursive: true });
  const work = run();
  void work.then(() => { workSettled = true; }, () => { workSettled = true; });
  try { await bounded(work, 180000, 'Recovery browser work'); }
  catch (error) {
    if (!workSettled) {
      cancellation.abort(error);
      if (context) await bounded(context.close(), 3000, 'Cancelled recovery context').catch(() => {});
      await bounded(work.catch(() => {}), 10000, 'Cancelled recovery work').catch(() => {});
    }
    throw error;
  }
} catch (error) {
  report.errors.push({ check: currentCheck || 'setup', message: error.message });
  if (page) try { await bounded(screenshot('recovery-browser-failure'), 5000, 'Failure capture'); } catch { /* No unverified screenshot claim. */ }
} finally {
  const cleanup = report.cleanup;
  try { if (context) await bounded(context.close(), 5000, 'Browser context cleanup'); } catch (error) { cleanup.errors.push(error.message); }
  try {
    if (browser) await bounded(browser.close(), 5000, 'Browser connection cleanup');
    if (browserServer) {
      await bounded(browserServer.close(), 5000, 'Browser process cleanup');
      const process = browserServer.process();
      assert.ok(process.exitCode !== null || process.signalCode !== null, 'Owned browser process exit must be observed');
    }
    cleanup.browserClosed = true;
  }
  catch (error) { cleanup.errors.push(error.message); browserServer?.process()?.kill('SIGKILL'); }
  try {
    const alive = () => {
      if (!server?.pid) return false;
      try { process.kill(-server.pid, 0); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    };
    const waitForGroup = async milliseconds => {
      const deadline = Date.now() + milliseconds;
      while (alive()) { if (Date.now() >= deadline) throw new Error('Owned recovery process group did not exit'); await sleep(50); }
    };
    // The startup parent can exit before its Next child; process-group ownership
    // is checked even after a parent exit so orphan servers cannot be overlooked.
    if (alive()) {
      process.kill(-server.pid, 'SIGTERM');
      await waitForGroup(8000).catch(async () => { if (alive()) process.kill(-server.pid, 'SIGKILL'); await waitForGroup(5000); });
    }
    cleanup.serverExited = !alive() && (!server?.pid || server.exitCode !== null || server.signalCode !== null);
    assert.equal(cleanup.serverExited, true);
    for (const stream of server?.stdio || []) stream?.destroy?.();
  } catch (error) { cleanup.errors.push(error.message); }
  try { if (db) await bounded(db.$disconnect(), 5000, 'Database cleanup'); cleanup.databaseClosed = true; }
  catch (error) { cleanup.errors.push(error.message); }
  try {
    assert.equal(workSettled, true, 'Unsettled work may still write owned files; preserve its scratch directory');
    if (scratch && cleanup.serverExited && cleanup.databaseClosed) rmSync(scratch, { recursive: true, force: true });
    cleanup.ownedFilesRemoved = !scratch || !existsSync(scratch); assert.equal(cleanup.ownedFilesRemoved, true);
    for (const [file, before] of original) assert.equal(existsSync(path.join(appRoot, file)) ? digest(readFileSync(path.join(appRoot, file))) : null, before, 'Canonical generated client/schema changed');
    cleanup.canonicalClientUnchanged = true;
  } catch (error) { cleanup.errors.push(error.message); }
  report.status = report.checks.length === 8 && report.checks.every(check => check.status === 'PASS') && !report.errors.length &&
    !cleanup.errors.length && cleanup.browserClosed && cleanup.serverExited && cleanup.databaseClosed && cleanup.ownedFilesRemoved && cleanup.canonicalClientUnchanged ? 'PASS' : 'FAIL';
  report.completedAt = new Date().toISOString();
  // Startup logs are synthetic but still redact both capabilities before preserving a failure.
  if (report.status !== 'PASS') {
    let safeLog = serverOutput;
    for (const value of [fixture?.sourceKey, fixture?.operatorToken].filter(Boolean)) safeLog = safeLog.split(value).join('[REDACTED]');
    writeFileSync(path.join(reportDir, 'recovery-browser-server.log'), safeLog); process.exitCode = 1;
  }
  let safeReport = JSON.stringify(report, null, 2);
  for (const value of [fixture?.sourceKey, fixture?.operatorToken].filter(Boolean)) safeReport = safeReport.split(value).join('[REDACTED]');
  writeFileSync(path.join(reportDir, 'portable-recovery-browser-report.json'), safeReport + '\n');
  console.log(safeReport);
}
