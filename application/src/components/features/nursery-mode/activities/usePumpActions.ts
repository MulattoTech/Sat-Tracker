'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocalization } from '@/src/context/localization';
import { useFamily } from '@/src/context/family';
import { journalScopeFromToken } from '@/src/lib/bottle-journal/outbox-identity';
import { formatPumpNote } from '@/src/utils/nursery/activityDetail';
import { loadPumpSession, readPumpSession, mutatePumpSession, clearPumpSession, pumpSessionKey, preparePumpSubmission, type PumpSessionSnapshot, type PumpSessionSide } from '@/src/utils/nursery/pumpSession';
import { ActivityHookArgs, ActivityView, ActionButton, AmountPrompt, formatMMSS } from './types';
import { readNurseryUndo } from '@/src/utils/nursery/undo';
import { conditionalUndo } from './conditionalUndo';
import { cacheDefaultBottleUnit, readCachedDefaultBottleUnit, type BottleUnit } from '@/src/utils/defaultBottleUnit';
import type { PumpAction } from '@/src/utils/pumpAction';

const awaitingConfirmation = 'Saving could not be confirmed. Your pumping session is kept. Retry the saved request.';
const storageError = 'This browser could not keep your pumping session. Keep this page open and free storage before retrying.';
const lockingError = 'This browser cannot safely coordinate saved pumping sessions. Keep this page open and use a browser with Web Locks support before saving.';
const identityError = 'Sign in as the original caregiver before saving this pumping session.';
const newerSessionMessage = 'A newer pumping session is saved on this browser. It has been kept.';
const elapsedNow = (session: PumpSessionSnapshot) => session.phase === 'timing' && session.resumeTime !== null
  ? session.pauseAccumulated + Math.max(0, Math.floor((Date.now() - session.resumeTime) / 1000)) : session.elapsed;

/** Local timer with an owner-scoped durable draft and a frozen, idempotent save. */
export function usePumpActions({ babyId, onLog, onUndoable, enableBreastMilkTracking = true }: ActivityHookArgs): ActivityView {
  const { t } = useLocalization();
  const { family, authenticatedFetch } = useFamily();
  const [session, setSession] = useState<PumpSessionSnapshot | null>(null);
  const persistedSnapshot = useRef<PumpSessionSnapshot | null>(null);
  const adoptSession = useCallback((snapshot: PumpSessionSnapshot | null) => {
    persistedSnapshot.current = snapshot;
    setSession(snapshot);
  }, []);
  const [legacy, setLegacy] = useState<PumpSessionSnapshot | null>(null);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const loadedScopeRef = useRef<string | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [defaultUnit, setDefaultUnit] = useState<BottleUnit>(() => readCachedDefaultBottleUnit());
  const readScope = useCallback(() => {
    try { return journalScopeFromToken(localStorage.getItem('authToken'), family?.id, babyId); }
    catch { return null; }
  }, [family?.id, babyId]);
  const currentScope = useRef(readScope); currentScope.current = readScope;

  useEffect(() => {
    const refresh = async () => {
      try {
        const token = localStorage.getItem('authToken');
        const res = await fetch('/api/settings', { cache: 'no-store', headers: { Authorization: token ? `Bearer ${token}` : '' } });
        const data = await res.json();
        const unit = cacheDefaultBottleUnit(data.success && data.data?.defaultBottleUnit);
        if (unit) setDefaultUnit(unit);
      } catch { /* A session keeps the unit captured when it started. */ }
    };
    void refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);

  useEffect(() => {
    const restore = (force = false) => {
      const scope = readScope();
      if (submittingRef.current && scope === loadedScopeRef.current) return;
      if (!force && scope === loadedScopeRef.current) return;
      const read = scope ? readPumpSession(babyId, scope) : null;
      if (scope === loadedScopeRef.current && (read?.status === 'unavailable' || read?.status === 'invalid')) {
        setError(storageError); return;
      }
      const saved = read?.status === 'saved' ? read.snapshot : null;
      loadedScopeRef.current = scope;
      setLoadedScope(scope);
      adoptSession(saved);
      setLegacy(!saved && scope ? loadPumpSession(babyId) : null);
      setError(saved?.pending ? awaitingConfirmation : '');
    };
    const onStorage = (event: StorageEvent) => {
      const scope = readScope();
      if (event.key === 'authToken' || event.key === pumpSessionKey(babyId)
        || (scope && event.key === pumpSessionKey(babyId, scope))) restore(true);
    };
    const onFocus = () => restore();
    restore(true);
    window.addEventListener('focus', onFocus);
    window.addEventListener('storage', onStorage);
    return () => { window.removeEventListener('focus', onFocus); window.removeEventListener('storage', onStorage); };
  }, [babyId, readScope, adoptSession]);

  useEffect(() => {
    if (!loadedScope || loadedScope !== readScope()) return;
    // Frozen submissions are persisted explicitly before dispatch. Re-saving
    // one from a later passive effect could resurrect it after a 4xx rejection.
    // Running ticks are derived from the persisted resume time; they do not
    // write whole snapshots back over another tab's user edits.
    if (!session || session.phase === 'timing' || session.pending || session === persistedSnapshot.current) return;
    if (session.scope !== loadedScope) return;
    let active = true;
    void mutatePumpSession(babyId, loadedScope, { kind: 'save', snapshot: session }).then(result => {
      if (!active || currentScope.current() !== loadedScope) return;
      if (result.status === 'changed' && result.snapshot) {
        adoptSession(result.snapshot); setError(result.snapshot.requestId === session.requestId ? awaitingConfirmation : newerSessionMessage);
      } else if (result.status === 'locking-unavailable') setError(lockingError);
      else if (result.status === 'unavailable' || result.status === 'invalid') setError(storageError);
    });
    return () => { active = false; };
  }, [babyId, loadedScope, session, readScope, adoptSession]);

  useEffect(() => {
    if (session?.phase !== 'timing') return;
    const tick = () => setSession(value => {
      if (value?.phase !== 'timing') return value;
      const elapsed = elapsedNow(value);
      return elapsed === value.elapsed ? value : { ...value, elapsed };
    });
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [session?.phase]);

  const canAct = () => {
    const scope = readScope();
    if (!scope || scope !== loadedScope || (session && scope !== session.scope)) { setError(identityError); return false; }
    return !submittingRef.current;
  };
  const beginSession = (draft: PumpSessionSnapshot, kind: 'create' | 'save' = 'create') => {
    setSession(draft); setLegacy(null); setError('');
    void mutatePumpSession(babyId, draft.scope!, { kind, snapshot: draft }).then(result => {
      if (currentScope.current() !== draft.scope) return;
      if (result.status === 'changed' && result.snapshot) { adoptSession(result.snapshot); setError(newerSessionMessage); }
      else if (result.status === 'locking-unavailable') setError(lockingError);
      else if (result.status === 'unavailable' || result.status === 'invalid') setError(storageError);
    });
  };
  const start = (side: PumpSessionSide) => {
    if (!canAct()) return;
    beginSession({ phase: 'timing', activeSide: side, startTime: new Date().toISOString(),
      sideDuration: { left: 0, right: 0 }, pauseAccumulated: 0, resumeTime: Date.now(), elapsed: 0,
      amountLeft: '', amountRight: '', scope: loadedScope!, requestId: crypto.randomUUID(), unitAbbr: defaultUnit });
  };
  const pause = () => {
    if (!session || !canAct()) return;
    const elapsed = elapsedNow(session);
    setSession({ ...session, phase: 'paused', elapsed, pauseAccumulated: elapsed, resumeTime: null });
  };
  const resume = () => {
    if (!session || !canAct() || session.pending) return;
    beginSession({ ...session, phase: 'timing', resumeTime: Date.now(), endTime: undefined }, 'save');
  };
  const switchSide = () => {
    if (!session || session.activeSide === 'both' || !canAct() || session.pending) return;
    const elapsed = elapsedNow(session);
    beginSession({ ...session, activeSide: session.activeSide === 'left' ? 'right' : 'left',
      sideDuration: { ...session.sideDuration, [session.activeSide]: session.sideDuration[session.activeSide] + elapsed },
      elapsed: 0, pauseAccumulated: 0, resumeTime: Date.now(), phase: 'timing', endTime: undefined }, 'save');
  };

  const submit = async (action: PumpAction, stopped = session) => {
    if (!stopped || !canAct() || stopped.scope !== loadedScope) return;
    const readBeforeSave = readPumpSession(babyId, stopped.scope);
    if (readBeforeSave.status === 'unavailable' || readBeforeSave.status === 'invalid') { setError(storageError); return; }
    const storedBeforeSave = readBeforeSave.status === 'saved' ? readBeforeSave.snapshot : null;
    if (storedBeforeSave && storedBeforeSave.requestId !== stopped.requestId) {
      adoptSession(storedBeforeSave); setError(newerSessionMessage); return;
    }
    submittingRef.current = true; setSubmitting(true); setError('');
    const scope = stopped.scope!;
    let pending = stopped.pending;
    if (!pending) setSession({ ...stopped, pumpAction: action });
    const adoptChangedDraft = () => {
      const read = readPumpSession(babyId, scope);
      if (read.status === 'unavailable' || read.status === 'invalid') return false;
      const saved = read.status === 'saved' ? read.snapshot : null;
      if (saved?.requestId === stopped.requestId) return false;
      if (currentScope.current() === scope) {
        adoptSession(saved); setError(saved ? newerSessionMessage : '');
      }
      return true;
    };
    try {
      if (!pending) {
        // Finish persisting even invalid user input before showing a validation
        // failure. A reload immediately after that message must keep the choice
        // and amounts, not just the last asynchronous timer snapshot.
        const intent = { ...stopped, pumpAction: action };
        const recorded = await mutatePumpSession(babyId, scope, { kind: 'create', snapshot: intent });
        if (currentScope.current() !== scope) return;
        if (recorded.status === 'changed') { adoptSession(recorded.snapshot); setError(recorded.snapshot ? newerSessionMessage : ''); return; }
        if (recorded.status !== 'saved') throw new Error(recorded.status === 'locking-unavailable' ? lockingError : storageError);
      }
      pending ??= preparePumpSubmission(stopped, babyId, action);
      const frozen = { ...stopped, phase: 'selecting_action' as const, pumpAction: pending.pumpAction, pending };
      // Persist before dispatch. A crash after the server commits must leave the
      // exact request available, including its original child, end time and unit.
      const persisted = await mutatePumpSession(babyId, scope, { kind: stopped.pending ? 'save' : 'create', snapshot: frozen });
      if (currentScope.current() !== scope) return;
      if (persisted.status === 'changed') { adoptSession(persisted.snapshot); setError(persisted.snapshot ? newerSessionMessage : ''); return; }
      if (persisted.status !== 'saved') throw new Error(persisted.status === 'locking-unavailable' ? lockingError : storageError);
      adoptSession(persisted.snapshot);
      const response = await authenticatedFetch('/api/pump-log', { method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20_000), body: JSON.stringify(pending) });
      const data = await response.json();
      if (!response.ok || data.success !== true || data.requestId !== pending.requestId || typeof data.data?.id !== 'string') {
        if (adoptChangedDraft()) return;
        if (currentScope.current() === scope) {
          // A first attempt rejected before a care write can be corrected.
          // After any uncertain attempt, even a later auth/validation rejection
          // says nothing about that earlier transaction: keep its exact request.
          if (!stopped.pending && [400, 401, 403, 404].includes(response.status)) {
            const rejected = await mutatePumpSession(babyId, scope, { kind: 'reject', requestId: pending.requestId, pending });
            if (currentScope.current() !== scope) return;
            if (rejected.status === 'changed') { adoptSession(rejected.snapshot); setError(rejected.snapshot ? newerSessionMessage : ''); return; }
            if (rejected.status !== 'saved') { setError(rejected.status === 'locking-unavailable' ? lockingError : storageError); return; }
            adoptSession(rejected.snapshot);
          }
          setError(response.status === 401 || response.status === 403
            ? 'Sign in again to save this pumping session. Your input has been kept.'
            : response.status >= 400 && response.status < 500 && typeof data.error === 'string' ? data.error : awaitingConfirmation);
        }
        return;
      }
      // Do not clear another tab's newer session or the newly selected child.
      const removed = await mutatePumpSession(babyId, scope, { kind: 'remove', requestId: pending.requestId, pending });
      if (removed.status !== 'removed' && removed.status !== 'changed') {
        if (currentScope.current() === scope) setError(removed.status === 'locking-unavailable' ? lockingError : storageError);
        return;
      }
      const newerSession = removed.status === 'changed' ? removed.snapshot : null;
      if (stopped.recoveredLegacy && loadPumpSession(babyId)?.startTime === stopped.startTime) clearPumpSession(babyId);
      if (currentScope.current() !== scope) return;
      adoptSession(newerSession); setLegacy(null); setError(newerSession?.pending ? awaitingConfirmation : '');
      onLog('pump', formatPumpNote({ side: stopped.activeSide, leftAmount: pending.leftAmount ?? null,
        rightAmount: pending.rightAmount ?? null, unitAbbr: pending.unitAbbr,
        durationSeconds: stopped.sideDuration.left + stopped.sideDuration.right + stopped.elapsed, action: pending.pumpAction },
      { left: t('Left'), right: t('Right'), both: t('Both'), stored: t('Stored'), fed: t('Fed'), discarded: t('Discarded'), unknown: t('Needs review') }));
      const undo = readNurseryUndo(data.undo);
      if (undo?.kind === 'pump' && undo.scope === scope && undo.records[0].id === data.data.id) {
        onUndoable(conditionalUndo(undo, t('Pump logged'), () => currentScope.current()));
      }
    } catch (failure) {
      const localFailure = failure instanceof Error && [storageError, lockingError].includes(failure.message);
      if (pending && !localFailure && adoptChangedDraft()) return;
      if (currentScope.current() === scope) setError(localFailure ? failure.message
        : pending ? awaitingConfirmation : failure instanceof Error ? failure.message : awaitingConfirmation);
    } finally {
      submittingRef.current = false; setSubmitting(false);
      // Storage events for this owner were held while the request was in
      // flight. Observe the newest replacement once more before showing it.
      if (currentScope.current() === scope) {
        const latest = readPumpSession(babyId, scope);
        if (latest.status === 'saved' && latest.snapshot.requestId !== stopped.requestId) {
          adoptSession(latest.snapshot); setError(newerSessionMessage);
        }
      }
    }
  };
  const stop = () => {
    if (!session || !canAct() || session.pending) return;
    const elapsed = elapsedNow(session);
    const stopped = { ...session, phase: 'selecting_action' as const, elapsed, pauseAccumulated: elapsed, resumeTime: null, endTime: new Date().toISOString() };
    setSession(stopped);
    if (!enableBreastMilkTracking) void submit('STORED', stopped);
  };
  const setAmount = (side: 'Left' | 'Right', value: string) => {
    if (!canAct()) return;
    setSession(previous => previous && !previous.pending ? { ...previous, [`amount${side}`]: value } : previous);
  };
  const dismiss = async () => {
    if (!session?.pending || !canAct() || !window.confirm(t('This session may already be in the care log. Check it before dismissing. Dismiss only this browser’s saved pumping session? This does not delete any care records.')) || !canAct()) return;
    submittingRef.current = true; setSubmitting(true);
    try {
      const result = await mutatePumpSession(babyId, session.scope!, { kind: 'remove', requestId: session.requestId!, pending: session.pending });
      if (currentScope.current() !== session.scope) return;
      if (result.status === 'changed') { adoptSession(result.snapshot); setError(result.snapshot ? newerSessionMessage : ''); return; }
      if (result.status !== 'removed') { setError(result.status === 'locking-unavailable' ? lockingError : storageError); return; }
      // Deliberate local dismissal is not a server success or a record deletion.
      adoptSession(null); setLegacy(null); setError('');
    } finally { submittingRef.current = false; setSubmitting(false); }
  };

  let statusText: string | null = null;
  let buttons: ActionButton[] = [];
  let amountPrompt: AmountPrompt | null = null;
  const totalElapsed = session ? session.sideDuration.left + session.sideDuration.right + session.elapsed : 0;
  if (session?.phase === 'selecting_action') {
    statusText = `${formatMMSS(totalElapsed)} — ${t(session.pending ? 'Waiting for confirmation' : 'Select Action')}`;
    if (session.pumpAction) statusText += ` · ${t({ STORED: 'Stored', FED: 'Fed', DISCARDED: 'Discarded', UNKNOWN: 'Needs review' }[session.pumpAction])}`;
    const fields = [];
    for (const side of ['Left', 'Right'] as const) {
      const key = side === 'Left' ? 'left' : 'right';
      if (session.activeSide === 'both' || session.activeSide === key || session.sideDuration[key] > 0) {
        fields.push({ key, label: t(side), value: side === 'Left' ? session.amountLeft : session.amountRight,
          onChange: (value: string) => setAmount(side, value), unit: (session.unitAbbr || defaultUnit).toLowerCase(), disabled: submitting || !!session.pending });
      }
    }
    amountPrompt = { fields };
    if (session.pending) {
      buttons = [{ key: 'retry', label: t('Retry saved pumping session'), onClick: () => void submit(session.pending!.pumpAction), disabled: submitting, keepOpen: true }];
      if (family?.slug) buttons.push({ key: 'review', label: t('Review care log'), disabled: submitting,
        onClick: () => window.location.assign(`/${encodeURIComponent(family.slug)}/full-log`) });
      buttons.push({ key: 'dismiss', label: t('Dismiss saved session'), onClick: dismiss, disabled: submitting, keepOpen: true });
    } else {
      buttons = (enableBreastMilkTracking ? ['STORED', 'FED', 'DISCARDED'] as const : ['STORED'] as const).map(action => ({
        key: action.toLowerCase(), label: t(action === 'STORED' ? 'Stored' : action === 'FED' ? 'Fed' : 'Discarded'),
        onClick: () => void submit(action), disabled: submitting, keepOpen: true,
      }));
      buttons.push({ key: 'cancel', label: t('Cancel'), onClick: pause, disabled: submitting, cancel: true });
    }
  } else if (session) {
    const activeSide = session.activeSide;
    const sideLabels = { left: t('Left Side'), right: t('Right Side'), both: t('Both') };
    const activeTotal = activeSide === 'both' ? session.elapsed : session.sideDuration[activeSide] + session.elapsed;
    statusText = `${sideLabels[activeSide]}: ${formatMMSS(activeTotal)}`;
    if (activeSide !== 'both') {
      const other = activeSide === 'left' ? 'right' : 'left';
      if (session.sideDuration[other] > 0) statusText += ` (${t(other === 'left' ? 'Left' : 'Right')}: ${formatMMSS(session.sideDuration[other])})`;
      buttons.push({ key: 'switch', label: t('Switch'), onClick: switchSide });
    }
    if (session.phase === 'paused') { statusText = `${t('Paused')} · ${statusText}`; buttons.push({ key: 'resume', label: t('Resume'), onClick: resume }); }
    else buttons.push({ key: 'pause', label: t('Pause'), onClick: pause });
    buttons.push({ key: 'stop', label: t('Stop'), onClick: stop, emphasized: true, keepOpen: true });
  } else if (legacy) {
    statusText = t('An older pumping timer is saved on this browser. Confirm the caregiver and review the amounts and unit before saving.');
    buttons = (['ML', 'OZ'] as const).map(unitAbbr => ({ key: `reviewLegacy${unitAbbr}`,
      label: t(unitAbbr === 'ML' ? 'Review in mL as this caregiver' : 'Review in oz as this caregiver'), keepOpen: true, onClick: () => {
      if (!canAct()) return;
      beginSession({ ...legacy, phase: 'paused', elapsed: elapsedNow(legacy), pauseAccumulated: elapsedNow(legacy), resumeTime: null,
        requestId: crypto.randomUUID(), scope: loadedScope!, unitAbbr, recoveredLegacy: true });
    } }));
  } else {
    buttons = (['left', 'right', 'both'] as const).map(side => ({ key: `start${side}`, label: t(side === 'left' ? 'Start Left' : side === 'right' ? 'Start Right' : 'Start Both'), onClick: () => start(side), disabled: !loadedScope || submitting }));
  }
  return { id: 'pump', icon: 'pump', label: t('Pump'), statusText, errorText: error ? t(error) : null,
    active: session?.phase === 'timing' || session?.phase === 'paused', question: session?.phase === 'selecting_action', amountPrompt, buttons,
    buttonsWrap: !!session?.pending || !!legacy };
}
