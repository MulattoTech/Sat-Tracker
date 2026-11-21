// Unit tests exercise only fake timing events; no browser, Docker or care data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBrowserStageTiming } from './browser-stage-timing.mjs';

async function fixture(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sat-browser-timing-fake-'));
  try {
    const timing = createBrowserStageTiming({ reportDir: dir, syntheticOnly: true });
    const events = () => readFileSync(
      path.join(dir, 'acceptance-browser-timing.jsonl'), 'utf8'
    ).trim().split('\n').filter(Boolean).map(JSON.parse);
    return await fn({ timing, events, dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('refuses non-synthetic source without a write', () => {
  assert.throws(
    () => createBrowserStageTiming({ reportDir: 'unused', syntheticOnly: false }),
    /BROWSER_TIMING_SYNTHETIC_ONLY/,
  );
});

test('manual phase start/finish keeps only fixed labels and monotonic timings', async () => {
  await fixture(({ timing, events }) => {
    timing.begin('initial-ocr-journal');
    assert.equal(timing.isActive('initial-ocr-journal'), true);
    timing.finish('initial-ocr-journal');
    assert.equal(timing.isActive('initial-ocr-journal'), false);
    const rows = events();
    assert.deepEqual(rows.map(row => row.event), ['start', 'pass']);
    assert.ok(rows.every(row => row.phase === 'initial-ocr-journal'));
    assert.ok(rows.every(row => row.source === 'synthetic-browser-acceptance'));
    assert.ok(rows[1].durationMs >= 0);
    assert.ok(rows[1].elapsedMs >= rows[0].elapsedMs);
  });
});

test('timed async callback returns the identical result without modifying checks', async () => {
  await fixture(async ({ timing, events }) => {
    const checks = ['fake success', 'fake recovery'];
    const received = await timing.measure('journal-outbox', async () => checks);
    assert.equal(received, checks);
    assert.equal(events()[1].event, 'pass');
  });
});

test('failed callback is rethrown, but no error text or fixture content is logged', async () => {
  await fixture(async ({ timing, events }) => {
    const original = new Error('DO_NOT_LOG_FAKE_SECRET_OR_CARE_DATA');
    await assert.rejects(
      timing.measure('family-read-boundaries', async () => { throw original; }),
      error => error === original,
    );
    const serialized = JSON.stringify(events());
    assert.deepEqual(events().map(entry => entry.event), ['start', 'fail']);
    assert.doesNotMatch(serialized, /DO_NOT_LOG_FAKE_SECRET_OR_CARE_DATA/);
    assert.equal(timing.isActive('family-read-boundaries'), false);
  });
});

test('partial timing survives a stopped worker without fabricated completion', async () => {
  await fixture(({ timing, events }) => {
    timing.begin('nursery-quick-care');
    assert.deepEqual(events().map(entry => entry.event), ['start']);
    assert.equal(timing.isActive('nursery-quick-care'), true);
  });
});

test('rejects unknown phases and unexpected event ordering', async () => {
  await fixture(async ({ timing }) => {
    assert.throws(() => timing.begin('real-person-health-record'), /BROWSER_TIMING_UNKNOWN_PHASE/);
    assert.throws(() => timing.finish('medication-import'), /BROWSER_TIMING_PHASE_NOT_STARTED/);
    timing.begin('medication-import');
    assert.throws(() => timing.begin('medication-import'), /BROWSER_TIMING_PHASE_ALREADY_STARTED/);
    timing.finish('medication-import', { failed: true });
    await assert.rejects(
      timing.measure('diaper-rash', null),
      /BROWSER_TIMING_CALLBACK_REQUIRED/,
    );
  });
});

test('all existing browser verification modules remain wrapped exactly once', () => {
  const source = readFileSync(new URL('./ocr-browser-smoke.mjs', import.meta.url), 'utf8');
  const phaseLabels = [...source.matchAll(/timing\.measure\('([a-z-]+)', \(\) => verify[A-Za-z]+\(/g)]
    .map(match => match[1]);
  assert.equal(phaseLabels.length, 17);
  assert.equal(new Set(phaseLabels).size, 17);
  assert.doesNotMatch(source, /report\.checks\.push\(\.\.\.await verify[A-Z]/);
  assert.match(source, /timing\.begin\('initial-ocr-journal'\)/);
  assert.match(source, /timing\.finish\('initial-ocr-journal'\)/);
  assert.match(source, /timing\.begin\('cleanup'\)/);
  assert.match(source, /timing\.finish\('cleanup'/);
  assert.match(source, /assert\.deepEqual\(pageErrors, \[\], 'Browser JavaScript errors'\)/);
});
