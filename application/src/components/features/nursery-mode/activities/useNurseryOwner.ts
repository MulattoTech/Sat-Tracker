'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useFamily } from '@/src/context/family';
import { journalScopeFromToken } from '@/src/lib/bottle-journal/outbox-identity';

export interface NurseryOwnerCapture { scope: string; epoch: number }

/** Shared UI ownership, independent of the API's authorization decision. Every
 * awaited callback rechecks both identity and the selected-view generation. */
export function useNurseryOwner(babyId: string) {
  const { family } = useFamily();
  const environment = useRef({ familyId: family?.id, babyId });
  environment.current = { familyId: family?.id, babyId };
  const owner = useRef({ scope: null as string | null, epoch: 0 });
  const mounted = useRef(false);
  const [, render] = useReducer(value => value + 1, 0);
  const scopeNow = useCallback(() => {
    try { return journalScopeFromToken(localStorage.getItem('authToken'), environment.current.familyId, environment.current.babyId); }
    catch { return null; }
  }, []);
  const synchronize = useCallback(() => {
    const scope = scopeNow();
    if (scope !== owner.current.scope) owner.current = { scope, epoch: owner.current.epoch + 1 };
    return owner.current;
  }, [scopeNow]);
  const capture = useCallback((): NurseryOwnerCapture | null => {
    const current = synchronize();
    return current.scope ? { scope: current.scope, epoch: current.epoch } : null;
  }, [synchronize]);
  const isCurrent = useCallback((captured: NurseryOwnerCapture | null) => {
    const current = synchronize();
    return mounted.current && !!captured && current.scope === captured.scope && current.epoch === captured.epoch;
  }, [synchronize]);
  const current = synchronize();
  useEffect(() => {
    mounted.current = true;
    // Refresh captures after an effect remount (including React Strict Mode),
    // whose cleanup invalidated every callback from the previous mount.
    render();
    const check = () => { const before = owner.current; synchronize(); if (before !== owner.current) render(); };
    const storage = (event: StorageEvent) => { if (event.key === 'authToken' || event.key === null) check(); };
    window.addEventListener('storage', storage); window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      mounted.current = false; owner.current.epoch++;
      window.removeEventListener('storage', storage); window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [synchronize]);
  return { scope: current.scope, epoch: current.epoch, capture, isCurrent, scopeNow };
}
