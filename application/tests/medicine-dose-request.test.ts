import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  freezeMedicineDose, medicineDoseScopeFromToken, medicineDoseStorageKey, mutateMedicineDose,
  parseSavedMedicineDose, readMedicineDose, requestMedicineDoseJSON, type SavedMedicineDose,
} from '@/src/utils/medicine-dose-request';

const scope = JSON.stringify(['family', 'caretaker:caregiver', 'child']);
const requestId = '78d29686-5eb2-48ee-a7ec-756853e2bcf3';
const values = { babyId: 'child', medicineId: 'medicine', time: '2026-11-02T12:00:00.000Z', doseAmount: 2.5, unitAbbr: 'ML', notes: 'Original dose' };
const snapshot = () => freezeMedicineDose(values, scope, 'Synthetic medicine', false, requestId);
class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('window', { localStorage: storage });
  // Serial acquisition models the storage critical section; actual origin-wide
  // Web Locks and two real tabs are exercised by the compiled browser gate.
  let tail = Promise.resolve();
  vi.stubGlobal('navigator', { locks: { request: vi.fn((_key, _options, callback) => {
    const result = tail.then(callback); tail = result.then(() => undefined, () => undefined); return result;
  }) } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('persistent medication request identity and exact storage ownership', () => {
  it('freezes the first values and restores them from persisted JSON without reading a new clock', async () => {
    const original = snapshot();
    expect(await mutateMedicineDose(scope, 'create', original)).toEqual({ status: 'saved', snapshot: original });
    const reloadedStorage = new MemoryStorage(); reloadedStorage.data = new Map(storage.data);
    vi.stubGlobal('window', { localStorage: reloadedStorage });
    expect(readMedicineDose(scope)).toEqual({ status: 'saved', snapshot: original });
    expect(original.request).toEqual({ ...values, expectedScope: scope, requestId });
  });

  it('keeps explicit zero and nullable values without inventing a quantity or unit', async () => {
    const zero = freezeMedicineDose({ ...values, doseAmount: 0, unitAbbr: undefined, notes: null }, scope, 'Synthetic', true, requestId);
    expect(zero.request).toMatchObject({ doseAmount: 0, unitAbbr: null, notes: null });
    expect(await mutateMedicineDose(scope, 'create', zero)).toEqual({ status: 'saved', snapshot: zero });
  });

  it.each([
    JSON.stringify(['other-family', 'caretaker:caregiver', 'child']),
    JSON.stringify(['family', 'caretaker:other', 'child']),
    JSON.stringify(['family', 'account:caregiver', 'child']),
    JSON.stringify(['family', 'caretaker:caregiver', 'other-child']),
  ])('does not expose or rebind another owner/child request: %s', async other => {
    await mutateMedicineDose(scope, 'create', snapshot());
    expect(readMedicineDose(other)).toEqual({ status: 'missing' });
    expect((await mutateMedicineDose(other, 'create', snapshot())).status).toBe('invalid');
    expect(readMedicineDose(scope).status).toBe('saved');
  });

  it('derives account and caretaker scopes separately and rejects missing/mismatched token ownership', () => {
    const token = (payload: object) => `head.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
    expect(medicineDoseScopeFromToken(token({ id: 'caregiver', familyId: 'family' }), 'family', 'child')).toBe(scope);
    expect(medicineDoseScopeFromToken(token({ accountId: 'caregiver', isAccountAuth: true, familyId: 'family' }), 'family', 'child'))
      .toBe(JSON.stringify(['family', 'account:caregiver', 'child']));
    expect(medicineDoseScopeFromToken(token({ id: 'caregiver', familyId: 'other' }), 'family', 'child')).toBeNull();
    expect(medicineDoseScopeFromToken(null, 'family', 'child')).toBeNull();
  });

  it('never overwrites a competing tab request with a new or stale form', async () => {
    const first = snapshot(), second = freezeMedicineDose({ ...values, doseAmount: 5 }, scope, 'Synthetic', false);
    const results = await Promise.all([mutateMedicineDose(scope, 'create', first), mutateMedicineDose(scope, 'create', second)]);
    expect(results).toEqual([{ status: 'saved', snapshot: first }, { status: 'changed', snapshot: first }]);
    expect(readMedicineDose(scope)).toEqual({ status: 'saved', snapshot: first });
    expect(await mutateMedicineDose(scope, 'create', first)).toEqual({ status: 'saved', snapshot: first });
  });

  it('an older acknowledgement or dismissal cannot remove a newer saved request', async () => {
    const old = snapshot(), newer = freezeMedicineDose(values, scope, 'Synthetic', false);
    await mutateMedicineDose(scope, 'create', old);
    expect(await mutateMedicineDose(scope, 'remove', old)).toEqual({ status: 'removed' });
    await mutateMedicineDose(scope, 'create', newer);
    expect(await mutateMedicineDose(scope, 'remove', old)).toEqual({ status: 'changed', snapshot: newer });
    expect(readMedicineDose(scope)).toEqual({ status: 'saved', snapshot: newer });
  });

  it('does not recreate a previously saved request after another tab acknowledged or dismissed it', async () => {
    const original = snapshot();
    await mutateMedicineDose(scope, 'create', original);
    await mutateMedicineDose(scope, 'remove', original);
    expect(readMedicineDose(scope)).toEqual({ status: 'missing' });
    expect(await mutateMedicineDose(scope, 'verify', original)).toEqual({ status: 'changed', snapshot: null });
    expect(readMedicineDose(scope)).toEqual({ status: 'missing' });
  });

  it('does not treat a changed payload under the same request ID as an exact saved copy', async () => {
    const original = snapshot(); await mutateMedicineDose(scope, 'create', original);
    const changed = freezeMedicineDose({ ...values, doseAmount: 5 }, scope, 'Synthetic medicine', false, requestId);
    expect(await mutateMedicineDose(scope, 'create', changed)).toEqual({ status: 'changed', snapshot: original });
    expect(await mutateMedicineDose(scope, 'remove', changed)).toEqual({ status: 'changed', snapshot: original });
  });

  it('compares values consistently after JSON fields are reordered during recovery', async () => {
    const original = snapshot();
    const reordered = { request: Object.fromEntries(Object.entries(original.request).reverse()), isSupplement: false,
      medicineName: original.medicineName, version: 1 } as SavedMedicineDose;
    storage.setItem(medicineDoseStorageKey(scope), JSON.stringify(reordered));
    expect(await mutateMedicineDose(scope, 'create', original)).toEqual({ status: 'saved', snapshot: original });
    expect(await mutateMedicineDose(scope, 'remove', original)).toEqual({ status: 'removed' });
  });

  it('distinguishes missing storage, malformed JSON, and unavailable storage', () => {
    expect(readMedicineDose(scope)).toEqual({ status: 'missing' });
    storage.setItem(medicineDoseStorageKey(scope), '{broken');
    expect(readMedicineDose(scope)).toEqual({ status: 'invalid' });
    storage.getItem = () => { throw new Error('Storage is unavailable'); };
    expect(readMedicineDose(scope)).toEqual({ status: 'unavailable' });
  });

  it.each(['throw', 'no-op'])('fails closed when persistence cannot be verified: %s', async mode => {
    storage.setItem = () => { if (mode === 'throw') throw new Error('Quota exceeded'); };
    expect((await mutateMedicineDose(scope, 'create', snapshot())).status).toBe('unavailable');
    expect(storage.data.size).toBe(0);
  });

  it('keeps the saved request when storage becomes unreadable after dispatch', async () => {
    const original = snapshot(); await mutateMedicineDose(scope, 'create', original);
    const persisted = storage.data.get(medicineDoseStorageKey(scope));
    storage.getItem = () => { throw new Error('Blocked'); };
    expect(await mutateMedicineDose(scope, 'remove', original)).toEqual({ status: 'unavailable' });
    expect(storage.data.get(medicineDoseStorageKey(scope))).toBe(persisted);
  });

  it('does not dispatch a storage mutation without cross-tab lock support', async () => {
    vi.stubGlobal('navigator', {});
    expect(await mutateMedicineDose(scope, 'create', snapshot())).toEqual({ status: 'locking-unavailable' });
    expect(storage.data.size).toBe(0);
  });

  it('abandons a queued lock request at its deadline without writing after the timeout', async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    vi.stubGlobal('navigator', { locks: { request: (_key: string, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Lock acquisition aborted'))));
    } } });
    const result = mutateMedicineDose(scope, 'create', snapshot());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await result).toEqual({ status: 'locking-unavailable' });
    expect(signal?.aborted).toBe(true); expect(storage.data.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { requestId: 'invalid' }, { medicineId: '' }, { time: 'invalid' }, { doseAmount: Number.NaN },
    { doseAmount: -1 }, { unitAbbr: {} }, { notes: [] }, { babyId: 'other-child' }, { caretakerId: 'injected' },
  ])('refuses a malformed frozen request without erasing it: %j', patch => {
    const malformed = { ...snapshot(), request: { ...snapshot().request, ...patch } };
    expect(parseSavedMedicineDose(malformed)).toBeNull();
    storage.setItem(medicineDoseStorageKey(scope), JSON.stringify(malformed));
    expect(readMedicineDose(scope).status).toBe('invalid');
    expect(storage.data.size).toBe(1);
  });
});

describe('complete authenticated medication request deadline', () => {
  it.each(['fetch-or-refresh', 'body'])('keeps the original request and aborts an uncertain %s stall after 20 seconds', async stage => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    const original = snapshot();
    await mutateMedicineDose(scope, 'create', original);
    const never = new Promise<never>(() => {});
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
      signal = options?.signal as AbortSignal;
      return stage === 'fetch-or-refresh' ? never : { json: () => never } as unknown as Response;
    });
    const result = requestMedicineDoseJSON(fetcher, original.request);
    const rejection = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(20_000); await rejection;
    expect(signal?.aborted).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toEqual(original.request);
    expect(readMedicineDose(scope)).toEqual({ status: 'saved', snapshot: original });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the deadline after reading a response body', async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    const response = new Response(JSON.stringify({ success: false, error: 'Synthetic rejection' }), { status: 400 });
    const result = await requestMedicineDoseJSON(async (_url, options) => { signal = options?.signal as AbortSignal; return response; }, snapshot().request);
    expect(result.response.status).toBe(400);
    expect(result.data).toEqual({ success: false, error: 'Synthetic rejection' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000); expect(signal?.aborted).toBe(false);
  });
});
