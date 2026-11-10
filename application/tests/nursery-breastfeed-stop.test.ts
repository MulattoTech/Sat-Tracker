import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { breastfeedStopKey, captureBreastfeedStop, clearBreastfeedStop, readBreastfeedStop, saveBreastfeedStop } from '@/src/utils/nursery/breastfeedStop';
import { journalScope } from '@/src/lib/bottle-journal/outbox-identity';

const scope = journalScope('family-a', 'caretaker:a', 'child-a');
const started = Date.parse('2026-11-02T11:00:00.000Z');
const session = { id: 'session-a', familyId: 'family-a', babyId: 'child-a', updatedAt: new Date(started).toISOString(),
  activeSide: 'LEFT' as const, leftDuration: 30, rightDuration: 60, pauseDuration: 15,
  isPaused: false, pausedAt: null, currentSideStartTime: new Date(started).toISOString() };
let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal('window', { sessionStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  } });
});
afterEach(() => vi.unstubAllGlobals());

describe('nursery breastfeeding first-stop intent', () => {
  it('captures exact first-stop seconds and restores them unchanged after time passes', () => {
    const intent = captureBreastfeedStop(session, scope, started + 120_999);
    expect(intent).toMatchObject({ leftDuration: 150, rightDuration: 60, pauseDuration: 15,
      expectedUpdatedAt: session.updatedAt, stoppedAt: '2026-11-02T11:02:00.999Z' });
    expect(saveBreastfeedStop(intent)).toBe(true);
    expect(readBreastfeedStop(scope)).toEqual({ status: 'saved', intent });
    const later = captureBreastfeedStop(session, scope, started + 900_000);
    expect(saveBreastfeedStop(later)).toBe(false);
    expect(readBreastfeedStop(scope)).toEqual({ status: 'saved', intent });
  });

  it('freezes the trailing pause without adding feeding seconds or moving a side on retry', () => {
    const paused = { ...session, isPaused: true, currentSideStartTime: null, pausedAt: new Date(started + 30_000).toISOString() };
    const intent = captureBreastfeedStop(paused, scope, started + 90_999);
    expect(intent).toMatchObject({ leftDuration: 30, rightDuration: 60, pauseDuration: 75 });
    expect(saveBreastfeedStop(intent)).toBe(true);
    expect(readBreastfeedStop(scope)).toEqual({ status: 'saved', intent });
  });

  it('isolates family, caregiver, account and child and never erases a different intent', () => {
    const first = captureBreastfeedStop(session, scope, started + 1_000);
    expect(saveBreastfeedStop(first)).toBe(true);
    for (const different of [journalScope('family-b', 'caretaker:a', 'child-a'), journalScope('family-a', 'caretaker:b', 'child-a'),
      journalScope('family-a', 'account:a', 'child-a'), journalScope('family-a', 'caretaker:a', 'child-b')]) {
      expect(readBreastfeedStop(different)).toEqual({ status: 'missing' });
      const [family, , baby] = JSON.parse(different);
      if (family !== session.familyId || baby !== session.babyId) expect(() => captureBreastfeedStop(session, different, started)).toThrow();
    }
    const newer = { ...first, sessionId: 'another-session' };
    store.set(breastfeedStopKey(scope), JSON.stringify(newer));
    expect(clearBreastfeedStop(first)).toBe(false);
    expect(readBreastfeedStop(scope)).toEqual({ status: 'saved', intent: newer });
    expect(clearBreastfeedStop(newer)).toBe(true);
    expect(readBreastfeedStop(scope)).toEqual({ status: 'missing' });
  });

  it('permits a different caregiver to explicitly capture their own authorized stop', () => {
    const other = journalScope('family-a', 'caretaker:b', 'child-a');
    const intent = captureBreastfeedStop(session, other, started + 1_000);
    expect(intent.scope).toBe(other);
    expect(saveBreastfeedStop(intent)).toBe(true);
    expect(readBreastfeedStop(scope)).toEqual({ status: 'missing' });
  });

  it.each([-1, 1.5, NaN, Infinity, '20', null, 2_147_483_648].map(value => ({ value })))('rejects malformed duration $value', ({ value }) => {
    expect(() => captureBreastfeedStop({ ...session, rightDuration: value as number }, scope, started)).toThrow();
  });

  it('rejects future timer origins and mismatched child records', () => {
    expect(() => captureBreastfeedStop(session, scope, started - 1)).toThrow();
    expect(() => captureBreastfeedStop({ ...session, isPaused: true, pausedAt: new Date(started + 1).toISOString() }, scope, started)).toThrow();
    expect(() => captureBreastfeedStop({ ...session, babyId: 'child-b' }, scope, started)).toThrow();
  });

  it('distinguishes corrupted and blocked storage from an absent stop and refuses overwrite', () => {
    const intent = captureBreastfeedStop(session, scope, started);
    store.set(breastfeedStopKey(scope), '{broken');
    expect(readBreastfeedStop(scope)).toEqual({ status: 'invalid' });
    expect(saveBreastfeedStop(intent)).toBe(false);
    expect(clearBreastfeedStop(intent)).toBe(false);
    vi.stubGlobal('window', { get sessionStorage() { throw new Error('synthetic blocked storage'); } });
    expect(readBreastfeedStop(scope)).toEqual({ status: 'unavailable' });
    expect(saveBreastfeedStop(intent)).toBe(false);
    expect(clearBreastfeedStop(intent)).toBe(false);
  });

  it('requires storage write/readback and exact matching cleanup', () => {
    const intent = captureBreastfeedStop(session, scope, started);
    vi.stubGlobal('window', { sessionStorage: { getItem: () => null, setItem: () => {} } });
    expect(saveBreastfeedStop(intent)).toBe(false);
  });
});
