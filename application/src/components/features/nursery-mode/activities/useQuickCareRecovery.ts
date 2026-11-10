'use client';

import { useEffect, useRef, useState } from 'react';
import { useFamily } from '@/src/context/family';
import { mutateQuickCareIntent, normalizeQuickCareIntent, quickCareIntentKey, quickCareRequest, readQuickCareIntent,
  type QuickCareIntent, type QuickCareIntentMutation, type QuickCareKind } from '@/src/utils/nursery/quickCareIntent';
import { readQuickCareSaved, requestQuickCareJSON, type QuickCareSaved } from '@/src/utils/nursery/quickCareRequest';
import { type NurseryOwnerCapture, useNurseryOwner } from './useNurseryOwner';

interface View {
  scope: string | null; pending: QuickCareIntent | null; storageBlocked: boolean; busy: boolean;
  retryable: boolean; inspected: boolean; error: string | null;
}
export interface QuickCareConfirmation extends QuickCareSaved { intent: QuickCareIntent; owner: NurseryOwnerCapture }
const initial = (): View => ({ scope: null, pending: null, storageBlocked: false, busy: false, retryable: true, inspected: false, error: null });
const uncertain = 'The care action was not confirmed. Its original details are kept. Retry the saved action or review the care log.';
const changed = 'This saved care action changed or was removed. Review the care log before dismissing the saved action.';
const readError = 'This browser could not read its saved care action. Keep this page open and check browser storage before logging again.';
const writeError = 'This browser could not save the care action. Keep this page open and check browser storage. No request was sent on this attempt.';
const localChanged = 'The saved care action changed in another tab. Its current state has been kept. Reload the saved action before continuing.';
const lockingError = 'This browser cannot safely coordinate saved care actions. Keep this page open and use a browser with Web Locks support before saving.';
const lockBusy = 'Another tab is updating the saved care action. Keep this page open and retry.';
const mutationError = (result: QuickCareIntentMutation) => result.status === 'locking-unavailable' ? lockingError
  : result.status === 'busy' ? lockBusy : writeError;

/** One first action per kind and owner. Persistence and response acknowledgement
 * are compared under a short Web Lock; network delivery is always outside it. */
export function useQuickCareRecovery(kind: QuickCareKind, babyId: string, owner: ReturnType<typeof useNurseryOwner>) {
  const { family, authenticatedFetch } = useFamily();
  const environment = useRef({ family, authenticatedFetch, babyId, owner });
  environment.current = { family, authenticatedFetch, babyId, owner };
  const [view, setView] = useState<View>(initial), current = useRef(view);
  const memory = useRef(new Map<string, { intent: QuickCareIntent; persisted: boolean }>());
  const requestNumber = useRef(0), mounted = useRef(false);
  const show = (patch: Partial<View>) => { current.current = { ...current.current, ...patch }; setView(current.current); };
  const isCurrent = (capture: NurseryOwnerCapture, request: number) => environment.current.owner.isCurrent(capture) && requestNumber.current === request;

  function readStored() {
    if (!mounted.current) return;
    const capture = environment.current.owner.capture(); requestNumber.current++;
    if (!capture || !environment.current.owner.isCurrent(capture)) {
      show({ ...initial(), error: 'Sign in as a caregiver for this child before logging care.' }); return;
    }
    const saved = readQuickCareIntent(kind, capture.scope), known = memory.current.get(capture.scope);
    const storageBlocked = saved.status === 'invalid' || saved.status === 'unavailable';
    const pending = saved.status === 'saved' ? saved.intent : storageBlocked || !known?.persisted ? known?.intent ?? null : null;
    if (pending) memory.current.set(capture.scope, { intent: pending, persisted: saved.status === 'saved' || Boolean(known?.persisted) });
    else memory.current.delete(capture.scope);
    show({ ...initial(), scope: capture.scope, pending, storageBlocked, error: storageBlocked ? readError : pending ? uncertain : null });
  }
  useEffect(() => {
    mounted.current = true;
    readStored();
    const check = () => {
      const capture = environment.current.owner.capture();
      if (!capture || capture.scope !== current.current.scope) { readStored(); return; }
      const saved = readQuickCareIntent(kind, capture.scope);
      if (saved.status === 'invalid' || saved.status === 'unavailable') { show({ storageBlocked: true, error: readError }); return; }
      const known = memory.current.get(capture.scope);
      const pending = saved.status === 'saved' ? saved.intent : !known?.persisted ? known?.intent ?? null : null;
      if (JSON.stringify(pending) !== JSON.stringify(current.current.pending)) {
        requestNumber.current++;
        if (pending) memory.current.set(capture.scope, { intent: pending, persisted: true }); else memory.current.delete(capture.scope);
        show({ scope: capture.scope, pending, busy: false, storageBlocked: false, retryable: false, inspected: false, error: localChanged });
      }
      // An unavailable read remains blocked until an explicit successful reload.
    };
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === 'authToken' || event.key === quickCareIntentKey(kind, current.current.scope ?? '')) check();
    };
    window.addEventListener('storage', storage); window.addEventListener('focus', check); document.addEventListener('visibilitychange', check);
    return () => { mounted.current = false; requestNumber.current++; window.removeEventListener('storage', storage); window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check); };
    // Captures use current refs; owner identity and generation reset the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, owner.scope, owner.epoch]);

  function begin() {
    const capture = environment.current.owner.capture();
    if (!capture || !environment.current.owner.isCurrent(capture) || capture.scope !== current.current.scope) { readStored(); return null; }
    if (current.current.busy) return null;
    const request = ++requestNumber.current; show({ busy: true }); return { capture, request };
  }
  function finish(capture: NurseryOwnerCapture, request: number) {
    if (isCurrent(capture, request)) show({ busy: false });
    else if (environment.current.owner.scopeNow() !== current.current.scope) readStored();
  }
  function adopt(intent: QuickCareIntent, result: Extract<QuickCareIntentMutation, { status: 'changed' }>) {
    if (result.intent) memory.current.set(intent.scope, { intent: result.intent, persisted: true }); else memory.current.delete(intent.scope);
    show({ pending: result.intent, storageBlocked: false, retryable: false, inspected: false, error: localChanged });
  }
  async function dispatch(intent: QuickCareIntent, capture: NurseryOwnerCapture, request: number): Promise<QuickCareConfirmation | null> {
    const persisted = memory.current.get(intent.scope)?.persisted === true;
    const stored = await mutateQuickCareIntent(intent, persisted ? 'verify' : 'create', () => isCurrent(capture, request));
    // A successful setItem followed by an unreadable verification may already
    // be visible to another tab. Never recreate it if that tab later clears it.
    if (stored.status === 'unavailable' && stored.mayHaveSaved) memory.current.set(intent.scope, { intent, persisted: true });
    if (stored.status !== 'saved') {
      if (isCurrent(capture, request)) {
        if (stored.status === 'changed') adopt(intent, stored);
        else if (stored.status !== 'cancelled') show({ error: mutationError(stored) });
      }
      return null;
    }
    memory.current.set(intent.scope, { intent, persisted: true });
    if (!isCurrent(capture, request)) return null;
    const payload = quickCareRequest(intent);
    try {
      const { response, data } = await requestQuickCareJSON(environment.current.authenticatedFetch, payload.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload.body),
      });
      if (!isCurrent(capture, request)) return null;
      if (!response.ok || !data.success) {
        const conflict = [400, 404, 409].includes(response.status) && data.code !== 'QUICK_CARE_BUSY';
        show({ retryable: !conflict, error: data.code === 'NURSERY_UNDO_SCOPE_CHANGED'
          ? 'The caregiver or child changed. Return to the original caregiver and child to review this action.'
          : response.status === 401 || response.status === 403
            ? 'Sign in again as the original caregiver before retrying the saved care action.' : conflict ? changed : uncertain });
        return null;
      }
      const saved = readQuickCareSaved(intent, data); if (!saved) throw new Error('Invalid care confirmation');
      const cleared = await mutateQuickCareIntent(intent, 'remove', () => isCurrent(capture, request));
      if (!isCurrent(capture, request)) return null;
      if (cleared.status === 'changed') { adopt(intent, cleared); return null; }
      if (cleared.status !== 'removed') {
        show({ retryable: false, error: 'The care action was saved, but this browser could not clear its review. Check the care log before dismissing it.' });
        return null;
      }
      if (JSON.stringify(memory.current.get(intent.scope)?.intent) === JSON.stringify(intent)) memory.current.delete(intent.scope);
      show({ pending: null, storageBlocked: false, retryable: true, inspected: false, error: null });
      return { ...saved, intent, owner: capture };
    } catch { if (isCurrent(capture, request)) show({ retryable: true, error: uncertain }); return null; }
  }

  async function create(details: { type: string; time: string | null } | { foodId: string; foodName: string; time: string | null }) {
    if (current.current.pending || current.current.storageBlocked || current.current.error) return null;
    const started = begin(); if (!started) return null;
    const { capture, request } = started;
    try {
      const intent = normalizeQuickCareIntent(kind, capture.scope, { version: 1, kind, scope: capture.scope,
        familyId: environment.current.family?.id, babyId: environment.current.babyId, requestId: crypto.randomUUID(), ...details });
      if (!intent) { show({ error: 'The care action could not be prepared. Reload before trying again.' }); return null; }
      memory.current.set(intent.scope, { intent, persisted: false });
      show({ pending: intent, retryable: true, inspected: false, error: null });
      return await dispatch(intent, capture, request);
    } finally { finish(capture, request); }
  }
  async function retry(): Promise<QuickCareConfirmation | null> {
    if (!current.current.pending || !current.current.retryable || current.current.storageBlocked) return null;
    const started = begin(); if (!started) return null;
    const { capture, request } = started;
    try { return await dispatch(current.current.pending!, capture, request); } finally { finish(capture, request); }
  }
  function inspectCareLog() {
    const capture = environment.current.owner.capture();
    if (!capture || !environment.current.owner.isCurrent(capture) || capture.scope !== current.current.scope) { readStored(); return; }
    const slug = environment.current.family?.slug;
    if (slug) { window.open(`/${encodeURIComponent(slug)}/full-log`, '_blank', 'noopener,noreferrer'); show({ inspected: true }); }
  }
  async function dismiss() {
    const { pending, inspected, storageBlocked } = current.current;
    if (!pending || !inspected || storageBlocked) return;
    const started = begin(); if (!started) return;
    const { capture, request } = started;
    try {
      const result = await mutateQuickCareIntent(pending, 'remove', () => isCurrent(capture, request));
      if (!isCurrent(capture, request)) return;
      if (result.status === 'changed') {
        if (!result.intent && !memory.current.get(pending.scope)?.persisted) {
          memory.current.delete(pending.scope); show({ pending: null, error: null, retryable: true, inspected: false });
        } else adopt(pending, result);
        return;
      }
      // A never-persisted intent can be discarded only after a successful locked
      // read proves there is no newer saved action in its place.
      if (result.status !== 'removed') { show({ error: mutationError(result) }); return; }
      memory.current.delete(pending.scope); show({ pending: null, error: null, retryable: true, inspected: false });
    } finally { finish(capture, request); }
  }
  return { ...view, create, retry, reload: readStored, inspectCareLog, dismiss,
    reviewing: Boolean(view.pending || view.storageBlocked || view.error),
    canRetry: Boolean(view.pending) && !view.storageBlocked && view.retryable,
    canDismiss: Boolean(view.pending) && view.inspected && !view.storageBlocked,
  };
}
