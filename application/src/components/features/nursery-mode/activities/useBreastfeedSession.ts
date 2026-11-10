'use client';

import { useEffect, useRef, useState } from 'react';
import type { ActiveBreastFeedResponse } from '@/app/api/types';
import { useFamily } from '@/src/context/family';
import { journalScopeFromToken } from '@/src/lib/bottle-journal/outbox-identity';
import { captureBreastfeedStop, clearBreastfeedStop, readBreastfeedStop, saveBreastfeedStop,
  type BreastfeedStopIntent } from '@/src/utils/nursery/breastfeedStop';
import { requestBreastfeedJSON } from '@/src/utils/nursery/breastfeedRequest';
import { readNurseryUndo, type NurseryUndo } from '@/src/utils/nursery/undo';

type Review = 'unchecked' | 'current' | 'changed' | 'missing' | 'completed';
interface SessionView {
  session: ActiveBreastFeedResponse | null;
  stop: BreastfeedStopIntent | null;
  review: Review;
  loaded: boolean;
  inspected: boolean;
  stopReadBlocked: boolean;
  busy: boolean;
  error: string | null;
}
const initialView = (): SessionView => ({ session: null, stop: null, review: 'unchecked', loaded: false, inspected: false,
  stopReadBlocked: false, busy: false, error: null });
const storageError = 'This tab could not save the stop time. Keep this page open and check browser storage before retrying. No request was sent on this attempt.';
const storageReadError = 'This tab could not read its saved stop review. Keep this page open and check the care log and browser storage.';
const unconfirmedError = 'Stop was not confirmed. Your first stop time is kept. Retry or reload the current session and review the care log.';
const changedError = 'The session changed. Your first stop time is kept. Reload and review the current timer before choosing what to do.';
const missingError = 'No active session was found. Your stop may already be saved. Check the care log before dismissing this review.';

/** Owns only breastfeeding timer requests and its per-tab first-stop recovery.
 * The shared API claims each revision; this hook never treats a missing session
 * as evidence that this tab's stop was saved. */
export function useBreastfeedSession(babyId: string, onCompleted: (stop: BreastfeedStopIntent, ids: string[], undo: NurseryUndo | null) => void) {
  const { family, authenticatedFetch } = useFamily();
  const environment = useRef({ family, babyId, authenticatedFetch, onCompleted });
  environment.current = { family, babyId, authenticatedFetch, onCompleted };
  const [view, setView] = useState<SessionView>(initialView);
  const current = useRef(view);
  const owner = useRef({ scope: null as string | null, epoch: 0, request: 0 });
  const mounted = useRef(false);
  // A blocked storage write still keeps the original stop in memory while this
  // mounted nursery switches child/actor and back. It never permits dispatch.
  const memoryStops = useRef(new Map<string, BreastfeedStopIntent>());
  const [elapsed, setElapsed] = useState(0);
  const show = (patch: Partial<SessionView>) => {
    current.current = { ...current.current, ...patch };
    setView(current.current);
  };
  const scopeNow = () => {
    try { return journalScopeFromToken(localStorage.getItem('authToken'), environment.current.family?.id, environment.current.babyId); }
    catch { return null; }
  };
  const isCurrent = (capture: { scope: string; epoch: number; request: number }) => mounted.current
    && owner.current.scope === capture.scope && owner.current.epoch === capture.epoch
    && owner.current.request === capture.request && scopeNow() === capture.scope;
  function finish(capture: { scope: string; epoch: number; request: number }) {
    if (!mounted.current || owner.current.scope !== capture.scope || owner.current.epoch !== capture.epoch) return;
    // A refresh can replace authentication within the awaited fetch without a
    // browser storage event. Do not leave the old owner's controls busy forever.
    if (scopeNow() !== capture.scope) { selectOwner(); return; }
    if (owner.current.request === capture.request) show({ busy: false });
  }

  async function loadCurrent(rereadStop = true) {
    const capture = begin();
    if (!capture) return;
    const child = environment.current.babyId;
    try {
      if (rereadStop) {
        const saved = readBreastfeedStop(capture.scope), known = current.current.stop;
        const blocked = saved.status === 'invalid' || saved.status === 'unavailable'
          || (saved.status === 'saved' && known !== null && JSON.stringify(saved.intent) !== JSON.stringify(known));
        const stop = known ?? (saved.status === 'saved' ? saved.intent : null);
        if (stop) memoryStops.current.set(capture.scope, stop);
        show({ stop, stopReadBlocked: blocked });
      }
      const { response, data } = await requestBreastfeedJSON(environment.current.authenticatedFetch,
        `/api/active-breastfeed?babyId=${encodeURIComponent(child)}`, { cache: 'no-store' });
      if (!isCurrent(capture)) return;
      if (!response.ok || !data.success || !Object.prototype.hasOwnProperty.call(data, 'data')
        || (data.data !== null && (typeof data.data !== 'object' || data.data.babyId !== child || data.data.familyId !== environment.current.family?.id))) {
        throw new Error('unconfirmed session');
      }
      const session: ActiveBreastFeedResponse | null = data.data ?? null;
      const stop = current.current.stop;
      const review: Review = !stop ? 'unchecked' : !session ? 'missing'
        : session.id === stop.sessionId && session.updatedAt === stop.expectedUpdatedAt ? 'current' : 'changed';
      show({ session, loaded: true, inspected: Boolean(stop), review, error: current.current.stopReadBlocked
        ? storageReadError : review === 'missing' ? missingError : review === 'changed' ? changedError : null });
    } catch {
      if (isCurrent(capture)) show({ error: 'Could not reload the breastfeeding session. Your current timer and stop review have been kept.' });
    } finally { finish(capture); }
  }

  function selectOwner() {
    const scope = scopeNow();
    owner.current = { scope, epoch: owner.current.epoch + 1, request: owner.current.request + 1 };
    const saved = scope ? readBreastfeedStop(scope) : null;
    const stop = scope ? memoryStops.current.get(scope) ?? (saved?.status === 'saved' ? saved.intent : null) : null;
    if (scope && stop) memoryStops.current.set(scope, stop);
    const stopReadBlocked = saved?.status === 'invalid' || saved?.status === 'unavailable';
    current.current = { ...initialView(), stop, stopReadBlocked,
      error: !scope ? 'Sign in as a caregiver for this child before changing the breastfeeding timer.'
        : stopReadBlocked ? storageReadError : null };
    setView(current.current);
    if (scope) void loadCurrent(false);
  }

  function begin() {
    if (!mounted.current) return null;
    if (scopeNow() !== owner.current.scope) { selectOwner(); return null; }
    if (!owner.current.scope || current.current.busy) return null;
    const capture = { scope: owner.current.scope, epoch: owner.current.epoch, request: ++owner.current.request };
    show({ busy: true });
    return capture;
  }

  useEffect(() => {
    mounted.current = true;
    selectOwner();
    const checkOwner = () => { if (scopeNow() !== owner.current.scope) selectOwner(); };
    const storage = (event: StorageEvent) => { if (event.key === 'authToken' || event.key === null) checkOwner(); };
    window.addEventListener('storage', storage);
    window.addEventListener('focus', checkOwner);
    document.addEventListener('visibilitychange', checkOwner);
    return () => {
      mounted.current = false;
      owner.current.epoch++;
      window.removeEventListener('storage', storage);
      window.removeEventListener('focus', checkOwner);
      document.removeEventListener('visibilitychange', checkOwner);
    };
    // Identity is the effect boundary. Request callbacks always read current
    // refs, so a late callback cannot change another child's or actor's view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [family?.id, babyId]);

  useEffect(() => {
    const session = view.session;
    if (view.stop || view.stopReadBlocked || !session || session.isPaused || !session.currentSideStartTime) { setElapsed(0); return; }
    const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - Date.parse(session.currentSideStartTime!)) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    document.addEventListener('visibilitychange', update);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', update); };
  }, [view.session, view.stop, view.stopReadBlocked]);

  async function start(side: 'LEFT' | 'RIGHT') {
    if (current.current.stop || current.current.stopReadBlocked || current.current.session || !current.current.loaded) return;
    const capture = begin();
    if (!capture) return;
    try {
      const { response, data } = await requestBreastfeedJSON(environment.current.authenticatedFetch, '/api/active-breastfeed', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ babyId: environment.current.babyId, side, expectedScope: capture.scope }),
      });
      if (!isCurrent(capture)) return;
      if (!response.ok || !data.success || !data.data) throw new Error('unconfirmed start');
      show({ session: data.data, error: null });
    } catch {
      if (isCurrent(capture)) show({ loaded: false, error: 'The timer change was not confirmed. Reload the current breastfeeding session before trying again.' });
    } finally { finish(capture); }
  }

  async function change(action: 'switch' | 'pause' | 'resume', side?: 'LEFT' | 'RIGHT') {
    const session = current.current.session;
    if (!session || current.current.stop || current.current.stopReadBlocked) return;
    const capture = begin();
    if (!capture) return;
    try {
      const { response, data } = await requestBreastfeedJSON(environment.current.authenticatedFetch,
        `/api/active-breastfeed?id=${encodeURIComponent(session.id)}&action=${action}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side, expectedUpdatedAt: session.updatedAt, expectedScope: capture.scope }),
      });
      if (!isCurrent(capture)) return;
      if (!response.ok || !data.success || !data.data) throw new Error('unconfirmed change');
      show({ session: data.data, error: null });
    } catch {
      if (isCurrent(capture)) show({ error: 'The timer change was not confirmed. Reload the current breastfeeding session before trying again.' });
    } finally { finish(capture); }
  }

  async function stop() {
    if (current.current.stopReadBlocked) return;
    const capture = begin();
    if (!capture) return;
    let intent = current.current.stop;
    try {
      if (!intent) {
        if (!current.current.session) return;
        intent = captureBreastfeedStop(current.current.session, capture.scope);
        memoryStops.current.set(capture.scope, intent);
        show({ stop: intent, review: 'current', inspected: false, error: null });
      }
      if (['changed', 'missing', 'completed'].includes(current.current.review)) return;
      if (!saveBreastfeedStop(intent)) { show({ error: storageError }); return; }
      if (!isCurrent(capture)) return;
      const { response, data } = await requestBreastfeedJSON(environment.current.authenticatedFetch,
        `/api/active-breastfeed?id=${encodeURIComponent(intent.sessionId)}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leftDuration: intent.leftDuration, rightDuration: intent.rightDuration,
          pauseDuration: intent.pauseDuration, expectedUpdatedAt: intent.expectedUpdatedAt, expectedScope: intent.scope }),
      });
      const ids: unknown = data.data?.feedLogIds;
      if (!response.ok || !data.success || !Array.isArray(ids) || ids.some(id => typeof id !== 'string')
        || ids.length > 2 || data.data.feedLogsCreated !== ids.length) {
        if (isCurrent(capture)) show({ review: response.status === 404 ? 'missing' : response.status === 409 ? 'changed' : current.current.review,
          error: response.status === 404 ? missingError : response.status === 409 ? changedError : unconfirmedError });
        return;
      }
      // Clear this exact old intent even if its owner is no longer on screen;
      // compare-and-clear cannot erase a different/newer local stop.
      const cleared = clearBreastfeedStop(intent);
      if (cleared && memoryStops.current.get(capture.scope) === intent) memoryStops.current.delete(capture.scope);
      if (!isCurrent(capture)) return;
      if (!cleared) {
        show({ session: null, review: 'completed', inspected: false,
          error: 'The feed was saved, but this tab could not clear its stop review. Check the care log before dismissing it.' });
        return;
      }
      show({ session: null, stop: null, review: 'unchecked', loaded: true, error: null });
      const candidate = readNurseryUndo(data.undo);
      const undo = candidate?.kind === 'breast' && candidate.scope === capture.scope && candidate.records.length === ids.length
        && candidate.records.every(row => ids.includes(row.id)) ? candidate : null;
      environment.current.onCompleted(intent, ids as string[], undo);
    } catch {
      if (isCurrent(capture)) show({ error: intent ? unconfirmedError : 'Review the breastfeeding timer before stopping it.' });
    } finally { finish(capture); }
  }

  function dismissReview() {
    if (scopeNow() !== owner.current.scope) { selectOwner(); return; }
    const { stop: intent, inspected, busy, review, stopReadBlocked } = current.current;
    if (!intent || !inspected || busy || stopReadBlocked || review === 'unchecked') return;
    if (!clearBreastfeedStop(intent)) { show({ error: 'This tab could not clear the stop review. Keep this page open and check browser storage.' }); return; }
    memoryStops.current.delete(intent.scope);
    show({ stop: null, review: 'unchecked', error: null });
  }

  function inspectCareLog() {
    if (scopeNow() !== owner.current.scope) { selectOwner(); return; }
    const slug = environment.current.family?.slug;
    if (slug) window.open(`/${encodeURIComponent(slug)}/log-entry`, '_blank', 'noopener,noreferrer');
  }

  const phase = view.stop || view.stopReadBlocked ? 'reviewing' : !view.session ? 'idle' : view.session.isPaused ? 'paused' : 'feeding';
  const leftTotal = view.stop?.leftDuration ?? (view.session ? view.session.leftDuration + (view.session.activeSide === 'LEFT' ? elapsed : 0) : 0);
  const rightTotal = view.stop?.rightDuration ?? (view.session ? view.session.rightDuration + (view.session.activeSide === 'RIGHT' ? elapsed : 0) : 0);
  return { ...view, phase, leftTotal, rightTotal, start, change, stop, loadCurrent: () => loadCurrent(), dismissReview, inspectCareLog,
    hasStopIntent: Boolean(view.stop),
    canRetry: Boolean(view.stop) && !view.stopReadBlocked && !['changed', 'missing', 'completed'].includes(view.review),
    canDismiss: Boolean(view.stop) && !view.stopReadBlocked && view.inspected && view.review !== 'unchecked' };
}
