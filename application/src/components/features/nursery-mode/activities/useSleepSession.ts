'use client';

import { useEffect, useRef, useState } from 'react';
import { useFamily } from '@/src/context/family';
import { journalScopeFromToken } from '@/src/lib/bottle-journal/outbox-identity';
import { mutateSleepIntent, normalizeSleepIntent, readSleepIntent, sleepIntentKey, type SleepIntent, type SleepIntentMutationResult } from '@/src/utils/nursery/sleepIntent';
import { requestSleepJSON } from '@/src/utils/nursery/sleepRequest';
import { matchesSleepStart, readNurserySleep, sleepIntentRequest, type NurserySleep } from '@/src/utils/nursery/sleepView';

type Review = 'unchecked' | 'current' | 'changed' | 'missing' | 'completed';
interface SleepView {
  scope: string | null; active: NurserySleep | null; pending: SleepIntent | null; review: Review;
  loaded: boolean; ambiguous: boolean; inspected: boolean; storageBlocked: boolean; busy: boolean; error: string | null;
}
export interface SleepConfirmation { intent: SleepIntent; row: NurserySleep | null }
const initial = (): SleepView => ({ scope: null, active: null, pending: null, review: 'unchecked',
  loaded: false, ambiguous: false, inspected: false, storageBlocked: false, busy: false, error: null });
const storageWriteError = 'This tab could not save the sleep action. Keep this page open and check browser storage. No request was sent on this attempt.';
const storageReadError = 'This tab could not read its saved sleep action. Keep this page open and check the care log and browser storage.';
const unconfirmedError = 'The sleep action was not confirmed. Its original time is kept. Retry or reload and review the care log.';
const changedError = 'The sleep record changed or another timer is active. Your saved action is kept. Reload and review the care log.';
const missingError = 'The sleep record was not found. The action may already be saved. Review the care log before dismissing it.';
const loadError = 'Could not check the current sleep state. Reload before starting or changing a sleep.';
const ambiguousError = 'More than one sleep is active. Review the care log before changing a timer.';
const lockingError = 'This browser cannot safely coordinate saved sleep actions. Keep this page open and use a browser with Web Locks support before saving.';
const lockBusyError = 'Another tab is updating the saved sleep action. Keep this page open and retry.';
const changedLocalError = 'The saved sleep action changed in another tab. Its current state has been kept. Reload before continuing.';
const mutationError = (result: SleepIntentMutationResult) => result.status === 'locking-unavailable' ? lockingError
  : result.status === 'busy' ? lockBusyError : storageWriteError;

/** Sleep intent is owned by family/actor/child and persisted on this browser. Every async
 * completion checks its scope and request epoch before changing the visible UI. */
export function useSleepSession(babyId: string) {
  const { family, authenticatedFetch } = useFamily();
  const environment = useRef({ family, babyId, authenticatedFetch });
  environment.current = { family, babyId, authenticatedFetch };
  const [view, setView] = useState<SleepView>(initial);
  const current = useRef(view), mounted = useRef(false);
  const owner = useRef({ scope: null as string | null, epoch: 0, request: 0 });
  const memory = useRef(new Map<string, { intent: SleepIntent; persisted: boolean }>());
  const [elapsed, setElapsed] = useState(0);
  const show = (patch: Partial<SleepView>) => { current.current = { ...current.current, ...patch }; setView(current.current); };
  const scopeNow = () => {
    try { return journalScopeFromToken(localStorage.getItem('authToken'), environment.current.family?.id, environment.current.babyId); }
    catch { return null; }
  };
  const isCurrent = (capture: { scope: string; epoch: number; request: number }) => mounted.current
    && owner.current.scope === capture.scope && owner.current.epoch === capture.epoch
    && owner.current.request === capture.request && scopeNow() === capture.scope;
  function finish(capture: { scope: string; epoch: number; request: number }) {
    if (!mounted.current || owner.current.scope !== capture.scope || owner.current.epoch !== capture.epoch) return;
    if (scopeNow() !== capture.scope) { selectOwner(); return; }
    if (owner.current.request === capture.request) show({ busy: false });
  }
  function begin() {
    if (!mounted.current) return null;
    if (scopeNow() !== owner.current.scope) { selectOwner(); return null; }
    if (!owner.current.scope || current.current.busy) return null;
    const capture = { scope: owner.current.scope, epoch: owner.current.epoch, request: ++owner.current.request };
    show({ busy: true }); return capture;
  }

  async function loadCurrent(rereadIntent = true) {
    const capture = begin(); if (!capture) return;
    const child = environment.current.babyId, familyId = environment.current.family!.id;
    try {
      if (rereadIntent) {
        const saved = readSleepIntent(capture.scope), known = memory.current.get(capture.scope);
        const storageBlocked = saved.status === 'invalid' || saved.status === 'unavailable';
        const pending = saved.status === 'saved' ? saved.intent : storageBlocked || !known?.persisted ? known?.intent ?? null : null;
        if (pending) memory.current.set(capture.scope, { intent: pending, persisted: saved.status === 'saved' || Boolean(known?.persisted) });
        else memory.current.delete(capture.scope);
        show({ pending, storageBlocked });
      }
      const pending = current.current.pending;
      const { response, data } = await requestSleepJSON(environment.current.authenticatedFetch,
        `/api/sleep-log?babyId=${encodeURIComponent(child)}&activeOnly=true`, { cache: 'no-store' });
      if (!isCurrent(capture)) return;
      if (!response.ok || !data.success || !Array.isArray(data.data)) throw new Error('unconfirmed sleep state');
      const activeRows = data.data.map((row: unknown) => readNurserySleep(row, familyId, child));
      if (activeRows.some((row: NurserySleep | null) => !row || row.endTime !== null || row.deletedAt !== null)) throw new Error('invalid sleep state');
      const ambiguous = activeRows.length > 1, active: NurserySleep | null = activeRows.length === 1 ? activeRows[0] : null;
      let review: Review = pending ? 'current' : 'unchecked';
      if (pending?.kind === 'start') {
        if (ambiguous || (active && !matchesSleepStart(active, pending))) review = 'changed';
      } else if (pending) {
        const target = await requestSleepJSON(environment.current.authenticatedFetch,
          `/api/sleep-log?id=${encodeURIComponent(pending.sleepId)}`, { cache: 'no-store' });
        if (!isCurrent(capture)) return;
        if (target.response.status === 404) review = 'missing';
        else {
          const row = target.response.ok && target.data.success ? readNurserySleep(target.data.data, familyId, child) : null;
          if (!row) throw new Error('unconfirmed sleep record');
          review = row.deletedAt !== null ? 'missing' : row.revision === pending.expectedRevision && !ambiguous ? 'current' : 'changed';
        }
      }
      show({ active, loaded: true, ambiguous, review, inspected: Boolean(pending), error: current.current.storageBlocked
        ? storageReadError : ambiguous ? ambiguousError : review === 'missing' ? missingError : review === 'changed' ? changedError : null });
    } catch { if (isCurrent(capture)) show({ loaded: false, error: current.current.storageBlocked ? storageReadError : loadError }); }
    finally { finish(capture); }
  }

  function selectOwner() {
    const scope = scopeNow(); owner.current = { scope, epoch: owner.current.epoch + 1, request: owner.current.request + 1 };
    const saved = scope ? readSleepIntent(scope) : null, known = scope ? memory.current.get(scope) : null;
    const storageBlocked = saved?.status === 'invalid' || saved?.status === 'unavailable';
    const pending = saved?.status === 'saved' ? saved.intent : storageBlocked || !known?.persisted ? known?.intent ?? null : null;
    if (scope && pending) memory.current.set(scope, { intent: pending, persisted: saved?.status === 'saved' || Boolean(known?.persisted) });
    else if (scope) memory.current.delete(scope);
    current.current = { ...initial(), scope, pending, storageBlocked, error: !scope
      ? 'Sign in as a caregiver for this child before changing sleep.' : storageBlocked ? storageReadError : null };
    setView(current.current); if (scope) void loadCurrent(false);
  }
  useEffect(() => {
    mounted.current = true; selectOwner();
    const checkOwner = () => {
      const scope = scopeNow();
      if (scope !== owner.current.scope) { selectOwner(); return; }
      if (!scope) return;
      const saved = readSleepIntent(scope);
      if (saved.status === 'invalid' || saved.status === 'unavailable') { show({ storageBlocked: true, error: storageReadError }); return; }
      const known = memory.current.get(scope), pending = saved.status === 'saved' ? saved.intent : !known?.persisted ? known?.intent ?? null : null;
      if (JSON.stringify(pending) !== JSON.stringify(current.current.pending)) selectOwner();
    };
    const storage = (event: StorageEvent) => {
      const scope = scopeNow();
      if (event.key === 'authToken' || event.key === null || (scope && event.key === sleepIntentKey(scope))) checkOwner();
    };
    window.addEventListener('storage', storage); window.addEventListener('focus', checkOwner); document.addEventListener('visibilitychange', checkOwner);
    return () => {
      mounted.current = false; owner.current.epoch++; window.removeEventListener('storage', storage);
      window.removeEventListener('focus', checkOwner); document.removeEventListener('visibilitychange', checkOwner);
    };
    // Request callbacks use current refs; identity alone owns the effect lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [family?.id, babyId]);
  useEffect(() => {
    if (!view.active || view.pending || view.storageBlocked || view.ambiguous) { setElapsed(0); return; }
    const start = Date.parse(view.active.startTime), update = () => setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    update(); const timer = setInterval(update, 1000); return () => clearInterval(timer);
  }, [view.active, view.pending, view.storageBlocked, view.ambiguous]);

  function adoptShared(scope: string, intent: SleepIntent | null) {
    if (intent) memory.current.set(scope, { intent, persisted: true }); else memory.current.delete(scope);
    show({ pending: intent, active: null, loaded: false, ambiguous: false, inspected: false,
      review: intent ? 'changed' : 'unchecked', storageBlocked: false, error: changedLocalError });
  }
  async function dispatch(intent: SleepIntent, capture: { scope: string; epoch: number; request: number }): Promise<SleepConfirmation | null> {
    const kind = memory.current.get(intent.scope)?.persisted ? 'verify' : 'create';
    const saved = await mutateSleepIntent(intent.scope, kind, intent, () => isCurrent(capture));
    if (saved.status !== 'saved') {
      if (isCurrent(capture)) {
        if (saved.status === 'changed') adoptShared(intent.scope, saved.intent);
        else if (saved.status !== 'cancelled') show({ error: mutationError(saved) });
      }
      return null;
    }
    memory.current.set(intent.scope, { intent, persisted: true });
    if (!isCurrent(capture)) return null;
    const request = sleepIntentRequest(intent);
    try {
      const { response, data } = await requestSleepJSON(environment.current.authenticatedFetch, request.url, {
        method: request.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.body),
      });
      if (!response.ok || !data.success) {
        if (isCurrent(capture)) show({ review: response.status === 404 ? 'missing' : response.status === 409 ? 'changed' : current.current.review,
          error: response.status === 404 ? missingError : response.status === 409 ? changedError : unconfirmedError });
        return null;
      }
      const row = intent.kind === 'undo-start' ? null : readNurserySleep(data.data, intent.familyId, intent.babyId);
      if (intent.kind !== 'undo-start' && (!row || row.deletedAt !== null || row.startTime !== intent.startTime
        || (intent.kind === 'start' ? !matchesSleepStart(row, intent)
          : row.id !== intent.sleepId || (intent.kind === 'wake' ? row.endTime !== intent.endTime : row.endTime !== null || row.duration !== null)))) {
        throw new Error('Unconfirmed sleep response');
      }
      const cleared = await mutateSleepIntent(intent.scope, 'remove', intent);
      if (cleared.status === 'removed' && JSON.stringify(memory.current.get(capture.scope)?.intent) === JSON.stringify(intent)) memory.current.delete(capture.scope);
      if (!isCurrent(capture)) return null;
      if (cleared.status === 'changed') { adoptShared(intent.scope, cleared.intent); return null; }
      if (cleared.status !== 'removed') {
        show({ active: row?.endTime === null ? row : null, review: 'completed', inspected: false,
          error: 'The sleep action was saved, but this tab could not clear its review. Check the care log before dismissing it.' });
        return null;
      }
      show({ active: row?.endTime === null ? row : null, pending: null, loaded: true, ambiguous: false, review: 'unchecked', error: null });
      return { intent, row };
    } catch { if (isCurrent(capture)) show({ error: unconfirmedError }); return null; }
  }

  async function act(kind: SleepIntent['kind'], location?: string, original?: { row: NurserySleep; scope: string }): Promise<SleepConfirmation | null> {
    if (current.current.storageBlocked || current.current.pending || !current.current.loaded || current.current.ambiguous) return null;
    if (original && (scopeNow() !== original.scope || owner.current.scope !== original.scope)) return null;
    const capture = begin(); if (!capture) return null;
    try {
      const at = new Date().toISOString(), active = original?.row ?? current.current.active;
      if (kind === 'start' ? Boolean(current.current.active) : !active) return null;
      const candidate = { kind, scope: capture.scope, familyId: environment.current.family!.id, babyId: environment.current.babyId,
        requestedAt: at, ...(kind === 'start' ? { startTime: at, requestId: crypto.randomUUID(), type: 'NAP', location }
          : { startTime: active!.startTime, sleepId: active!.id, expectedRevision: active!.revision, ...(kind === 'wake' ? { endTime: at } : {}) }) };
      const intent = normalizeSleepIntent(capture.scope, candidate);
      if (!intent) throw new Error('Invalid sleep time');
      memory.current.set(capture.scope, { intent, persisted: false }); show({ pending: intent, review: 'current', inspected: false, error: null });
      return await dispatch(intent, capture);
    } catch { if (isCurrent(capture)) show({ error: 'Review the sleep times before changing this timer.' }); return null; }
    finally { finish(capture); }
  }
  async function retry(): Promise<SleepConfirmation | null> {
    if (!current.current.pending || current.current.storageBlocked || ['changed', 'missing', 'completed'].includes(current.current.review)) return null;
    const capture = begin(); if (!capture) return null;
    try { return await dispatch(current.current.pending!, capture); } finally { finish(capture); }
  }
  async function dismissReview() {
    if (scopeNow() !== owner.current.scope) { selectOwner(); return; }
    const { pending, busy, inspected, storageBlocked, loaded } = current.current;
    if (!pending || busy || !inspected || storageBlocked || !loaded) return;
    const capture = begin(); if (!capture) return;
    try {
      const result = await mutateSleepIntent(pending.scope, 'remove', pending, () => isCurrent(capture));
      if (!isCurrent(capture)) return;
      if (result.status === 'changed') { adoptShared(pending.scope, result.intent); return; }
      if (result.status !== 'removed') { show({ error: result.status === 'locking-unavailable' ? lockingError
        : 'This tab could not clear the sleep review. Keep this page open and check browser storage.' }); return; }
      memory.current.delete(pending.scope); show({ pending: null, review: 'unchecked', error: current.current.ambiguous ? ambiguousError : null });
    } finally { finish(capture); }
  }
  function inspectCareLog() {
    if (scopeNow() !== owner.current.scope) { selectOwner(); return; }
    const slug = environment.current.family?.slug;
    if (slug) window.open(`/${encodeURIComponent(slug)}/log-entry`, '_blank', 'noopener,noreferrer');
  }
  return { ...view, elapsed, start: (location: string) => act('start', location), wake: () => act('wake'), retry,
    undo: (row: NurserySleep, kind: 'undo-start' | 'undo-wake', scope: string) => act(kind, undefined, { row, scope }),
    loadCurrent: () => loadCurrent(), dismissReview, inspectCareLog,
    canRetry: Boolean(view.pending) && !view.storageBlocked && !['changed', 'missing', 'completed'].includes(view.review),
    canDismiss: Boolean(view.pending) && view.inspected && view.loaded && !view.storageBlocked,
  };
}
