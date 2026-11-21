// Synthetic browser-acceptance diagnostics only: fixed phase names, no care data.
// A synchronous append ensures a partial trace survives if the parent release
// gate terminates this process after its existing hard deadline.
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const PHASES = Object.freeze([
  'initial-ocr-journal',
  'journal-outbox',
  'medication-import',
  'feeding-import',
  'pumping-import',
  'pumping-conflicts',
  'care-contact-editors',
  'corrected-age',
  'diaper-rash',
  'nursery-pump-recovery',
  'nursery-bottle',
  'breastfeeding-recovery',
  'nursery-undo',
  'nursery-sleep-recovery',
  'logout-lifecycle',
  'medicine-dose-recovery',
  'nursery-quick-care',
  'family-read-boundaries',
  'cleanup',
]);
const VALID_PHASES = new Set(PHASES);

export function createBrowserStageTiming({ reportDir, syntheticOnly }) {
  if (syntheticOnly !== true) throw new Error('BROWSER_TIMING_SYNTHETIC_ONLY');
  if (typeof reportDir !== 'string' || !reportDir.trim()) throw new Error('BROWSER_TIMING_DIRECTORY_REQUIRED');
  const file = path.join(reportDir, 'acceptance-browser-timing.jsonl');
  const started = performance.now();
  const open = new Map();
  writeFileSync(file, '', { flag: 'w' });

  function event(phase, state, durationMs = null) {
    if (!VALID_PHASES.has(phase)) throw new Error('BROWSER_TIMING_UNKNOWN_PHASE');
    if (!['start', 'pass', 'fail'].includes(state)) throw new Error('BROWSER_TIMING_UNKNOWN_EVENT');
    const elapsedMs = Math.round(performance.now() - started);
    // The only persisted values are fixed source-defined labels and elapsed
    // monotonic milliseconds; no arguments, error text, paths, tokens or rows.
    appendFileSync(file, JSON.stringify({
      source: 'synthetic-browser-acceptance',
      phase, event: state, elapsedMs,
      ...(durationMs === null ? {} : { durationMs: Math.round(durationMs) }),
    }) + '\n', { encoding: 'utf8' });
  }

  function begin(phase) {
    if (open.has(phase)) throw new Error('BROWSER_TIMING_PHASE_ALREADY_STARTED');
    const start = performance.now();
    event(phase, 'start');
    open.set(phase, start);
  }

  function finish(phase, { failed = false } = {}) {
    const start = open.get(phase);
    if (start === undefined) throw new Error('BROWSER_TIMING_PHASE_NOT_STARTED');
    open.delete(phase);
    event(phase, failed ? 'fail' : 'pass', performance.now() - start);
  }

  async function measure(phase, operation) {
    if (typeof operation !== 'function') throw new Error('BROWSER_TIMING_CALLBACK_REQUIRED');
    begin(phase);
    try {
      const result = await operation();
      finish(phase);
      return result;
    } catch (error) {
      finish(phase, { failed: true });
      throw error;
    }
  }
  return { begin, finish, measure, isActive: (phase) => open.has(phase) };
}
