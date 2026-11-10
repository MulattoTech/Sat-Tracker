'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFamily } from '@/src/context/family';
import { journalScopeFromToken } from '@/src/lib/bottle-journal/outbox-identity';
import { changePendingBottle, claimBottle, enqueueBottle, listPendingBottles, settleBottle, type PendingBottle } from '@/src/lib/bottle-journal/outbox';
import type { BottlePayload } from './types';
import { readNurseryUndo, type NurseryUndo } from '@/src/utils/nursery/undo';

export function useJournalOutbox(babyId: string | undefined, onSynced: (row: PendingBottle, undo: NurseryUndo | null) => void) {
  const { family, authenticatedFetch } = useFamily();
  const [snapshot, setSnapshot] = useState<{ scope: string | null; rows: PendingBottle[] }>({ scope: null, rows: [] });
  const [error, setError] = useState(''), [syncing, setSyncing] = useState(false);
  const [online, setOnline] = useState(true);
  const running = useRef(false), synced = useRef(onSynced); synced.current = onSynced;
  const readScope = useCallback(() => {
    try { return journalScopeFromToken(localStorage.getItem('authToken'), family?.id, babyId); }
    catch { return null; }
  }, [family?.id, babyId]);
  const currentScope = useRef(readScope); currentScope.current = readScope;
  const reload = useCallback(async () => {
    const scope = readScope();
    if (!scope) { setSnapshot({ scope: null, rows: [] }); return; }
    const rows = await listPendingBottles(scope);
    if (scope === currentScope.current()) setSnapshot({ scope, rows });
  }, [readScope]);
  const drain = useCallback(async () => {
    const confirmed = new Set<string>();
    const scope = readScope();
    if (!scope || running.current || !navigator.onLine) return confirmed;
    running.current = true; setSyncing(true);
    try {
      for (let count = 0; count < 100 && navigator.onLine && scope === currentScope.current(); count++) {
        const row = await claimBottle(scope);
        if (!row) break;
        if (scope !== currentScope.current()) { await settleBottle(row, false, 401); break; }
        let success = false, status = 0, undo: NurseryUndo | null = null;
        try {
          const response = await authenticatedFetch('/api/bottle-journal', { method: 'POST', cache: 'no-store',
            headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20_000),
            body: JSON.stringify({ babyId: row.babyId, bottle: row.bottle, requestId: row.requestId, expectedScope: scope }) });
          status = response.status;
          const result = await response.json();
          success = response.ok && result.success === true && result.data?.id === row.requestId;
          const candidate = success && result.data?.created === true ? readNurseryUndo(result.data.undo) : null;
          if (candidate?.kind === 'bottle' && candidate.scope === scope && candidate.records[0].id === row.requestId) undo = candidate;
          // A malformed success response is uncertain delivery, never success.
          if (response.ok && !success) status = 0;
        } catch { if (status >= 200 && status < 300) status = 0; /* Unreadable success is uncertain delivery. */ }
        await settleBottle(row, success, status);
        if (success) confirmed.add(row.requestId);
        if (success && scope === currentScope.current()) synced.current(row, undo);
        if (!success) break;
      }
      await reload();
    } catch (failure) {
      if (scope === currentScope.current()) setError(failure instanceof Error ? failure.message : 'Pending bottles could not be read.');
    } finally { running.current = false; setSyncing(false); }
    return confirmed;
  }, [readScope, authenticatedFetch, reload]);
  useEffect(() => {
    let active = true;
    const check = () => {
      if (!active) return;
      setOnline(navigator.onLine);
      void reload().then(() => { if (active) void drain(); }).catch(failure => {
        if (active) setError(failure instanceof Error ? failure.message : 'Pending bottles could not be read.');
      });
    };
    setError(''); setSnapshot({ scope: null, rows: [] }); check();
    const interval = setInterval(check, 5000);
    window.addEventListener('online', check); window.addEventListener('offline', check);
    window.addEventListener('focus', check); window.addEventListener('storage', check);
    return () => { active = false; clearInterval(interval); window.removeEventListener('online', check);
      window.removeEventListener('offline', check); window.removeEventListener('focus', check); window.removeEventListener('storage', check); };
  // The scope is re-read on every action; rows never authorize a request.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readScope, reload, drain]);
  async function enqueue(bottle: BottlePayload, requestId: string) {
    const scope = readScope();
    if (!scope || !babyId) throw new Error('Sign in to this family before saving a pending bottle.');
    setError('');
    await enqueueBottle(scope, babyId, bottle, requestId);
    await reload();
    const confirmed = await drain();
    if (confirmed.has(requestId)) return 'saved';
    if ((await listPendingBottles(scope)).some(row => row.requestId === requestId)) return 'queued';
    // Absence can also mean an explicit discard in another tab. It is not a
    // server receipt and must never produce a successful-save claim.
    throw new Error('This pending bottle changed in another tab. Refresh the journal before trying again.');
  }
  async function change(requestId: string, action: 'retry' | 'discard') {
    const scope = readScope();
    if (!scope || scope !== snapshot.scope) return;
    setError('');
    try { await changePendingBottle(scope, requestId, action); await reload(); if (action === 'retry') await drain(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Pending bottles could not be read.'); }
  }
  return { rows: snapshot.scope === readScope() ? snapshot.rows : [], error, syncing, online,
    available: Boolean(readScope()), enqueue, change, sync: drain };
}
