import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSessionLifecycleForTests, captureAuthSession, finishLogoutAfterFailure, getLogoutPhase,
  isAuthSessionCurrent, isLogoutInProgress, LOGOUT_PHASE_TIMEOUT_MS, logoutAuthSession,
  refreshAuthToken, retryAuthLogout, subscribeToLogout,
} from '../src/utils/session-lifecycle';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const response = (status = 200) => new Response('{}', { status });
const refreshed = (token: string) => Response.json({ success: true, data: { token } });
const asFetch = (fn: unknown) => fn as typeof fetch;
const optionsOf = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls[0][1] as RequestInit;
let store: Map<string, string>;

beforeEach(() => {
  vi.useFakeTimers();
  store = new Map([['authToken', 'original-token'], ['caretakerId', 'actor-a'], ['unlockTime', '1']]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key),
  });
  __resetSessionLifecycleForTests();
});
afterEach(() => { __resetSessionLifecycleForTests(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('owned document logout', () => {
  it('joins manual and automatic calls and gives only the first caller terminal authority', async () => {
    const held = deferred<Response>(), fetchFn = vi.fn(() => held.promise);
    const firstNavigate = vi.fn(), secondNavigate = vi.fn();
    const first = logoutAuthSession(firstNavigate, asFetch(fetchFn));
    const second = logoutAuthSession(secondNavigate, asFetch(fetchFn));
    expect(first).toBe(second);
    expect(isLogoutInProgress()).toBe(true);
    await Promise.resolve(); expect(fetchFn).toHaveBeenCalledTimes(1);
    held.resolve(response()); await first;
    expect(firstNavigate).toHaveBeenCalledTimes(1); expect(secondNavigate).not.toHaveBeenCalled();
    expect(getLogoutPhase()).toBe('navigating');
    await logoutAuthSession(secondNavigate, asFetch(fetchFn));
    expect(fetchFn).toHaveBeenCalledTimes(1); expect(secondNavigate).not.toHaveBeenCalled();
  });

  it('clears only the original auth keys and preserves scoped pending care', async () => {
    for (const key of ['accountUser', 'attempts', 'lockoutTime', 'medicineDosePendingV1:scope', 'journal-outbox', 'nurseryPumpSessionV2:scope', 'nurserySleep:scope', 'nurseryQuickCare:scope']) store.set(key, 'retained');
    await logoutAuthSession(vi.fn(), asFetch(vi.fn(async () => response())));
    for (const key of ['authToken', 'caretakerId', 'unlockTime', 'accountUser', 'attempts', 'lockoutTime']) expect(store.has(key)).toBe(false);
    for (const key of ['medicineDosePendingV1:scope', 'journal-outbox', 'nurseryPumpSessionV2:scope', 'nurserySleep:scope', 'nurseryQuickCare:scope']) expect(store.get(key)).toBe('retained');
  });

  it('preserves the account button’s narrower auth-key contract and original account identity', async () => {
    const token = `header.${btoa(JSON.stringify({ isAccountAuth: true }))}.signature`;
    store.set('authToken', token); store.set('attempts', '2'); store.set('lockoutTime', 'future');
    const navigate = vi.fn();
    await logoutAuthSession(navigate, asFetch(vi.fn(async () => response())), ['authToken', 'accountUser', 'unlockTime', 'caretakerId']);
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ token, caretakerId: 'actor-a', isAccountAuth: true }));
    expect(store.get('attempts')).toBe('2'); expect(store.get('lockoutTime')).toBe('future');
  });

  it('does not dispatch for a replaced owner before its queued operation starts', async () => {
    const fetchFn = vi.fn(async () => response()), navigate = vi.fn();
    const pending = logoutAuthSession(navigate, asFetch(fetchFn));
    store.set('authToken', 'actor-b-token'); store.set('caretakerId', 'actor-b');
    await pending;
    expect(fetchFn).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled();
    expect(store.get('authToken')).toBe('actor-b-token'); expect(getLogoutPhase()).toBe('idle');
  });

  it('does not clear or navigate a replacement owner after an already-dispatched request settles', async () => {
    const held = deferred<Response>(), navigate = vi.fn();
    const pending = logoutAuthSession(navigate, asFetch(vi.fn(() => held.promise)));
    await Promise.resolve(); store.set('authToken', 'actor-b-token'); store.set('caretakerId', 'actor-b');
    held.resolve(response()); await pending;
    expect(navigate).not.toHaveBeenCalled(); expect(store.get('authToken')).toBe('actor-b-token');
  });

  it('retains a rejected request for explicit retry with the same owner and finalizer', async () => {
    const fetchFn = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(response());
    const navigate = vi.fn(), changes = vi.fn(); const unsubscribe = subscribeToLogout(changes);
    await logoutAuthSession(navigate, asFetch(fetchFn));
    expect(getLogoutPhase()).toBe('failed'); expect(navigate).not.toHaveBeenCalled();
    expect(store.get('authToken')).toBe('original-token');
    await retryAuthLogout();
    expect(fetchFn).toHaveBeenCalledTimes(2); expect(navigate).toHaveBeenCalledTimes(1);
    for (const [, options] of fetchFn.mock.calls) expect(options.headers.Authorization).toBe('Bearer original-token');
    expect(changes).toHaveBeenCalled(); unsubscribe();
  });

  it('retains server rejection instead of declaring logout complete', async () => {
    const navigate = vi.fn();
    await logoutAuthSession(navigate, asFetch(vi.fn(async () => response(500))));
    expect(getLogoutPhase()).toBe('failed'); expect(navigate).not.toHaveBeenCalled();
    expect(store.get('authToken')).toBe('original-token');
  });

  it('aborts a hung logout before offering local sign-out and ignores a late response', async () => {
    const held = deferred<Response>(), fetchFn = vi.fn(() => held.promise), navigate = vi.fn();
    const pending = logoutAuthSession(navigate, asFetch(fetchFn));
    await vi.advanceTimersByTimeAsync(LOGOUT_PHASE_TIMEOUT_MS);
    await pending;
    expect(optionsOf(fetchFn).signal!.aborted).toBe(true);
    expect(getLogoutPhase()).toBe('failed'); expect(navigate).not.toHaveBeenCalled();
    finishLogoutAfterFailure(); expect(navigate).toHaveBeenCalledTimes(1);
    held.resolve(response()); await Promise.resolve(); await Promise.resolve();
    expect(navigate).toHaveBeenCalledTimes(1); expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('bounds a hung response body as well as fetch', async () => {
    const body = deferred<ArrayBuffer>(), navigate = vi.fn();
    const fetchFn = vi.fn(async () => ({ ok: true, arrayBuffer: () => body.promise }));
    const pending = logoutAuthSession(navigate, asFetch(fetchFn));
    await vi.advanceTimersByTimeAsync(LOGOUT_PHASE_TIMEOUT_MS); await pending;
    expect(optionsOf(fetchFn).signal!.aborted).toBe(true);
    expect(getLogoutPhase()).toBe('failed'); expect(navigate).not.toHaveBeenCalled();
    body.resolve(new ArrayBuffer(0)); await Promise.resolve(); expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps input blocked after assigning a destination and provides recovery if navigation never finishes', async () => {
    const navigate = vi.fn(), fetchFn = vi.fn(async () => response());
    await logoutAuthSession(navigate, asFetch(fetchFn));
    expect(getLogoutPhase()).toBe('navigating');
    await vi.advanceTimersByTimeAsync(LOGOUT_PHASE_TIMEOUT_MS);
    expect(getLogoutPhase()).toBe('navigation-failed');
    await retryAuthLogout(); expect(fetchFn).toHaveBeenCalledTimes(1);
    finishLogoutAfterFailure(); expect(navigate).toHaveBeenCalledTimes(2);
    expect(getLogoutPhase()).toBe('navigating');
  });

  it('retains navigation recovery when assigning the location throws after auth keys were cleared', async () => {
    const navigate = vi.fn().mockImplementationOnce(() => { throw new Error('Navigation blocked'); });
    await logoutAuthSession(navigate, asFetch(vi.fn(async () => response())));
    expect(store.has('authToken')).toBe(false); expect(getLogoutPhase()).toBe('navigation-failed');
    finishLogoutAfterFailure(); expect(navigate).toHaveBeenCalledTimes(2);
    expect(getLogoutPhase()).toBe('navigating');
  });
});

describe('refresh ownership and logout cookie ordering', () => {
  it('keeps normal refresh in the same session generation while new-login tokens invalidate it', async () => {
    const owner = captureAuthSession(); store.set('unlockTime', '234');
    expect(isAuthSessionCurrent(owner)).toBe(true);
    expect(await refreshAuthToken(asFetch(vi.fn(async () => refreshed('rotated'))))).toBe(true);
    expect(isAuthSessionCurrent(owner)).toBe(true);
    store.set('authToken', 'new-login-same-caretaker'); expect(isAuthSessionCurrent(owner)).toBe(false);
  });

  it('drains a successful in-flight refresh before logout and never publishes its obsolete token', async () => {
    const held = deferred<Response>(); const refreshFetch = vi.fn(() => held.promise);
    const refreshing = refreshAuthToken(asFetch(refreshFetch));
    const logoutFetch = vi.fn(async () => response()), navigate = vi.fn();
    const pending = logoutAuthSession(navigate, asFetch(logoutFetch));
    await Promise.resolve(); expect(logoutFetch).not.toHaveBeenCalled();
    const forbiddenRefresh = vi.fn(); expect(await refreshAuthToken(asFetch(forbiddenRefresh))).toBe(false);
    expect(forbiddenRefresh).not.toHaveBeenCalled();
    held.resolve(refreshed('obsolete-rotation')); expect(await refreshing).toBe(false); await pending;
    expect(logoutFetch).toHaveBeenCalledTimes(1); expect(navigate).toHaveBeenCalledTimes(1);
    expect(store.has('authToken')).toBe(false);
  });

  it('only logout bounds a hung refresh and aborts it before the final logout request', async () => {
    const held = deferred<Response>(), refreshFetch = vi.fn(() => held.promise);
    const refreshing = refreshAuthToken(asFetch(refreshFetch));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(optionsOf(refreshFetch).signal!.aborted).toBe(false);
    const logoutFetch = vi.fn(async () => {
      expect(optionsOf(refreshFetch).signal!.aborted).toBe(true);
      return response();
    });
    const pending = logoutAuthSession(vi.fn(), asFetch(logoutFetch));
    await vi.advanceTimersByTimeAsync(LOGOUT_PHASE_TIMEOUT_MS); expect(await refreshing).toBe(false); await pending;
    expect(logoutFetch).toHaveBeenCalledTimes(1);
    held.resolve(refreshed('late-token')); await Promise.resolve(); await Promise.resolve();
    expect(store.has('authToken')).toBe(false);
  });

  it('also aborts a held refresh JSON body before logout', async () => {
    const body = deferred<unknown>(); const refreshFetch = vi.fn(async () => ({ ok: true, json: () => body.promise }));
    const refreshing = refreshAuthToken(asFetch(refreshFetch)); await Promise.resolve();
    const logoutFetch = vi.fn(async () => response()); const pending = logoutAuthSession(vi.fn(), asFetch(logoutFetch));
    await vi.advanceTimersByTimeAsync(LOGOUT_PHASE_TIMEOUT_MS); await refreshing; await pending;
    expect(optionsOf(refreshFetch).signal!.aborted).toBe(true); expect(logoutFetch).toHaveBeenCalledTimes(1);
    body.resolve({ success: true, data: { token: 'obsolete-body-token' } }); await Promise.resolve();
    expect(store.has('authToken')).toBe(false);
  });

  it('aborts an obsolete refresh without guessing cookie ownership or replacing the newer token', async () => {
    const held = deferred<Response>(), oldFetch = vi.fn(() => held.promise);
    const oldRefresh = refreshAuthToken(asFetch(oldFetch));
    store.set('authToken', 'new-login-token'); store.set('caretakerId', 'actor-b');
    const newFetch = vi.fn(async () => refreshed('new-owner-rotation'));
    const newRefresh = refreshAuthToken(asFetch(newFetch)); expect(newFetch).not.toHaveBeenCalled();
    expect(optionsOf(oldFetch).signal!.aborted).toBe(true); expect(await oldRefresh).toBe(false);
    expect(await newRefresh).toBe(false); expect(newFetch).not.toHaveBeenCalled();
    held.resolve(refreshed('obsolete-actor-a')); await Promise.resolve(); await Promise.resolve();
    expect(store.get('authToken')).toBe('new-login-token'); expect(store.get('caretakerId')).toBe('actor-b');
  });
});
