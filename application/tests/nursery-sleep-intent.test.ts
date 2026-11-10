import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mutateSleepIntent, normalizeSleepIntent, readSleepIntent, sleepIntentKey, type SleepIntent } from '@/src/utils/nursery/sleepIntent';
const scope = JSON.stringify(['family', 'caretaker:one', 'child']);
const start: SleepIntent = { kind: 'start', scope, familyId: 'family', babyId: 'child', requestedAt: '2026-10-20T12:00:00.000Z',
  startTime: '2026-10-20T12:00:00.000Z', requestId: '11111111-2222-3333-4444-555555555555', type: 'NAP', location: 'Crib' };
const wake: SleepIntent = { kind: 'wake', scope, familyId: 'family', babyId: 'child', requestedAt: '2026-10-20T13:00:00.000Z',
  startTime: start.startTime, endTime: '2026-10-20T13:00:00.000Z', sleepId: 'sleep-one', expectedRevision: 'a'.repeat(64) };
let values: Map<string, string>, storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn> };
beforeEach(() => {
  values = new Map(); storage = { getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }), removeItem: vi.fn((key: string) => { values.delete(key); }) };
  vi.stubGlobal('window', { localStorage: storage });
  let tail = Promise.resolve();
  vi.stubGlobal('navigator', { locks: { request: vi.fn((_key: string, _options: unknown, callback: () => unknown) => {
    const next = tail.then(callback); tail = next.then(() => undefined, () => undefined); return next;
  }) } });
});
afterEach(() => vi.unstubAllGlobals());

const saveSleepIntent = async (intent: SleepIntent) => (await mutateSleepIntent(intent.scope, 'create', intent)).status === 'saved';
const clearSleepIntent = async (intent: SleepIntent) => (await mutateSleepIntent(intent.scope, 'remove', intent)).status === 'removed';

describe('browser-persistent frozen sleep intentions', () => {
  it('preserves exact first Start and Wake times through storage and later reads', async () => {
    for (const intent of [start, wake]) {
      expect(await saveSleepIntent(intent)).toBe(true); expect(readSleepIntent(scope)).toEqual({ status: 'saved', intent });
      expect(await saveSleepIntent({ ...intent })).toBe(true); expect(await clearSleepIntent(intent)).toBe(true); expect(readSleepIntent(scope)).toEqual({ status: 'missing' });
    }
  });
  it.each(['undo-start', 'undo-wake'] as const)('persists %s with its exact record revision', async kind => {
    const { endTime: _, ...common } = wake as Extract<SleepIntent, { kind: 'wake' | 'undo-start' | 'undo-wake' }>;
    const intent = { ...common, kind }; expect(await saveSleepIntent(intent)).toBe(true); expect(readSleepIntent(scope)).toEqual({ status: 'saved', intent });
  });
  it('cannot replace or clear a different saved action, including another first timestamp', async () => {
    expect(await saveSleepIntent(start)).toBe(true); expect(await saveSleepIntent(wake)).toBe(false); expect(await clearSleepIntent(wake)).toBe(false);
    const later = { ...start, startTime: '2026-10-20T12:05:00.000Z', requestedAt: '2026-10-20T12:05:00.000Z' };
    expect(await saveSleepIntent(later)).toBe(false); expect(await clearSleepIntent(later)).toBe(false); expect(readSleepIntent(scope)).toEqual({ status: 'saved', intent: start });
  });
  it.each([{ familyId: 'other' }, { babyId: 'sibling' }, { scope: JSON.stringify(['family', 'caretaker:two', 'child']) },
    { requestId: {} }, { requestedAt: 'not-a-date' }, { startTime: '2026-10-20T12:01:00.000Z' }, { kind: 'delete-all' },
    { location: '' }, { authToken: 'must-not-be-stored' }])('rejects malformed or cross-scope Start %j', extra => {
    expect(normalizeSleepIntent(scope, { ...start, ...extra })).toBeNull();
  });
  it.each([{ expectedRevision: [] }, { sleepId: '' }, { endTime: '2026-10-20T13:05:00.000Z' },
    { startTime: '2026-10-20T14:00:00.000Z' }, { requestedAt: null }, { endTime: 'not-a-date' }])('rejects invalid Wake %j', extra => {
    expect(normalizeSleepIntent(scope, { ...wake, ...extra })).toBeNull();
  });
  it('keeps other family, actor, and child namespaces separate', async () => {
    expect(await saveSleepIntent(start)).toBe(true);
    for (const owner of [['foreign', 'caretaker:one', 'child'], ['family', 'caretaker:two', 'child'], ['family', 'caretaker:one', 'sibling']]) {
      expect(readSleepIntent(JSON.stringify(owner))).toEqual({ status: 'missing' });
      expect(normalizeSleepIntent(JSON.stringify(owner), start)).toBeNull();
    }
    expect(readSleepIntent(scope)).toEqual({ status: 'saved', intent: start });
  });
  it('fails closed on malformed saved data and never overwrites it', async () => {
    values.set(sleepIntentKey(scope), '{broken'); expect(readSleepIntent(scope)).toEqual({ status: 'invalid' });
    expect(await saveSleepIntent(start)).toBe(false); expect(await clearSleepIntent(start)).toBe(false); expect(values.get(sleepIntentKey(scope))).toBe('{broken');
  });
  it('fails closed on unavailable reads, rejected writes, or refused clearing', async () => {
    storage.getItem.mockImplementation(() => { throw new Error('Unavailable'); }); expect(readSleepIntent(scope)).toEqual({ status: 'unavailable' }); expect(await saveSleepIntent(start)).toBe(false);
    storage.getItem.mockImplementation((key: string) => values.get(key) ?? null); storage.setItem.mockImplementation(() => { throw new Error('Full'); });
    expect(await saveSleepIntent(start)).toBe(false); expect(readSleepIntent(scope)).toEqual({ status: 'missing' });
    values.set(sleepIntentKey(scope), JSON.stringify(start)); storage.removeItem.mockImplementation(() => {});
    expect(await clearSleepIntent(start)).toBe(false); expect(readSleepIntent(scope)).toEqual({ status: 'saved', intent: start });
  });
});

describe('shared sleep intent arbitration', () => {
  it('admits one of two simultaneous different actions and keeps the winner', async () => {
    const results = await Promise.all([mutateSleepIntent(scope, 'create', start), mutateSleepIntent(scope, 'create', wake)]);
    expect(results.map(result => result.status)).toEqual(['saved', 'changed']);
    expect(readSleepIntent(scope)).toEqual({ status: 'saved', intent: start });
  });
  it('a retry cannot recreate a cleared action, and a late clear cannot remove a newer one', async () => {
    expect((await mutateSleepIntent(scope, 'create', start)).status).toBe('saved');
    expect((await mutateSleepIntent(scope, 'remove', start)).status).toBe('removed');
    expect(await mutateSleepIntent(scope, 'verify', start)).toEqual({ status: 'changed', intent: null });
    expect((await mutateSleepIntent(scope, 'create', wake)).status).toBe('saved');
    expect(await mutateSleepIntent(scope, 'remove', start)).toEqual({ status: 'changed', intent: wake });
    expect(readSleepIntent(scope)).toEqual({ status: 'saved', intent: wake });
  });
  it('rechecks current ownership inside the lock before any storage mutation', async () => {
    expect(await mutateSleepIntent(scope, 'create', start, () => false)).toEqual({ status: 'cancelled' });
    expect(storage.setItem).not.toHaveBeenCalled();
  });
  it('fails closed when the browser cannot serialize local writers', async () => {
    vi.stubGlobal('navigator', {});
    expect(await mutateSleepIntent(scope, 'create', start)).toEqual({ status: 'locking-unavailable' });
    expect(storage.setItem).not.toHaveBeenCalled();
  });
  it('bounds waiting for another tab’s lock and leaves storage unchanged', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { locks: { request: (_key: string, options: { signal: AbortSignal }) => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('Lock wait aborted')));
    }) } });
    try {
      const pending = mutateSleepIntent(scope, 'create', start); await vi.advanceTimersByTimeAsync(2000);
      expect(await pending).toEqual({ status: 'busy' }); expect(storage.setItem).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
