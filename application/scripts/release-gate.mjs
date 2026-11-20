#!/usr/bin/env node
// Source acceptance only. Promotion separately verifies preview, backup/restore,
// immutable image identity, rollback, protected approvals and production health.
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

const reportDir = path.join(process.cwd(), 'test-results');
fs.mkdirSync(reportDir, { recursive: true });
const runId = randomUUID();
const servicePath = path.join(reportDir, 'acceptance-service-report.json');
const browserPath = path.join(reportDir, 'ocr-browser-report.json');
for (const file of [servicePath, browserPath]) fs.rmSync(file, { force: true });
let gitRevision = 'unknown';
try { gitRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 }).trim(); } catch {}
const report = {
  version: 2, gateId: 'sat-tracker-source-acceptance-v2', runId, gitRevision,
  startedAt: new Date().toISOString(), syntheticOnly: true, scope: 'source-acceptance',
  stages: [], failures: [], overallStatus: 'PENDING',
  deploymentAcceptance: {
    status: 'NOT_RUN',
    requiredSeparately: ['exact-SHA CI', 'protected preview', 'fresh backup and isolated restore',
      'migration rehearsal', 'rollback with previous immutable image', 'production smoke and data preservation'],
  },
};

function execute(label, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(), env: { ...process.env, SAT_TRACKER_ACCEPTANCE_RUN_ID: runId },
    stdio: 'pipe', encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error || result.signal) {
    fs.writeFileSync(path.join(reportDir, label + '.log'), (result.stdout || '') + (result.stderr || ''));
    throw new Error(`${label} failed${result.error ? ': ' + result.error.message : ''}${result.signal ? ': ' + result.signal : ''}; see synthetic log`);
  }
}

try {
  execute('acceptance-service', ['node_modules/vitest/vitest.mjs', 'run', 'tests/e2e-acceptance.test.ts', 'tests/babyBuddyFeedingFidelity.integration.test.ts', 'tests/babyBuddyPumpingDisposition.integration.test.ts',
    '--reporter=json', '--outputFile=' + servicePath]);
  const service = JSON.parse(fs.readFileSync(servicePath, 'utf8'));
  assert.equal(service.success, true, 'Service acceptance report must declare success');
  assert.ok(service.numTotalTests > 0 && service.numPassedTests === service.numTotalTests,
    'Every service acceptance case must execute and pass');
  assert.equal(service.numPendingTests || 0, 0, 'Skipped service tests cannot satisfy acceptance');
  report.stages.push({ id: 'service-acceptance', status: 'PASS', tests: service.numPassedTests,
    scope: 'Synthetic parser/service, SQLite transaction, ownership and duplicate invariants',
    checks: service.testResults.flatMap(suite => suite.assertionResults.map(test => ({
      name: test.fullName || test.title, status: test.status,
    }))),
  });
} catch (error) {
  report.stages.push({ id: 'service-acceptance', status: 'FAIL' });
  report.failures.push(error.message);
}

try {
  execute('acceptance-browser', ['scripts/acceptance-browser.mjs']);
  const browser = JSON.parse(fs.readFileSync(browserPath, 'utf8'));
  assert.equal(browser.runId, runId, 'Browser evidence must belong to this invocation');
  assert.equal(browser.syntheticOnly, true, 'Browser evidence must use disposable fixtures');
  assert.equal(browser.status, 'PASS', 'Browser checks and cleanup must pass');
  assert.equal(browser.browserChecksPassed, true, 'Real upload/review/confirmation must run');
  assert.equal(browser.journalChecksPassed, true, 'OCR-to-journal and shared bottle workflow must run');
  assert.equal(browser.journalOutboxChecksPassed, true, 'Disconnected journal persistence, restart, isolation and replay must run');
  assert.equal(browser.medicationChecksPassed, true, 'Real medication import UI, dose fidelity, duplicate replay and ownership checks must run');
  assert.equal(browser.feedingImportChecksPassed, true, 'Real feeding import UI, elapsed time fidelity, atomic rejection and replay must run');
  assert.equal(browser.pumpingImportChecksPassed, true, 'Real pumping import and review UI, honest stock, safe corrections, authorization and replay must run');
  assert.equal(browser.pumpingConflictChecksPassed, true, 'Stale pumping edits, retained drafts and explicit reviewed conflict recovery must run');
  assert.equal(browser.careContactEditorChecksPassed, true, 'Actual medicine/vaccine edits must preserve unchanged contacts and send only deliberate selection changes');
  assert.equal(browser.nurseryPumpRecoveryChecksPassed, true, 'Real Nursery failure retention, restart, authentication, exact replay and cross-tab preservation must run');
  assert.equal(browser.nurseryBottleChecksPassed, true, 'Explicit nursery bottle quantities, frozen units, durable delivery and recovery must run');
  assert.equal(browser.breastfeedingRecoveryChecksPassed, true, 'Atomic breastfeeding completion, retained stop times, explicit conflict review, storage guards and bounded recovery must run');
  assert.equal(browser.nurseryUndoChecksPassed, true, 'Conditional original-revision Nursery Undo, atomic linked records and retained owner-scoped review must run');
  assert.equal(browser.nurserySleepRecoveryChecksPassed, true, 'Original sleep times, durable browser restart, scoped replay, revision-bound Undo and cross-tab recovery must run');
  assert.equal(browser.medicineDoseRecoveryChecksPassed, true, 'Actual USER dose entry, durable first-request recovery, exact replay, bounded failures and cross-tab owner guards must run');
  assert.equal(browser.nurseryQuickCareRecoveryChecksPassed, true, 'Original quick diaper/food intents, lost-response replay, exact Undo, browser restart, bounded auth and cross-tab ownership must run');
  assert.equal(browser.familyReadBoundaryChecksPassed, true, 'Authenticated HTTP family boundaries for timeline/export labels and hook activities, status, measurements and history-derived references must run');
  assert.equal(browser.logoutLifecycleChecksPassed, true, 'One owned logout transition, stale-session suppression, cookie ordering, aborted failure recovery and terminal navigation must run');
  assert.deepEqual(browser.cleanup?.errors, [], 'Owned browser/server cleanup must be verified');
  assert.equal(browser.cleanup?.server?.exited, true, 'Synthetic server exit must be verified');
  assert.equal(browser.cleanup?.browser?.exited, true, 'Synthetic browser exit must be verified');
  report.stages.push({ id: 'browser-acceptance', status: 'PASS', checks: browser.checks,
    screenshots: browser.screenshots, completedAt: browser.completedAt });
} catch (error) {
  report.stages.push({ id: 'browser-acceptance', status: 'FAIL' });
  report.failures.push(error.message);
}

report.overallStatus = report.failures.length ? 'FAIL' : 'PASS';
report.completedAt = new Date().toISOString();
fs.writeFileSync(path.join(reportDir, 'release-gate-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (report.overallStatus !== 'PASS') process.exitCode = 1;
