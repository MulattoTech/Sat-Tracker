// Independent photo acceptance stage. The existing OCR/care browser deadline is unchanged.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import { verifyPhotoIntegrity } from './photo-integrity-browser.mjs';
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { createPrismaAdapter } = require('../prisma/prisma-adapter.js');
const scratch = mkdtempSync(path.join(tmpdir(), 'sat-photo-browser-synthetic-'));
const databaseUrl = `file:${path.join(scratch, 'synthetic.db')}`;
const env = { ...process.env, DATABASE_URL: databaseUrl, LOG_DATABASE_URL: `file:${path.join(scratch, 'synthetic-log.db')}`,
  JWT_SECRET: randomBytes(32).toString('hex'), ENC_HASH: randomBytes(32).toString('hex'), DEPLOYMENT_MODE: 'selfhosted',
  ENABLE_NOTIFICATIONS: 'false', ENABLE_LOG: 'false', NEXT_TELEMETRY_DISABLED: '1', COOKIE_SECURE: 'false' };
const reportDir = path.join(process.cwd(), 'test-results');
const workStarted = Date.now();
mkdirSync(reportDir, { recursive: true });
const report = { runId: process.env.SAT_TRACKER_ACCEPTANCE_RUN_ID || null,
  gitRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000 }).trim(),
  syntheticOnly: true, startedAt: new Date().toISOString(), checks: [], screenshots: [], photoIntegrityChecksPassed: false,
  cleanup: { errors: [], databaseClosed: false, scratchRemoved: false, ownedPhotoDirectoriesRemoved: false }, errors: [], status: 'FAIL' };
let db, server, serverLifecycle, browser, browserServer, browserLifecycle, output = '';
async function bounded(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' exceeded its deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}
function track(child) {
  let spawnError;
  const exit = new Promise(resolve => child.once('exit', resolve));
  const close = new Promise(resolve => child.once('close', resolve));
  child.once('error', error => { spawnError = error; });
  return { child, exit, close, get exited() { return child.exitCode !== null || child.signalCode !== null; }, get spawnError() { return spawnError; } };
}
async function stop(lifecycle, label) {
  if (!lifecycle) return { exited: true, forced: false };
  const { child } = lifecycle; let forced = false;
  try {
    if (!lifecycle.exited && child.pid) {
      child.kill('SIGTERM'); await bounded(lifecycle.exit, 3000, label + ' shutdown').catch(() => {});
      if (!lifecycle.exited) { forced = true; child.kill('SIGKILL'); await bounded(lifecycle.exit, 5000, label + ' forced shutdown'); }
    }
    assert.ok(lifecycle.exited || lifecycle.spawnError, label + ' termination was not verified');
    for (const stream of child.stdio || []) stream?.destroy?.();
    await bounded(lifecycle.close, 2000, label + ' pipe closure');
    return { exited: true, forced };
  } finally {
    for (const stream of child.stdio || []) stream?.destroy?.();
    if (!lifecycle.exited && child.pid) child.unref();
  }
}
try {
  assert.ok(report.runId, 'The photo stage requires the release invocation ID');
  assert.match(report.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env, stdio: 'pipe', timeout: 60000 });
  db = new PrismaClient({ adapter: createPrismaAdapter(databaseUrl) });
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  serverLifecycle = track(server);
  server.stdout.on('data', chunk => { output = (output + chunk).slice(-24000); });
  server.stderr.on('data', chunk => { output = (output + chunk).slice(-24000); });
  const deadline = Date.now() + 30000;
  for (;;) {
    if (serverLifecycle.spawnError || serverLifecycle.exited) throw new Error('Synthetic photo app exited before readiness');
    try {
      const response = await fetch(base, { signal: AbortSignal.timeout(1500) }); await response.body?.cancel();
      if (response.status >= 500) throw new Error('Synthetic photo app is not ready');
      break;
    } catch {
      if (Date.now() >= deadline) throw new Error('Synthetic photo app did not start within 30 seconds');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  browserServer = await chromium.launchServer({ headless: true, executablePath: process.env.BABYTRACKER_TEST_BROWSER_PATH || undefined, timeout: 30000 });
  browserLifecycle = track(browserServer.process());
  browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 15000 });
  const cancellation = new AbortController();
  const work = verifyPhotoIntegrity({ base, db, browser, reportDir, signal: cancellation.signal });
  let evidence;
  try {
    // The outer gate allows 240s. Stop work by 170s so every declared cleanup
    // bound, final owned-file sweep and report write fit inside that deadline.
    evidence = await bounded(work, Math.max(1, 170000 - (Date.now() - workStarted)), 'Photo stage work');
  } catch (error) {
    cancellation.abort(error);
    await bounded(work.catch(() => {}), 20000, 'Cancelled photo module cleanup').catch(cleanupError => report.errors.push(cleanupError.message));
    throw error;
  }
  assert.equal(evidence.status, 'PASS');
  report.checks = evidence.checks; report.screenshots = evidence.screenshots;
  report.photoIntegrityChecksPassed = true;
} catch (error) { report.errors.push(error.message); }
finally {
  const errors = report.cleanup.errors;
  if (browser) {
    for (const context of browser.contexts()) {
      try { await bounded(context.unrouteAll({ behavior: 'ignoreErrors' }), 3000, 'Photo routes'); await bounded(context.close(), 3000, 'Photo context'); }
      catch (error) { errors.push(error.message); }
    }
    try { await bounded(browser.close(), 5000, 'Photo browser connection'); } catch (error) { errors.push(error.message); }
  }
  if (browserServer) {
    try { await bounded(browserServer.close(), 5000, 'Photo browser server'); } catch (error) { errors.push(error.message); }
  }
  try { report.cleanup.browser = await stop(browserLifecycle, 'Owned photo browser'); } catch (error) { errors.push(error.message); }
  try { report.cleanup.server = await stop(serverLifecycle, 'Owned photo server'); } catch (error) { errors.push(error.message); }
  try {
    // A cancelled upload may still have been processing outside its DB
    // transaction. Recheck these exact owned paths after the server has exited.
    if (report.cleanup.server?.exited && /^[0-9a-f-]{36}$/i.test(report.runId || '')) {
      for (const suffix of ['', '-foreign']) {
        const directory = path.join(process.cwd(), 'Files/photos', 'synthetic-photo-browser-' + report.runId + suffix);
        rmSync(directory, { recursive: true, force: true }); assert.equal(existsSync(directory), false);
      }
      report.cleanup.ownedPhotoDirectoriesRemoved = true;
    }
  } catch (error) { errors.push(error.message); }
  try { if (db) await bounded(db.$disconnect(), 5000, 'Photo database'); report.cleanup.databaseClosed = true; } catch (error) { errors.push(error.message); }
  try {
    if (!serverLifecycle || serverLifecycle.exited || serverLifecycle.spawnError) {
      rmSync(scratch, { recursive: true, force: true }); assert.equal(existsSync(scratch), false); report.cleanup.scratchRemoved = true;
    }
  } catch (error) { errors.push(error.message); }
  report.status = report.photoIntegrityChecksPassed && !report.errors.length && !errors.length && report.cleanup.scratchRemoved
    && report.cleanup.ownedPhotoDirectoriesRemoved ? 'PASS' : 'FAIL';
  report.completedAt = new Date().toISOString();
  if (report.status !== 'PASS') { writeFileSync(path.join(reportDir, 'photo-browser-server.log'), output); process.exitCode = 1; }
  writeFileSync(path.join(reportDir, 'photo-browser-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
