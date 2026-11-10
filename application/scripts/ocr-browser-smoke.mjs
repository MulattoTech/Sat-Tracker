// Real browser acceptance against disposable synthetic storage only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import jwt from 'jsonwebtoken';
import { verifyJournalOutbox } from './journal-outbox-browser.mjs';
import { verifyMedicationImport } from './medication-import-browser.mjs';
import { verifyFeedingImport } from './feeding-import-browser.mjs';
import { verifyPumpingImport } from './pumping-import-browser.mjs';
import { verifyPumpingConflicts } from './pumping-conflict-browser.mjs';
import { verifyCareContactEditors } from './care-contact-editor-browser.mjs';
import { verifyNurseryPumpRecovery } from './nursery-pump-browser.mjs';
import { verifyNurseryBottle } from './nursery-bottle-browser.mjs';
import { verifyBreastfeedingRecovery } from './breastfeeding-recovery-browser.mjs';
import { verifyNurseryUndo } from './nursery-undo-browser.mjs';
import { verifyNurserySleepRecovery } from './nursery-sleep-browser.mjs';
import { verifyMedicineDoseRecovery } from './medicine-dose-recovery-browser.mjs';
import { verifyNurseryQuickCare } from './nursery-quick-care-browser.mjs';
import { verifyFamilyReadBoundaries } from './family-read-boundary-http.mjs';
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { createPrismaAdapter } = require('../prisma/prisma-adapter.js');

const scratch = mkdtempSync(path.join(tmpdir(), 'babytracker-browser-synthetic-'));
const databaseUrl = `file:${path.join(scratch, 'synthetic.db')}`;
const secret = randomBytes(32).toString('hex');
const env = { ...process.env, DATABASE_URL: databaseUrl, LOG_DATABASE_URL: `file:${path.join(scratch, 'synthetic-log.db')}`,
  JWT_SECRET: secret, ENC_HASH: randomBytes(32).toString('hex'), DEPLOYMENT_MODE: 'selfhosted',
  BABYTRACKER_OCR_FILES_DIR: path.join(scratch, 'sources'),
  ENABLE_NOTIFICATIONS: 'false', ENABLE_LOG: 'false', NEXT_TELEMETRY_DISABLED: '1', COOKIE_SECURE: 'false' };
const reportDir = path.join(process.cwd(), 'test-results');
mkdirSync(reportDir, { recursive: true });
let server, serverLifecycle, browser, browserServer, browserLifecycle, db, failure;
let output = '';
const documents = [];
const report = { runId: process.env.SAT_TRACKER_ACCEPTANCE_RUN_ID || null, syntheticOnly: true, startedAt: new Date().toISOString(), checks: [], screenshots: [] };

async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded its cleanup deadline`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function trackOwnedProcess(child) {
  // Subscribe immediately: an already-exited child will never emit exit again.
  let spawnError;
  const exit = new Promise(resolve => child.once('exit', resolve));
  const close = new Promise(resolve => child.once('close', resolve));
  child.once('error', error => { spawnError = error; });
  return { child, exit, close, get exited() { return child.exitCode !== null || child.signalCode !== null; }, get spawnError() { return spawnError; } };
}

async function stopOwnedProcess(lifecycle, label) {
  if (!lifecycle) return { exited: true, forced: false };
  const { child } = lifecycle;
  let forced = false;
  try {
    if (!lifecycle.exited && child.pid) {
      child.kill('SIGTERM');
      await bounded(lifecycle.exit, 3000, `${label} graceful shutdown`).catch(() => {});
      if (!lifecycle.exited) {
        forced = true;
        child.kill('SIGKILL');
        await bounded(lifecycle.exit, 5000, `${label} forced shutdown`);
      }
    }
    assert.ok(lifecycle.exited || lifecycle.spawnError, `${label} termination was not verified`);
    // Close only this owned child's pipes; no name-based or global termination.
    for (const stream of child.stdio || []) stream?.destroy?.();
    await bounded(lifecycle.close, 2000, `${label} pipe closure`);
    return { exited: true, forced };
  } finally {
    for (const stream of child.stdio || []) stream?.destroy?.();
    // An unkillable child must produce FAIL, but must not hold the reporter open.
    if (!lifecycle.exited && child.pid) child.unref();
  }
}

try {
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env, stdio: 'pipe', timeout: 60_000 });
  db = new PrismaClient({ adapter: createPrismaAdapter(databaseUrl) });
  const family = await db.family.create({ data: { id: 'browser-family', slug: 'synthetic-ocr', name: 'Synthetic OCR family', setupStage: 3 } });
  const baby = await db.baby.create({ data: { id: 'browser-baby', familyId: family.id, firstName: 'Synthetic', lastName: 'Fixture', birthDate: new Date('2026-01-01Z') } });
  const caretaker = await db.caretaker.create({ data: { id: 'browser-caretaker', familyId: family.id, loginId: '01', name: 'Synthetic Reviewer', role: 'ADMIN', type: 'parent', securityPin: randomBytes(16).toString('hex'), lastSeenVersion: '1.6.7' } });
  await db.settings.create({ data: { familyId: family.id, familyName: family.name } });
  for (const unitAbbr of ['ML', 'OZ']) await db.unit.create({ data: { unitAbbr, unitName: unitAbbr } });
  const token = jwt.sign({ id: caretaker.id, name: caretaker.name, role: 'ADMIN', type: 'parent', familyId: family.id, familySlug: family.slug }, secret, { expiresIn: '10m' });
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  serverLifecycle = trackOwnedProcess(server);
  server.stdout.on('data', chunk => { output = (output + chunk).slice(-20000); });
  server.stderr.on('data', chunk => { output = (output + chunk).slice(-20000); });
  const readyDeadline = Date.now() + 30_000;
  for (;;) {
    if (serverLifecycle.spawnError || serverLifecycle.exited) throw new Error('Synthetic app exited before readiness.');
    try {
      const response = await fetch(base, { signal: AbortSignal.timeout(1500) });
      await response.body?.cancel();
      if (response.status >= 500) throw new Error('Synthetic app is not ready.');
      break;
    } catch {
      if (Date.now() >= readyDeadline) throw new Error('Synthetic app did not start within 30 seconds.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const unauthenticated = await fetch(`${base}/api/ocr/documents?babyId=${baby.id}`, { signal: AbortSignal.timeout(5000) });
  assert.equal(unauthenticated.status, 401); await unauthenticated.body?.cancel();
  report.checks.push('Unauthenticated document access rejected');
  browserServer = await chromium.launchServer({ headless: true, executablePath: process.env.BABYTRACKER_TEST_BROWSER_PATH || undefined, timeout: 30_000 });
  browserLifecycle = trackOwnedProcess(browserServer.process());
  browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 15_000 });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, timezoneId: 'America/Chicago' });
  const initializeContext = target => target.addInitScript(({ token, family, baby, caretakerId }) => {
    localStorage.setItem('authToken', token); localStorage.setItem('unlockTime', String(Date.now()));
    localStorage.setItem('caretakerId', caretakerId); localStorage.setItem('isAdmin', 'true');
    localStorage.setItem('selectedFamily', JSON.stringify(family));
    localStorage.setItem(`selectedBaby_${family.id}`, JSON.stringify(baby));
  }, { token, family, baby, caretakerId: caretaker.id });
  await initializeContext(context);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${base}/${family.slug}/ocr-import?babyId=${baby.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Document import', exact: true }).waitFor();
  await page.getByLabel('Photo or document', { exact: true }).waitFor();
  const image = await sharp(Buffer.from('<svg width="1700" height="700" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><g font-family="DejaVu Sans" font-size="48"><text x="60" y="130">08:15 bottle formula 90 mL; duration: 20 min</text><text x="60" y="280">09:30 wet diaper</text></g></svg>')).png().toBuffer();
  await page.getByLabel('Photo or document', { exact: true }).setInputFiles({ name: 'synthetic-care-log.png', mimeType: 'image/png', buffer: image });
  await page.getByLabel('Date for rows without a date', { exact: true }).fill('2026-10-20');
  await page.getByLabel('Source time zone', { exact: true }).fill('America/Chicago');
  await page.getByLabel('Clock format on this sheet', { exact: true }).selectOption('24h');
  await page.getByRole('button', { name: 'Upload and create review draft', exact: true }).click();
  await page.getByRole('heading', { name: 'Review draft', exact: true }).waitFor({ timeout: 45_000 });
  const draft = await db.ocrDocument.findFirstOrThrow(); documents.push(draft.id);
  assert.equal(await db.feedLog.count(), 0);
  assert.equal(await db.diaperLog.count(), 0);
  report.checks.push('Image upload creates only encrypted review draft');
  await page.getByLabel('Feeding amount', { exact: true }).fill('95');
  assert.equal(await page.getByLabel('Feeding duration (minutes)', { exact: true }).inputValue(), '20');
  await page.getByLabel('Feeding duration (minutes)', { exact: true }).fill('22.5');
  const richBottle = { feedDuration: 1350, offeredAmount: 120, formulaKcalOz: 22, formulaName: 'Synthetic Formula', bottleLabel: 'A1', sourceCaregiverName: 'TestParent' };
  await page.getByLabel('Volume offered (same unit)', { exact: true }).fill(String(richBottle.offeredAmount));
  await page.getByLabel('Formula concentration (kcal/oz)', { exact: true }).fill(String(richBottle.formulaKcalOz));
  await page.getByLabel('Formula name', { exact: true }).fill(richBottle.formulaName);
  await page.getByLabel('Bottle identifier', { exact: true }).fill(richBottle.bottleLabel);
  await page.getByLabel('Source caregiver name', { exact: true }).fill(richBottle.sourceCaregiverName);
  await page.getByRole('button', { name: 'Approve all valid rows I reviewed', exact: true }).click();
  await page.getByRole('button', { name: 'Save review draft', exact: true }).click();
  await page.getByText('Draft saved. No care events were imported.', { exact: true }).waitFor();
  assert.equal(await db.feedLog.count(), 0);
  await page.getByRole('button', { name: 'Check selected events and duplicates', exact: true }).click();
  await page.getByRole('heading', { name: 'Import preview — no care events saved', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Confirm and import approved events', exact: true }).isDisabled(), true);
  const desktop = path.join(reportDir, 'ocr-desktop.png');
  await page.screenshot({ path: desktop, fullPage: true }); report.screenshots.push(desktop);
  for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['tablet', { width: 820, height: 1180 }]]) {
    await page.setViewportSize(viewport);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${name} layout overflows`);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement !== document.body), true);
    const screenshot = path.join(reportDir, `ocr-${name}.png`);
    await page.screenshot({ path: screenshot, fullPage: true }); report.screenshots.push(screenshot);
    report.checks.push(`${name} viewport fits and keyboard focus is reachable`);
  }
  await page.getByLabel('I reviewed the original source, every selected event, all corrections and warnings, and any duplicate decisions. Import these approved events.', { exact: true }).check();
  await page.getByRole('button', { name: 'Confirm and import approved events', exact: true }).click();
  await page.getByRole('heading', { name: 'Import saved to the care timeline', exact: true }).waitFor();
  const feed = await db.feedLog.findFirstOrThrow();
  assert.equal(feed.amount, 95); assert.equal(feed.unitAbbr, 'ML'); assert.equal(feed.time.toISOString(), '2026-10-20T13:15:00.000Z');
  for (const [field, expected] of Object.entries(richBottle)) assert.equal(feed[field], expected, `Canonical feed lost corrected ${field}`);
  const canonicalFeed = await fetch(`${base}/api/feed-log?id=${feed.id}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  assert.equal(canonicalFeed.status, 200);
  const canonicalFeedBody = await canonicalFeed.json();
  assert.equal(canonicalFeedBody.success, true);
  assert.equal(canonicalFeedBody.data.id, feed.id);
  assert.equal(canonicalFeedBody.data.amount, 95); assert.equal(canonicalFeedBody.data.unitAbbr, 'ML');
  for (const [field, expected] of Object.entries(richBottle)) assert.equal(canonicalFeedBody.data[field], expected, `Canonical feed API lost corrected ${field}`);
  report.checks.push('Corrected OCR feeding duration and bottle fields persist in the same canonical feed and feed API');
  assert.equal(await db.diaperLog.count(), 1);
  const timeline = await fetch(`${base}/api/timeline?babyId=${baby.id}&startDate=2026-10-20T00:00:00Z&endDate=2026-10-21T00:00:00Z`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  assert.equal(timeline.status, 200);
  assert.match(await timeline.text(), /95/);

  report.checks.push('Corrected approved feed/diaper values appear in ordinary Sprout timeline');

  // Follow the real OCR receipt into the canonical journal; no pre-imported history.
  await page.goto(`${base}/${family.slug}/bottle-journal`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Bottle Journal', exact: true }).waitFor();
  await page.getByLabel('Journal date', { exact: true }).fill('2026-10-20');
  await page.getByTestId('journal-daily-total').filter({ hasText: /^95 mL$/ }).waitFor({ timeout: 20_000 });
  const history = page.getByRole('region', { name: 'Bottle history', exact: true });
  await history.getByText('95 ML', { exact: true }).waitFor();
  report.checks.push('Real corrected OCR import appears in Bottle Journal and daily totals');
  const importedBottle = history.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Edit bottle 08:15', exact: true }) });
  assert.equal(await importedBottle.count(), 1, 'The journal must show the imported bottle once');
  await importedBottle.getByText('Formula · Offered 120 ML', { exact: true }).waitFor();
  await importedBottle.getByText('Synthetic Formula · 22 kcal/oz · A1', { exact: true }).waitFor();
  await importedBottle.getByText('TestParent', { exact: true }).waitFor();
  report.checks.push('Bottle Journal displays corrected offered volume, formula concentration/name, bottle ID and source caregiver');

  const addBottle = page.getByRole('form', { name: 'Add bottle', exact: true });
  await addBottle.getByLabel('Feeding date and time', { exact: true }).fill('2026-10-20T10:20');
  await addBottle.getByRole('spinbutton', { name: /^Consumed/ }).fill('60');
  await addBottle.getByRole('spinbutton', { name: /^Offered/ }).fill('90');
  await addBottle.getByLabel('Milk type', { exact: true }).selectOption('Breast Milk');
  await addBottle.getByRole('button', { name: 'Save bottle', exact: true }).click();
  await page.getByText('Bottle saved.', { exact: true }).waitFor();
  await page.getByTestId('journal-daily-total').filter({ hasText: /^155 mL$/ }).waitFor();
  const added = await db.feedLog.findFirstOrThrow({ where: { time: new Date('2026-10-20T15:20:00.000Z') } });
  assert.equal(added.amount, 60); assert.equal(added.offeredAmount, 90);
  assert.equal(added.bottleType, 'Breast Milk'); assert.equal(added.caretakerId, caretaker.id);
  assert.equal(await db.feedLog.count(), 2);
  report.checks.push('Bottle entry saves offered/consumed volumes and caregiver in canonical records');

  // A separate browser context has its own storage, like another family device.
  const otherContext = await browser.newContext({ viewport: { width: 412, height: 915 }, timezoneId: 'America/Chicago' });
  await initializeContext(otherContext);
  const otherPage = await otherContext.newPage();
  otherPage.on('pageerror', error => pageErrors.push(error.message));
  await otherPage.goto(`${base}/${family.slug}/bottle-journal`, { waitUntil: 'networkidle' });
  await otherPage.getByLabel('Journal date', { exact: true }).fill('2026-10-20');
  await otherPage.getByTestId('journal-daily-total').filter({ hasText: /^155 mL$/ }).waitFor({ timeout: 20_000 });

  await history.getByRole('button', { name: 'Edit bottle 10:20', exact: true }).click();
  const editBottle = page.getByRole('form', { name: 'Edit bottle', exact: true });
  await editBottle.getByRole('spinbutton', { name: /^Consumed/ }).fill('70');
  await editBottle.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByTestId('journal-daily-total').filter({ hasText: /^165 mL$/ }).waitFor();
  assert.equal((await db.feedLog.findUniqueOrThrow({ where: { id: added.id } })).amount, 70);
  assert.equal(await db.feedLog.count(), 2, 'Editing must retain the same bottle ID');
  await otherPage.getByTestId('journal-daily-total').filter({ hasText: /^165 mL$/ }).waitFor({ timeout: 25_000 });
  report.checks.push('Bottle correction preserves identity and automatically synchronizes a second context');

  await page.getByText('Intake target', { exact: true }).click();
  await page.getByLabel('Daily target (mL)', { exact: true }).fill('200');
  await page.getByRole('button', { name: 'Save target', exact: true }).click();
  await page.getByText('Intake target saved.', { exact: true }).waitFor();
  const progress = page.getByRole('progressbar', { name: 'Daily target progress', exact: true });
  await progress.waitFor();
  assert.equal(await progress.getAttribute('value'), '83');
  assert.equal((await db.baby.findUniqueOrThrow({ where: { id: baby.id } })).dailyIntakeTargetMl, 200);
  report.checks.push('Configured daily intake target uses canonical consumed-volume totals');

  await otherPage.getByRole('button', { name: 'Sync now', exact: true }).click();
  await otherPage.getByRole('progressbar', { name: 'Daily target progress', exact: true }).waitFor();
  assert.equal(await otherPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, '412px journal layout overflows');
  const saveButton = otherPage.getByRole('button', { name: 'Save bottle', exact: true });
  assert.ok((await saveButton.boundingBox())?.height >= 44, 'Journal save control must be touch-sized');
  await otherPage.keyboard.press('Tab');
  assert.equal(await otherPage.evaluate(() => document.activeElement !== document.body), true);
  const journalPhone = path.join(reportDir, 'journal-phone-412.png');
  await otherPage.screenshot({ path: journalPhone, fullPage: true }); report.screenshots.push(journalPhone);
  report.checks.push('412px journal fits, offers touch-sized saving and supports manual synchronization');
  // Legacy Sprout records with missing/blank units mean OZ. Editing notes must
  // never reinterpret their existing amount as mL.
  const legacy = await db.feedLog.create({ data: {
    familyId: family.id, babyId: baby.id, caretakerId: caretaker.id, type: 'BOTTLE',
    time: new Date('2026-10-20T16:00:00.000Z'), amount: 3, unitAbbr: null,
    bottleType: 'Formula', notes: 'Synthetic legacy bottle',
  } });
  for (const legacyUnit of [null, '']) {
    if (legacyUnit === '') {
      await db.unit.create({ data: { unitAbbr: '', unitName: 'Synthetic legacy unspecified unit' } });
      await db.feedLog.update({ where: { id: legacy.id }, data: { unitAbbr: '' } });
    }
    await page.getByRole('button', { name: 'Sync now', exact: true }).click();
    await page.getByRole('button', { name: 'Sync now', exact: true }).waitFor();
    await page.getByTestId('journal-daily-total').filter({ hasText: /^253\.7 mL$/ }).waitFor();
    await history.getByRole('button', { name: 'Edit bottle 11:00', exact: true }).click();
    const legacyForm = page.getByRole('form', { name: 'Edit bottle', exact: true });
    assert.equal(await legacyForm.getByLabel('Volume unit', { exact: true }).inputValue(), 'OZ');
    assert.equal(await legacyForm.getByRole('spinbutton', { name: /^Consumed/ }).inputValue(), '3');
    const notes = legacyUnit === null ? 'Synthetic notes-only edit with null unit' : 'Synthetic notes-only edit with blank unit';
    await legacyForm.getByLabel('Notes', { exact: true }).fill(notes);
    await legacyForm.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('form', { name: 'Add bottle', exact: true }).waitFor();
    const preserved = await db.feedLog.findUniqueOrThrow({ where: { id: legacy.id } });
    assert.equal(preserved.amount, 3); assert.equal(preserved.unitAbbr, 'OZ');
    assert.equal(preserved.notes, notes); assert.equal(await db.feedLog.count(), 3);
    await page.getByTestId('journal-daily-total').filter({ hasText: /^253\.7 mL$/ }).waitFor();
  }
  report.checks.push('Notes-only edits preserve 3 oz and 253.7 mL total for null/blank legacy units');
  // A long-open quick-entry form uses the current clock, while an uncertain
  // network retry reuses its original timestamp and request ID exactly.
  await page.clock.setFixedTime(new Date('2026-10-20T17:00:00.000Z'));
  await page.reload({ waitUntil: 'networkidle' });
  const quickBottle = page.getByRole('form', { name: 'Add bottle', exact: true });
  await quickBottle.waitFor();
  assert.equal(await quickBottle.getByLabel('Use current time until saved', { exact: true }).isChecked(), true);
  assert.equal(await quickBottle.getByLabel('Feeding date and time', { exact: true }).inputValue(), '2026-10-20T12:00');
  await page.clock.setFixedTime(new Date('2026-10-20T20:00:00.000Z'));
  await quickBottle.getByRole('spinbutton', { name: /^Consumed/ }).fill('30');
  let lostResponse = false;
  const simulateResponseLoss = async route => {
    if (route.request().method() !== 'POST' || lostResponse) return route.continue();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    lostResponse = true;
    await route.abort('failed');
  };
  await page.route('**/api/bottle-journal', simulateResponseLoss);
  await quickBottle.getByRole('button', { name: 'Save bottle', exact: true }).click();
  await page.getByText('Bottle saved on this browser. Waiting for server confirmation.', { exact: true }).waitFor();
  assert.equal(lostResponse, true, 'The synthetic server must save before the response is lost');
  const quickSaved = await db.feedLog.findFirstOrThrow({ where: { time: new Date('2026-10-20T20:00:00.000Z') } });
  assert.equal(quickSaved.amount, 30); assert.equal(quickSaved.unitAbbr, 'ML');
  assert.equal(await db.feedLog.count(), 4);
  await page.unroute('**/api/bottle-journal', simulateResponseLoss);
  await page.clock.setFixedTime(new Date('2026-10-20T21:00:00.000Z'));
  await page.getByRole('region', { name: 'Pending bottles on this browser', exact: true }).getByRole('button', { name: 'Retry this entry', exact: true }).click();
  await page.getByText('Bottle saved.', { exact: true }).waitFor();
  assert.equal(await db.feedLog.count(), 4, 'Retry must not create another bottle');
  assert.equal((await db.feedLog.findUniqueOrThrow({ where: { id: quickSaved.id } })).time.toISOString(), '2026-10-20T20:00:00.000Z');
  await page.getByTestId('journal-daily-total').filter({ hasText: /^283\.7 mL$/ }).waitFor();
  report.checks.push('Quick entry uses current time; response-loss retry preserves one exact bottle');
  report.journalChecksPassed = true;
  // Playwright clocks belong to the context, including its background pages.
  // A later clock jump must not make this completed page's idle checker log
  // out and invalidate the shared synthetic token during another scenario.
  await bounded(page.close(), 5000, 'Completed journal page closure');
  assert.equal(context.pages().length, 0, 'Completed journal checks must leave no active pages in the shared context');
  report.checks.push(...await verifyJournalOutbox({ base, db, family, baby, caretaker, token, secret, scratch }));
  report.journalOutboxChecksPassed = true;
  report.checks.push(...await verifyMedicationImport({ base, db, family, baby, caretaker, token, secret, context }));
  report.medicationChecksPassed = true;
  report.checks.push(...await verifyFeedingImport({ base, db, family, baby, caretaker, token, secret, context }));
  report.feedingImportChecksPassed = true;
  report.checks.push(...await verifyPumpingImport({ base, db, family, baby, caretaker, token, secret, context }));
  report.pumpingImportChecksPassed = true;
  report.checks.push(...await verifyPumpingConflicts({ base, db, family, baby, caretaker, token, secret, context }));
  report.pumpingConflictChecksPassed = true;
  report.checks.push(...await verifyCareContactEditors({ base, db, family, baby, caretaker, context }));
  report.careContactEditorChecksPassed = true;
  report.checks.push(...await verifyNurseryPumpRecovery({ base, db, family, baby, caretaker, token, secret, context }));
  report.nurseryPumpRecoveryChecksPassed = true;
  report.checks.push(...await verifyNurseryBottle({ base, db, family, baby, caretaker, token, secret, context }));
  report.nurseryBottleChecksPassed = true;
  report.checks.push(...await verifyBreastfeedingRecovery({ base, db, family, baby, caretaker, token, secret, context }));
  report.breastfeedingRecoveryChecksPassed = true;
  report.checks.push(...await verifyNurseryUndo({ base, db, family, secret, context }));
  report.nurseryUndoChecksPassed = true;
  report.checks.push(...await verifyNurserySleepRecovery({ base, db, secret, context, scratch, browserExecutable: browserServer.process().spawnfile }));
  report.nurserySleepRecoveryChecksPassed = true;
  report.checks.push(...await verifyMedicineDoseRecovery({ base, db, scratch, reportDir }));
  report.medicineDoseRecoveryChecksPassed = true;
  report.checks.push(...await verifyNurseryQuickCare({ base, db, secret, context, scratch, browserExecutable: browserServer.process().spawnfile }));
  report.nurseryQuickCareRecoveryChecksPassed = true;
  report.screenshots.push(path.join(reportDir, 'nursery-quick-care-mobile.png'));
  report.screenshots.push(...['diaper', 'food'].map(kind => path.join(reportDir, `nursery-quick-care-${kind}-cards.png`)));
  report.checks.push(...await verifyFamilyReadBoundaries({ base, db, secret, reportDir }));
  report.familyReadBoundaryChecksPassed = true;
  const userToken = jwt.sign({ id: caretaker.id, name: caretaker.name, role: 'USER', familyId: family.id, familySlug: family.slug }, secret, { expiresIn: '5m' });
  const denied = await fetch(`${base}/api/ocr/documents?babyId=${baby.id}`, { headers: { Authorization: `Bearer ${userToken}` }, signal: AbortSignal.timeout(5000) });
  assert.equal(denied.status, 403); await denied.body?.cancel();
  report.checks.push('Non-admin import access rejected');
  assert.deepEqual(pageErrors, [], 'Browser JavaScript errors');
  report.browserChecksPassed = true;
} catch (error) {
  failure = error; report.error = error.message;
} finally {
  const cleanupErrors = [];
  report.cleanup = {};
  try {
    if (browser) for (const context of browser.contexts()) {
      for (const page of context.pages()) await bounded(page.unrouteAll({ behavior: 'ignoreErrors' }), 3000, 'Synthetic page routing cleanup');
      await bounded(context.unrouteAll({ behavior: 'ignoreErrors' }), 3000, 'Synthetic context routing cleanup');
    }
    if (browser) await bounded(browser.close(), 5000, 'Browser connection closure');
  } catch (error) { report.cleanup.browserGracefulCloseTimedOut = true; }
  try {
    if (browserServer) {
      try {
        try { await bounded(browserServer.close(), 5000, 'Owned browser shutdown'); }
        catch { await bounded(browserServer.kill(), 5000, 'Owned browser forced shutdown'); }
      } finally {
        report.cleanup.browser = await stopOwnedProcess(browserLifecycle, 'Synthetic browser');
      }
    }
  } catch (error) { cleanupErrors.push(error.message); }
  try { report.cleanup.server = await stopOwnedProcess(serverLifecycle, 'Synthetic Next server'); }
  catch (error) { cleanupErrors.push(error.message); }
  try {
    // Clean encrypted synthetic sources by exact names from this disposable database.
    if (db) {
      for (const id of documents) {
        const doc = await bounded(db.ocrDocument.findUnique({ where: { id } }), 5000, 'Synthetic source lookup');
        for (const file of [doc?.sourceFile, ...JSON.parse(doc?.previewFiles || '[]').map(page => page.file)].filter(Boolean)) {
          if (/^[a-f\d-]{36}\.enc$/i.test(file)) rmSync(path.join(env.BABYTRACKER_OCR_FILES_DIR, file), { force: true });
        }
      }
    }
  } catch (error) { cleanupErrors.push(error.message); }
  try { if (db) await bounded(db.$disconnect(), 5000, 'Synthetic database disconnect'); }
  catch (error) { cleanupErrors.push(error.message); }
  try { if (!serverLifecycle || serverLifecycle.exited || serverLifecycle.spawnError) rmSync(scratch, { recursive: true, force: true }); }
  catch (error) { cleanupErrors.push(error.message); }
  report.cleanup.errors = cleanupErrors;
  report.status = failure || cleanupErrors.length ? 'FAIL' : 'PASS';
  report.completedAt = new Date().toISOString();
  if (report.status === 'FAIL') {
    // Only the synthetic test server writes this log; never attach production logs.
    writeFileSync(path.join(reportDir, 'ocr-browser-server.log'), output);
    process.exitCode = 1;
  }
  writeFileSync(path.join(reportDir, 'ocr-browser-report.json'), JSON.stringify(report, null, 2));
  // PASS is emitted only after owned processes exited and cleanup completed.
  console.log(JSON.stringify({ status: report.status, checks: report.checks, screenshots: report.screenshots, cleanup: report.cleanup, error: report.error }, null, 2));
}
