'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFamily } from '@/src/context/family';
import type { BottlePayload, BottleRow, JournalData, JournalRequest } from './types';
import { useJournalOutbox } from './useJournalOutbox';

export function useBottleJournal(babyId: string | undefined, day: string, timeZone: string) {
  const { authenticatedFetch } = useFamily();
  const [data, setData] = useState<JournalData | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false), [refreshing, setRefreshing] = useState(false);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const etag = useRef(''), sequence = useRef(0);
  const inFlight = useRef<{ identity: string; ticket: number } | null>(null);
  const identity = `${babyId}:${day}:${timeZone}`;
  const identityRef = useRef(identity); identityRef.current = identity;
  const refresh = useCallback(async (force = false) => {
    if (!babyId || identity !== identityRef.current || (!force && inFlight.current?.identity === identity)) return;
    const current = identity, ticket = ++sequence.current;
    inFlight.current = { identity: current, ticket }; setRefreshing(true);
    try {
      const query = new URLSearchParams({ babyId, day, timeZone });
      const response = await authenticatedFetch('/api/bottle-journal?' + query, { cache: 'no-store', headers: !force && etag.current ? { 'If-None-Match': etag.current } : {} });
      if (ticket !== sequence.current || current !== identityRef.current) return;
      if (response.status !== 304) {
        const result = await response.json();
        if (!response.ok || !result.success) throw new Error(result.error || 'The journal could not refresh.');
        setData(result.data); etag.current = response.headers.get('etag') || '';
      }
      setLastSynced(new Date()); setError('');
    } catch (error) {
      if (ticket === sequence.current && current === identityRef.current) setError(error instanceof Error ? error.message : 'The journal could not refresh.');
    } finally {
      if (inFlight.current?.ticket === ticket) inFlight.current = null;
      if (ticket === sequence.current && current === identityRef.current) setRefreshing(false);
    }
  }, [babyId, day, timeZone, identity, authenticatedFetch]);
  const outbox = useJournalOutbox(babyId, () => { etag.current = ''; setNotice('Bottle saved.'); void refresh(true); });
  useEffect(() => {
    etag.current = ''; setData(null); setError(''); setNotice(''); setLastSynced(null);
    // A new selection and a confirmed save must refresh even if an older request is finishing.
    const start = setTimeout(() => void refresh(true), 0);
    const interval = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 15_000);
    const foreground = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', foreground); window.addEventListener('online', foreground);
    document.addEventListener('visibilitychange', foreground);
    return () => { clearTimeout(start); clearInterval(interval); window.removeEventListener('focus', foreground); window.removeEventListener('online', foreground); document.removeEventListener('visibilitychange', foreground); };
  }, [identity, refresh]);
  const request: JournalRequest = async <T,>(url: string, body: unknown, method = 'POST') => {
    const response = await authenticatedFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || 'The journal request failed.');
    return result.data as T;
  };
  async function save(bottle: BottlePayload, requestId: string, editing?: BottleRow) {
    if (!babyId || saving) return false;
    const current = identityRef.current;
    setSaving(true); setError(''); setNotice('');
    try {
      if (!editing && outbox.available) {
        const result = await outbox.enqueue(bottle, requestId);
        if (current === identityRef.current) setNotice(result === 'saved' ? 'Bottle saved.' : 'Bottle saved on this browser. Waiting for server confirmation.');
        return true;
      }
      await request('/api/bottle-journal', { babyId, bottle, requestId, ...(editing ? { expectedUpdatedAt: editing.updatedAt } : {}) });
      if (current === identityRef.current) { setNotice('Bottle saved.'); etag.current = ''; await refresh(true); }
      return true;
    } catch (error) { if (current === identityRef.current) setError(error instanceof Error ? error.message : 'The bottle was not confirmed saved. Keep the form open and retry.'); return false; }
    finally { setSaving(false); }
  }
  async function setTarget(targetMl: number | null) {
    if (!babyId || saving) return;
    const current = identityRef.current;
    setSaving(true); setError('');
    try {
      await request('/api/bottle-journal', { babyId, targetMl }, 'PATCH');
      if (current === identityRef.current) { setNotice('Intake target saved.'); etag.current = ''; await refresh(true); }
    } catch (error) { if (current === identityRef.current) setError(error instanceof Error ? error.message : 'The intake target could not be saved.'); }
    finally { setSaving(false); }
  }
  return { data: data && data.babyId === babyId && data.day === day && data.timeZone === timeZone ? data : null, error, notice, saving, refreshing, lastSynced, refresh, save, setTarget, request, outbox };
}
