import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthFetchInterceptor } from '../src/utils/session-fetch';
import { __resetSessionLifecycleForTests, logoutAuthSession } from '../src/utils/session-lifecycle';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const denied = () => new Response('{}', { status: 401 });
const ok = () => new Response('{}', { status: 200 });
let store: Map<string, string>;
beforeEach(() => {
  vi.useFakeTimers(); store = new Map([['authToken', 'actor-a-token'], ['caretakerId', 'actor-a']]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key),
  });
  __resetSessionLifecycleForTests();
});
afterEach(() => { __resetSessionLifecycleForTests(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('provider request ownership', () => {
  it('keeps ordinary current-session refresh/retry and the original method, body and signal', async () => {
    const controller = new AbortController(), onLogout = vi.fn();
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(denied())
      .mockResolvedValueOnce(Response.json({ success: true, data: { token: 'rotated-token' } }))
      .mockResolvedValueOnce(ok());
    const interceptor = createAuthFetchInterceptor({ fetchFn, onLogout, pathname: () => '/family/log-entry' });
    const result = await interceptor.fetch('/api/medicine-log', { method: 'POST', body: '{"notes":"retained"}', signal: controller.signal });
    expect(result.status).toBe(200);
    expect(fetchFn.mock.calls[2][1]).toMatchObject({ method: 'POST', body: '{"notes":"retained"}', signal: controller.signal });
    expect(new Headers(fetchFn.mock.calls[2][1]?.headers).get('Authorization')).toBe('Bearer rotated-token');
    expect(onLogout).not.toHaveBeenCalled(); interceptor.dispose();
  });

  it('still logs out an actually expired current session after a rejected refresh', async () => {
    const onLogout = vi.fn(), fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => denied());
    const interceptor = createAuthFetchInterceptor({ fetchFn, onLogout, pathname: () => '/family/log-entry' });
    expect((await interceptor.fetch('/api/medicine-log')).status).toBe(401);
    expect(onLogout).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(100);
    expect(onLogout).toHaveBeenCalledExactlyOnceWith('logout-401'); interceptor.dispose();
  });

  it('does not refresh or log out a newer owner for a late old 401', async () => {
    const held = deferred<Response>(), onLogout = vi.fn(), fetchFn = vi.fn<typeof fetch>().mockImplementation(() => held.promise);
    const interceptor = createAuthFetchInterceptor({ fetchFn, onLogout, pathname: () => '/family/log-entry' });
    const pending = interceptor.fetch('/api/medicine-log');
    store.set('authToken', 'actor-b-token'); store.set('caretakerId', 'actor-b');
    held.resolve(denied()); expect((await pending).status).toBe(401);
    await vi.advanceTimersByTimeAsync(100); expect(fetchFn).toHaveBeenCalledTimes(1); expect(onLogout).not.toHaveBeenCalled();
    interceptor.dispose();
  });

  it('cancels scheduled logout when the provider is disposed', async () => {
    const onLogout = vi.fn(), fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => denied());
    const interceptor = createAuthFetchInterceptor({ fetchFn, onLogout, pathname: () => '/family/log-entry' });
    await interceptor.fetch('/api/medicine-log'); interceptor.dispose();
    await vi.advanceTimersByTimeAsync(100); expect(onLogout).not.toHaveBeenCalled();
  });

  it('rechecks the login pathname at delayed dispatch', async () => {
    let pathname = '/family/log-entry'; const onLogout = vi.fn();
    const interceptor = createAuthFetchInterceptor({ fetchFn: vi.fn<typeof fetch>().mockImplementation(async () => denied()), onLogout, pathname: () => pathname });
    await interceptor.fetch('/api/medicine-log'); pathname = '/family';
    await vi.advanceTimersByTimeAsync(100); expect(onLogout).not.toHaveBeenCalled(); interceptor.dispose();
  });

  it('rechecks a replacement login before delayed dispatch', async () => {
    const onLogout = vi.fn();
    const interceptor = createAuthFetchInterceptor({ fetchFn: vi.fn<typeof fetch>().mockImplementation(async () => denied()), onLogout, pathname: () => '/family/log-entry' });
    await interceptor.fetch('/api/medicine-log'); store.set('authToken', 'new-login-same-actor');
    await vi.advanceTimersByTimeAsync(100); expect(onLogout).not.toHaveBeenCalled(); interceptor.dispose();
  });

  it('does not dispatch a scheduled automatic logout after manual logout claims ownership', async () => {
    const onLogout = vi.fn(), logoutResponse = deferred<Response>();
    const interceptor = createAuthFetchInterceptor({ fetchFn: vi.fn<typeof fetch>().mockImplementation(async () => denied()), onLogout, pathname: () => '/family/log-entry' });
    await interceptor.fetch('/api/medicine-log');
    const manual = logoutAuthSession(vi.fn(), vi.fn<typeof fetch>().mockImplementation(() => logoutResponse.promise));
    await vi.advanceTimersByTimeAsync(100); expect(onLogout).not.toHaveBeenCalled();
    logoutResponse.resolve(ok()); await manual; interceptor.dispose();
  });

  it('does not replay a request whose caller aborted while refresh was held', async () => {
    const held = deferred<Response>(), controller = new AbortController(), onLogout = vi.fn();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(denied()).mockImplementationOnce(() => held.promise);
    const interceptor = createAuthFetchInterceptor({ fetchFn, onLogout, pathname: () => '/family/log-entry' });
    const pending = interceptor.fetch('/api/medicine-log', { method: 'DELETE', signal: controller.signal });
    await Promise.resolve(); controller.abort(); held.resolve(Response.json({ success: true, data: { token: 'rotated' } }));
    expect((await pending).status).toBe(401); expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(onLogout).not.toHaveBeenCalled(); interceptor.dispose();
  });

  it('does not let a disposed provider’s outstanding refresh initiate a new logout', async () => {
    const held = deferred<Response>(), onLogout = vi.fn();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(denied()).mockImplementationOnce(() => held.promise);
    const interceptor = createAuthFetchInterceptor({ fetchFn, onLogout, pathname: () => '/family/log-entry' });
    const pending = interceptor.fetch('/api/medicine-log'); await Promise.resolve(); interceptor.dispose();
    held.resolve(denied()); await pending; await vi.advanceTimersByTimeAsync(100);
    expect(onLogout).not.toHaveBeenCalled(); expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('leaves ordinary authentication endpoint failures to their form', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => denied()), onLogout = vi.fn();
    const interceptor = createAuthFetchInterceptor({ fetchFn, onLogout, pathname: () => '/family' });
    expect((await interceptor.fetch('/api/auth', { method: 'POST' })).status).toBe(401);
    await vi.advanceTimersByTimeAsync(100); expect(fetchFn).toHaveBeenCalledTimes(1); expect(onLogout).not.toHaveBeenCalled();
    interceptor.dispose();
  });
});
