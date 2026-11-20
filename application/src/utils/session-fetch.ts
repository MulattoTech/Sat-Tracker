import { isRootSlugPath, should401AttemptRefresh } from './session-timeout';
import { captureAuthSession, isAuthSessionCurrent, refreshAuthToken } from './session-lifecycle';

/** The provider owns both this interceptor and every delayed logout it schedules. */
export function createAuthFetchInterceptor({
  fetchFn,
  onLogout,
  pathname = () => window.location.pathname,
}: {
  fetchFn: typeof fetch;
  onLogout?: (reason?: string) => void;
  pathname?: () => string;
}): { fetch: typeof fetch; dispose: () => void } {
  let active = true;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const intercepted: typeof fetch = async (...args) => {
    const owner = captureAuthSession();
    const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request)?.url;
    const isApiCall = typeof url === 'string' && (url.startsWith('/api') || url.includes('/api/'));
    if (isApiCall && owner.token) {
      const options = args[1] || {};
      const headers = new Headers(options.headers || {});
      if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${owner.token}`);
      args[1] = { ...options, headers };
    }
    const mayAct = () => active && !args[1]?.signal?.aborted && isAuthSessionCurrent(owner);
    let response = await fetchFn(...args);
    if (response.status === 401 && should401AttemptRefresh(url) && mayAct()) {
      const refreshed = await refreshAuthToken(fetchFn);
      if (!mayAct()) return response;
      if (refreshed && typeof args[0] === 'string') {
        const headers = new Headers(args[1]?.headers || {});
        const token = localStorage.getItem('authToken');
        if (token) headers.set('Authorization', `Bearer ${token}`);
        response = await fetchFn(args[0], { ...args[1], headers });
      } else if (!refreshed && !isRootSlugPath(pathname()) && onLogout) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          // Recheck at dispatch: a login page, newer session or claimed logout
          // can supersede the failed request during this delay.
          if (mayAct() && !isRootSlugPath(pathname())) onLogout('logout-401');
        }, 100);
        timers.add(timer);
      }
    }
    return response;
  };
  return {
    fetch: intercepted,
    dispose: () => {
      active = false;
      timers.forEach(timer => clearTimeout(timer));
      timers.clear();
    },
  };
}
