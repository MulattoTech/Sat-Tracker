'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFamily } from '@/src/context/family';
import {
  freezeMedicineDose, medicineDoseScopeFromToken, medicineDoseStorageKey, mutateMedicineDose,
  readMedicineDose, requestMedicineDoseJSON, sameSavedMedicineDose, type SavedMedicineDose,
} from '@/src/utils/medicine-dose-request';

export const doseRecoveryMessages = {
  pending: 'Saving this dose could not be confirmed. Its original details are kept. Retry the saved request.',
  storage: 'This browser could not keep the dose request. Keep this page open and restore storage before saving.',
  locking: 'This browser could not coordinate the saved dose. Keep this page open and retry when storage access is available.',
  owner: 'The caregiver or child changed. Return to the original caregiver and child before retrying this dose.',
  changed: 'Another saved dose has changed on this browser. Review it before continuing.',
  auth: 'Sign in again as the original caregiver to confirm this dose. The saved request has been kept.',
  conflict: 'The saved dose needs review because the record changed or was removed.',
  rejected: 'The server rejected this dose. Its details are kept for review.',
  timeout: 'Saving the dose request timed out. Its original details are kept.',
} as const;

type Draft = { babyId: string; medicineId: string; time: string; doseAmount: number; unitAbbr?: string | null; notes?: string | null };
type Attempt = { scope: string; generation: number; requestId: string };

/** One frozen create intent per browser owner/child. Explicit user actions are
 * the only writers; rehydration and cross-tab events never echo old snapshots. */
export function useMedicineDoseRecovery({ babyId, isOpen, enabled, onConfirmed }: {
  babyId?: string; isOpen: boolean; enabled: boolean; onConfirmed: () => void;
}) {
  const { family, authenticatedFetch } = useFamily();
  const [pending, setPending] = useState<SavedMedicineDose | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState('');
  const pendingRef = useRef<SavedMedicineDose | null>(null);
  const ownerRef = useRef<string | null>(null);
  const generation = useRef(0);
  const attemptRef = useRef<Attempt | null>(null);
  const mounted = useRef(true);
  const view = useRef({ isOpen, enabled, babyId, onConfirmed });
  view.current = { isOpen, enabled, babyId, onConfirmed };
  const readScope = useCallback(() => {
    try { return medicineDoseScopeFromToken(localStorage.getItem('authToken'), family?.id, babyId); }
    catch { return null; }
  }, [family?.id, babyId]);
  const scopeReader = useRef(readScope); scopeReader.current = readScope;
  const adopt = useCallback((snapshot: SavedMedicineDose | null) => { pendingRef.current = snapshot; setPending(snapshot); }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const restore = useCallback((changed = false) => {
    const scope = scopeReader.current();
    if (!scope || (view.current.isOpen && ownerRef.current !== scope)) {
      setBlocked(true); setError(doseRecoveryMessages.owner); return;
    }
    if (ownerRef.current !== scope) {
      ownerRef.current = scope; generation.current++; attemptRef.current = null; setBusy(false); adopt(null);
    }
    const read = readMedicineDose(scope);
    if (read.status === 'invalid' || read.status === 'unavailable') {
      setBlocked(true); setError(doseRecoveryMessages.storage); return;
    }
    const snapshot = read.status === 'saved' ? read.snapshot : null;
    const replaced = pendingRef.current && (!snapshot || !sameSavedMedicineDose(pendingRef.current, snapshot));
    adopt(snapshot); setBlocked(false);
    setError(changed && replaced ? doseRecoveryMessages.changed : snapshot ? doseRecoveryMessages.pending : '');
  }, [adopt]);

  useEffect(() => {
    generation.current++; attemptRef.current = null; setBusy(false);
    ownerRef.current = readScope(); adopt(null); setError(''); setBlocked(false);
    if (enabled) restore();
  }, [babyId, family?.id, isOpen, enabled, readScope, restore, adopt]);

  useEffect(() => {
    if (!enabled) return;
    const storage = (event: StorageEvent) => {
      if (event.key === 'authToken' || (ownerRef.current && event.key === medicineDoseStorageKey(ownerRef.current))) restore(true);
    };
    const focus = () => restore(true);
    window.addEventListener('storage', storage); window.addEventListener('focus', focus);
    return () => { window.removeEventListener('storage', storage); window.removeEventListener('focus', focus); };
  }, [enabled, restore]);

  const current = (attempt: Attempt) => mounted.current && view.current.enabled && view.current.isOpen
    && attempt.generation === generation.current && ownerRef.current === attempt.scope
    && scopeReader.current() === attempt.scope;
  const storageError = (status: string) => {
    setBlocked(true); setError(status === 'locking-unavailable' ? doseRecoveryMessages.locking : doseRecoveryMessages.storage);
  };
  const observeReplacement = (snapshot: SavedMedicineDose) => {
    const read = readMedicineDose(snapshot.request.expectedScope);
    if (read.status === 'invalid' || read.status === 'unavailable') { storageError(read.status); return true; }
    if (read.status !== 'saved' || !sameSavedMedicineDose(read.snapshot, snapshot)) {
      adopt(read.status === 'saved' ? read.snapshot : null); setError(doseRecoveryMessages.changed); return true;
    }
    return false;
  };

  const send = async (saved: SavedMedicineDose | null, draft?: Draft, medicineName = '', isSupplement = false) => {
    if (attemptRef.current || !view.current.enabled || !view.current.isOpen) return;
    const scope = ownerRef.current;
    if (!scope || scopeReader.current() !== scope || (draft && draft.babyId !== view.current.babyId)
      || (saved && saved.request.expectedScope !== scope)) {
      setBlocked(true); setError(doseRecoveryMessages.owner); return;
    }
    let snapshot: SavedMedicineDose;
    try { snapshot = saved ?? freezeMedicineDose(draft!, scope, medicineName, isSupplement); }
    catch { setError('Review the dose details before saving.'); return; }
    const attempt = { scope, generation: generation.current, requestId: snapshot.request.requestId };
    attemptRef.current = attempt; setBusy(true); setError('');
    try {
      const stored = await mutateMedicineDose(scope, saved ? 'verify' : 'create', snapshot);
      if (!current(attempt)) return;
      if (stored.status === 'changed') { adopt(stored.snapshot); setError(doseRecoveryMessages.changed); return; }
      if (stored.status !== 'saved') { storageError(stored.status); return; }
      snapshot = stored.snapshot; adopt(snapshot); setBlocked(false);
      if (observeReplacement(snapshot) || !current(attempt)) return;
      const { response, data } = await requestMedicineDoseJSON(authenticatedFetch, snapshot.request);
      if (!current(attempt) || observeReplacement(snapshot)) return;
      const row = data?.data, request = snapshot.request;
      const confirmed = response.ok && data?.success === true && data.requestId === request.requestId
        && typeof row?.id === 'string' && row.familyId === JSON.parse(scope)[0]
        && row.babyId === request.babyId && row.medicineId === request.medicineId
        && Date.parse(row.time) === Date.parse(request.time) && row.doseAmount === request.doseAmount
        && (row.unitAbbr ?? null) === request.unitAbbr && (row.notes ?? null) === request.notes;
      if (!confirmed) {
        setError(response.status === 403 && data?.data?.expirationInfo && typeof data.error === 'string' ? data.error
          : response.status === 401 || response.status === 403 ? doseRecoveryMessages.auth
          : response.status === 409 ? data?.code === 'DOSE_BUSY' ? doseRecoveryMessages.pending
            : data?.code === 'DOSE_SCOPE_CHANGED' ? doseRecoveryMessages.owner : doseRecoveryMessages.conflict
            : response.status >= 400 && response.status < 500 ? typeof data?.error === 'string' ? data.error : doseRecoveryMessages.rejected : doseRecoveryMessages.pending);
        return;
      }
      const removed = await mutateMedicineDose(scope, 'remove', snapshot);
      if (!current(attempt)) return;
      if (removed.status === 'changed') { adopt(removed.snapshot); setError(doseRecoveryMessages.changed); return; }
      if (removed.status !== 'removed') { storageError(removed.status); return; }
      // A close, child/actor change, or another tab's newer request must never
      // be acknowledged by this older response or have its form closed.
      if (pendingRef.current && !sameSavedMedicineDose(pendingRef.current, snapshot)) return;
      adopt(null); setError(''); setBlocked(false); view.current.onConfirmed();
    } catch (failure) {
      if (current(attempt) && !observeReplacement(snapshot)) {
        setError(failure instanceof Error && failure.message === doseRecoveryMessages.timeout
          ? doseRecoveryMessages.timeout : doseRecoveryMessages.pending);
      }
    } finally {
      if (attemptRef.current === attempt) {
        attemptRef.current = null; if (mounted.current) setBusy(false);
      }
    }
  };

  const dismiss = async () => {
    const snapshot = pendingRef.current, scope = ownerRef.current;
    if (!snapshot || !scope || attemptRef.current || scopeReader.current() !== scope || !view.current.isOpen) return false;
    const attempt = { scope, generation: generation.current, requestId: snapshot.request.requestId };
    attemptRef.current = attempt; setBusy(true);
    try {
      const removed = await mutateMedicineDose(scope, 'remove', snapshot);
      if (!current(attempt)) return false;
      if (removed.status === 'changed') { adopt(removed.snapshot); setError(doseRecoveryMessages.changed); return false; }
      if (removed.status !== 'removed') { storageError(removed.status); return false; }
      adopt(null); setError(''); setBlocked(false); return true;
    } finally {
      if (attemptRef.current === attempt) { attemptRef.current = null; if (mounted.current) setBusy(false); }
    }
  };

  return { pending, busy, blocked, error, restore,
    submit: (draft: Draft, medicineName: string, isSupplement: boolean) => send(null, draft, medicineName, isSupplement),
    retry: () => pendingRef.current ? send(pendingRef.current) : Promise.resolve(), dismiss };
}
