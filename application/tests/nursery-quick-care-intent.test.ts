import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mutateQuickCareIntent, normalizeQuickCareIntent, quickCareIntentKey, quickCareRequest, readQuickCareIntent,
  type QuickCareIntent } from '@/src/utils/nursery/quickCareIntent';

const scope = JSON.stringify(['family', 'caretaker:one', 'child']);
const diaper: QuickCareIntent = { version: 1, kind: 'diaper', scope, familyId: 'family', babyId: 'child',
  requestId: '11111111-2222-3333-4444-555555555555', time: '2026-10-20T12:00:00.000Z', type: 'WET' };
const food: QuickCareIntent = { version: 1, kind: 'food', scope, familyId: 'family', babyId: 'child',
  requestId: '66666666-2222-3333-4444-555555555555', time: '2026-10-20T12:01:00.000Z', foodId: 'food-one', foodName: 'Original Oatmeal' };
let values: Map<string, string>, storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn> };
beforeEach(() => {
  values = new Map(); storage = { getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }), removeItem: vi.fn((key: string) => { values.delete(key); }) };
  vi.stubGlobal('window', { localStorage: storage });
  const queues = new Map<string, Promise<unknown>>();
  vi.stubGlobal('navigator', { locks: { request: vi.fn((key: string, _options: unknown, callback: () => unknown) => {
    const next = (queues.get(key) ?? Promise.resolve()).then(callback); queues.set(key, next.catch(() => {})); return next;
  }) } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('immutable same-browser quick-care intent', () => {
  it.each([diaper, food])('keeps the exact first $kind payload and time through reads, retries and wire conversion', async intent => {
    expect(await mutateQuickCareIntent(intent, 'create')).toEqual({ status: 'saved', intent });
    expect(readQuickCareIntent(intent.kind, scope)).toEqual({ status: 'saved', intent });
    expect(await mutateQuickCareIntent(intent, 'verify')).toEqual({ status: 'saved', intent });
    const sent = quickCareRequest(intent); expect(sent.body).toEqual({ babyId: 'child', time: intent.time,
      requestId: intent.requestId, nurseryScope: scope, ...(intent.kind === 'diaper' ? { type: 'WET' } : { foodId: 'food-one' }) });
    expect(sent.body).not.toHaveProperty('foodName'); expect(sent.body).not.toHaveProperty('authToken');
    expect((await mutateQuickCareIntent(intent, 'remove')).status).toBe('removed');
    expect(readQuickCareIntent(intent.kind, scope)).toEqual({ status: 'missing' });
  });
  it('stores the two kinds independently, including across a recreated storage reader', async () => {
    await mutateQuickCareIntent(diaper, 'create'); await mutateQuickCareIntent(food, 'create');
    vi.stubGlobal('window', { localStorage: { ...storage } });
    expect(readQuickCareIntent('diaper', scope)).toEqual({ status: 'saved', intent: diaper });
    expect(readQuickCareIntent('food', scope)).toEqual({ status: 'saved', intent: food });
  });
  it.each([diaper, food])('never recreates a cleared $kind intent or clears a newer intent after a late reply', async intent => {
    await mutateQuickCareIntent(intent, 'create'); await mutateQuickCareIntent(intent, 'remove');
    expect(await mutateQuickCareIntent(intent, 'verify')).toEqual({ status: 'changed', intent: null });
    const newer = { ...intent, requestId: '99999999-2222-3333-4444-555555555555', time: '2026-10-20T13:00:00.000Z' };
    await mutateQuickCareIntent(newer, 'create');
    expect(await mutateQuickCareIntent(intent, 'remove')).toEqual({ status: 'changed', intent: newer });
    expect(await mutateQuickCareIntent(intent, 'create')).toEqual({ status: 'changed', intent: newer });
    expect(readQuickCareIntent(intent.kind, scope)).toEqual({ status: 'saved', intent: newer });
  });
  it('admits one of two concurrent same-kind actions while allowing the other kind', async () => {
    const newer = { ...diaper, requestId: '99999999-2222-3333-4444-555555555555', type: 'BOTH' as const };
    const results = await Promise.all([mutateQuickCareIntent(diaper, 'create'), mutateQuickCareIntent(newer, 'create'), mutateQuickCareIntent(food, 'create')]);
    expect(results.map(result => result.status)).toEqual(['saved', 'changed', 'saved']);
    expect(readQuickCareIntent('diaper', scope)).toEqual({ status: 'saved', intent: diaper });
  });
  it.each([{ familyId: 'foreign' }, { babyId: 'sibling' }, { scope: JSON.stringify(['family', 'caretaker:two', 'child']) },
    { requestId: {} }, { requestId: 'bad' }, { version: 2 }, { time: 'yesterday' }, { time: '2026-10-20' },
    { type: 'guess' }, { type: ['WET'] }, { authToken: 'never-stored' }])('rejects invalid or cross-owner diaper data %j', extra => {
    expect(normalizeQuickCareIntent('diaper', scope, { ...diaper, ...extra })).toBeNull();
  });
  it.each([{ foodId: '' }, { foodName: '' }, { foodName: [] }, { foodName: 'x'.repeat(1001) }, { kind: 'diaper' }])('rejects invalid food data %j', extra => {
    expect(normalizeQuickCareIntent('food', scope, { ...food, ...extra })).toBeNull();
  });
  it('isolates actor, child and family namespaces without treating them as authorization', async () => {
    await mutateQuickCareIntent(food, 'create');
    for (const owner of [['other', 'caretaker:one', 'child'], ['family', 'caretaker:two', 'child'], ['family', 'caretaker:one', 'sibling']]) {
      expect(readQuickCareIntent('food', JSON.stringify(owner))).toEqual({ status: 'missing' });
      expect(normalizeQuickCareIntent('food', JSON.stringify(owner), food)).toBeNull();
    }
  });
  it('does not overwrite malformed storage, and refuses mutation if ownership changed inside the lock', async () => {
    values.set(quickCareIntentKey('food', scope), '{broken');
    expect(readQuickCareIntent('food', scope)).toEqual({ status: 'invalid' });
    expect((await mutateQuickCareIntent(food, 'create')).status).toBe('invalid');
    expect(await mutateQuickCareIntent(diaper, 'create', () => false)).toEqual({ status: 'cancelled' });
    expect(storage.setItem).not.toHaveBeenCalled();
  });
  it('distinguishes a refused first write from a write whose verification became unreadable', async () => {
    storage.setItem.mockImplementationOnce(() => { throw new Error('Quota full'); });
    expect(await mutateQuickCareIntent(diaper, 'create')).toEqual({ status: 'unavailable', mayHaveSaved: false });
    storage.getItem.mockImplementationOnce(() => null).mockImplementationOnce(() => { throw new Error('Read blocked after saved'); });
    expect(await mutateQuickCareIntent(diaper, 'create')).toEqual({ status: 'unavailable', mayHaveSaved: true });
    expect(values.has(quickCareIntentKey('diaper', scope))).toBe(true);
    // Another tab may clear that possibly-saved value before this tab recovers.
    values.clear(); expect(await mutateQuickCareIntent(diaper, 'verify')).toEqual({ status: 'changed', intent: null });
    expect(values.size).toBe(0);
  });
  it('fails closed on unavailable storage and verifies removal instead of assuming it succeeded', async () => {
    storage.getItem.mockImplementationOnce(() => { throw new Error('Blocked'); });
    expect(await mutateQuickCareIntent(food, 'create')).toEqual({ status: 'unavailable', mayHaveSaved: false });
    await mutateQuickCareIntent(food, 'create'); storage.removeItem.mockImplementation(() => {});
    expect(await mutateQuickCareIntent(food, 'remove')).toEqual({ status: 'unavailable', mayHaveSaved: true });
    expect(readQuickCareIntent('food', scope)).toEqual({ status: 'saved', intent: food });
  });
  it('fails closed without Web Locks and bounds waiting for a held lock', async () => {
    vi.stubGlobal('navigator', {}); expect(await mutateQuickCareIntent(diaper, 'create')).toEqual({ status: 'locking-unavailable' });
    vi.useFakeTimers(); vi.stubGlobal('navigator', { locks: { request: (_key: string, options: { signal: AbortSignal }) => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('Aborted')));
    }) } });
    const pending = mutateQuickCareIntent(diaper, 'create'); await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toEqual({ status: 'busy' }); expect(storage.setItem).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});
