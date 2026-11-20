/** One browser document owns a refresh/logout transition. This is not a cross-tab lock. */
export interface AuthSessionSnapshot {
  readonly generation: number;
  readonly token: string | null;
  readonly caretakerId: string | null;
}

export interface LogoutOwner extends AuthSessionSnapshot {
  readonly isAccountAuth: boolean;
}

let generation = 0;
let observedToken: string | null | undefined;
let observedCaretakerId: string | null | undefined;
export const LOGOUT_PHASE_TIMEOUT_MS = 15_000;
export type LogoutPhase = 'idle' | 'pending' | 'failed' | 'navigating' | 'navigation-failed';
type AuthKey = 'unlockTime' | 'caretakerId' | 'authToken' | 'accountUser' | 'attempts' | 'lockoutTime';
const defaultAuthKeys: readonly AuthKey[] = ['unlockTime', 'caretakerId', 'authToken', 'accountUser', 'attempts', 'lockoutTime'];
let inFlightRefresh: { owner: AuthSessionSnapshot; controller: AbortController; promise: Promise<boolean> } | null = null;
interface LogoutOperation {
  generation: number;
  phase: Exclude<LogoutPhase, 'idle'>;
  promise: Promise<void>;
  owner: LogoutOwner;
  navigate: (owner: LogoutOwner) => void;
  fetchFn: typeof fetch;
  clearKeys: readonly AuthKey[];
  navigationTimer?: ReturnType<typeof setTimeout>;
}
let logout: LogoutOperation | null = null;
const listeners = new Set<() => void>();

/** Token replacement by a new login changes ownership; ordinary activity does not. */
export function captureAuthSession(): AuthSessionSnapshot {
  const token = localStorage.getItem('authToken');
  const caretakerId = localStorage.getItem('caretakerId');
  if (token !== observedToken || caretakerId !== observedCaretakerId) {
    observedToken = token;
    observedCaretakerId = caretakerId;
    generation++;
  }
  return { generation, token, caretakerId };
}

export function isAuthSessionCurrent(session: AuthSessionSnapshot): boolean {
  return !logout && captureAuthSession().generation === session.generation;
}

export function isLogoutInProgress(): boolean {
  return logout !== null;
}

export function getLogoutPhase(): LogoutPhase {
  return logout?.phase ?? 'idle';
}

export function subscribeToLogout(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Cookie-only refresh remains supported, including when no access token is stored. */
export function refreshAuthToken(fetchFn: typeof fetch = fetch): Promise<boolean> {
  if (logout) return Promise.resolve(false);
  const owner = captureAuthSession();
  if (inFlightRefresh) {
    if (inFlightRefresh.owner.generation === owner.generation) return inFlightRefresh.promise;
    // Abort undelivered obsolete work. Its headers may already have rotated a
    // cookie, so do not guess that another refresh belongs to the new owner.
    // Fail closed; a caller which needs refresh may require sign-in again.
    const obsolete = inFlightRefresh;
    obsolete.controller.abort();
    return obsolete.promise.then(() => false);
  }
  const controller = new AbortController();
  let onAbort: () => void;
  const aborted = new Promise<boolean>(resolve => {
    onAbort = () => resolve(false);
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const entry = { owner, controller, promise: Promise.resolve(false) };
  entry.promise = Promise.race([doRefresh(owner, fetchFn, controller.signal), aborted]).finally(() => {
    controller.signal.removeEventListener('abort', onAbort);
    if (inFlightRefresh === entry) inFlightRefresh = null;
  });
  inFlightRefresh = entry;
  return entry.promise;
}

async function doRefresh(owner: AuthSessionSnapshot, fetchFn: typeof fetch, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetchFn('/api/auth/refresh-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
    });
    if (response.ok) {
      const data = await response.json();
      if (!signal.aborted && data.success && data.data?.token && isAuthSessionCurrent(owner)) {
        localStorage.setItem('authToken', data.data.token);
        // Rotation belongs to the same session. Requests already in flight may
        // retry with this token, but a later login must invalidate their authority.
        observedToken = data.data.token;
        if (localStorage.getItem('unlockTime')) {
          localStorage.setItem('unlockTime', Date.now().toString());
        }
        return true;
      }
    } else {
      await response.body?.cancel();
    }
    return false;
  } catch (error) {
    if (!signal.aborted) console.error('Error refreshing access token:', error);
    return false;
  }
}

/**
 * Claim synchronously, join duplicate callers, and let exactly one caller
 * clear authentication and navigate. The claim stays active until the owned
 * document navigation destroys this module; assigning location is not a
 * completed navigation and must not expose a login form in the old document.
 */
export function logoutAuthSession(
  navigate: (owner: LogoutOwner) => void,
  fetchFn: typeof fetch = fetch,
  clearKeys: readonly AuthKey[] = defaultAuthKeys,
): Promise<void> {
  if (logout) return logout.promise;
  const session = captureAuthSession();
  let isAccountAuth = false;
  if (session.token) {
    try { isAccountAuth = Boolean(JSON.parse(atob(session.token.split('.')[1])).isAccountAuth); }
    catch { /* A malformed token must still be cleared by an explicit logout. */ }
  }
  const operation: LogoutOperation = { generation: ++generation, phase: 'pending', promise: Promise.resolve(),
    owner: { ...session, isAccountAuth }, navigate, fetchFn, clearKeys };
  logout = operation;
  operation.promise = Promise.resolve().then(() => performLogout(operation));
  listeners.forEach(listener => listener());
  return operation.promise;
}

function stillOwned(operation: LogoutOperation): boolean {
  if (logout === operation && captureAuthSession().generation === operation.generation) return true;
  if (logout === operation) { logout = null; listeners.forEach(listener => listener()); }
  return false;
}

async function performLogout(operation: LogoutOperation): Promise<void> {
  // Only logout bounds this drain; ordinary refresh retains its existing
  // caller deadlines. Abort the original request before allowing sign-in.
  const refresh = inFlightRefresh;
  if (refresh) {
    const timer = setTimeout(() => refresh.controller.abort(), LOGOUT_PHASE_TIMEOUT_MS);
    try { await refresh.promise; } finally { clearTimeout(timer); }
  }
  if (!stillOwned(operation)) return;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Logout confirmation timed out'));
    }, LOGOUT_PHASE_TIMEOUT_MS);
  });
  try {
    await Promise.race([timeout, (async () => {
      const response = await operation.fetchFn('/api/auth/logout', {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json',
          Authorization: operation.owner.token ? `Bearer ${operation.owner.token}` : '' },
      });
      await response.arrayBuffer();
      if (!response.ok) throw new Error('Logout was not confirmed');
    })()]);
    if (stillOwned(operation)) finishLogout(operation);
  } catch {
    if (stillOwned(operation)) {
      operation.phase = 'failed';
      listeners.forEach(listener => listener());
    }
  } finally { clearTimeout(timer!); }
}

function finishLogout(operation: LogoutOperation): void {
  operation.phase = 'navigating';
  clearTimeout(operation.navigationTimer);
  try {
    // Authentication keys only: scoped care drafts survive logout.
    for (const key of operation.clearKeys) localStorage.removeItem(key);
    // Clearing our own keys belongs to this transition, not a replacement login.
    operation.generation = captureAuthSession().generation;
    if (operation.owner.caretakerId && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('caretakerChanged', { detail: { caretakerId: null } }));
    }
    listeners.forEach(listener => listener());
    operation.navigationTimer = setTimeout(() => {
      if (stillOwned(operation)) {
        operation.phase = 'navigation-failed';
        listeners.forEach(listener => listener());
      }
    }, LOGOUT_PHASE_TIMEOUT_MS);
    operation.navigate(operation.owner);
  }
  catch {
    clearTimeout(operation.navigationTimer);
    // A synchronous storage/navigation failure must retain recovery controls.
    operation.generation = captureAuthSession().generation;
    operation.phase = 'navigation-failed';
    listeners.forEach(listener => listener());
  }
}

/** An explicit retry keeps the first owner's token, destination and finalizer. */
export function retryAuthLogout(): Promise<void> {
  const operation = logout;
  if (!operation || operation.phase !== 'failed' || !stillOwned(operation)) return Promise.resolve();
  operation.phase = 'pending';
  operation.promise = Promise.resolve().then(() => performLogout(operation));
  listeners.forEach(listener => listener());
  return operation.promise;
}

/** Available only after the network phase is terminal, including its abort. */
export function finishLogoutAfterFailure(): void {
  const operation = logout;
  if (operation && (operation.phase === 'failed' || operation.phase === 'navigation-failed') && stillOwned(operation)) {
    finishLogout(operation);
  }
}

/** Test-only: a fresh document has no active transition or observed session. */
export function __resetSessionLifecycleForTests(): void {
  clearTimeout(logout?.navigationTimer);
  generation = 0;
  observedToken = undefined;
  observedCaretakerId = undefined;
  inFlightRefresh = null;
  logout = null;
  listeners.clear();
}
