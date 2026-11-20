'use client';

import { useRef, useState } from 'react';
import type { InspectionSummary, RecoveryReceipt, RecoveryStatus } from '@/src/lib/portable-recovery/types';

export function useRecovery() {
  const [token, setToken] = useState('');
  const [sourceKey, setSourceKey] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [inspection, setInspection] = useState<InspectionSummary | null>(null);
  const [receipt, setReceipt] = useState<RecoveryReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  function change(kind: 'token' | 'sourceKey' | 'file', value: string | File | null) {
    generation.current++;
    setInspection(null); setError(null);
    if (kind === 'token') { setToken(value as string); setStatus(null); }
    if (kind === 'sourceKey') setSourceKey(value as string);
    if (kind === 'file') setFile(value as File | null);
  }

  async function request<T>(path: string, body?: FormData): Promise<T> {
    const response = await fetch('/api/recovery/' + path, {
      method: body ? 'POST' : 'GET', cache: 'no-store',
      headers: { 'X-Sat-Recovery-Token': token }, ...(body ? { body } : {}),
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || 'The request failed. Your selected file and entered values have been kept.');
    return result.data as T;
  }

  async function run(action: 'status' | 'inspect' | 'commit') {
    setBusy(true); setError(null);
    const revision = generation.current;
    try {
      if (action === 'status') {
        const next = await request<RecoveryStatus>('status');
        if (revision !== generation.current) return;
        setStatus(next);
        if (next.receipt) { setReceipt(next.receipt); setSourceKey(''); setToken(''); }
        return;
      }
      if (!file) throw new Error('Choose a backup archive first.');
      if (!token || !sourceKey) throw new Error('Enter the recovery operator token and source recovery key.');
      if (status && file.size > status.maxArchiveBytes) throw new Error('This backup exceeds the supported upload size.');
      if (action === 'commit' && (!inspection?.canRestore || !inspection.archiveSha256)) {
        throw new Error('The selected archive or recovery key changed. Inspect the backup again.');
      }
      const body = new FormData();
      body.set('archive', file); body.set('sourceKey', sourceKey);
      if (action === 'commit') body.set('archiveSha256', inspection!.archiveSha256);
      const result = await request<InspectionSummary | RecoveryReceipt>(action, body);
      if (revision !== generation.current) return;
      if (action === 'inspect') setInspection(result);
      else {
        setReceipt(result as RecoveryReceipt); setSourceKey(''); setToken('');
        setStatus(previous => previous ? { ...previous, state: 'complete', ready: false } : null);
      }
    } catch (failure) {
      if (revision === generation.current) {
        setError(failure instanceof Error ? failure.message : 'The request failed. Your selected file and entered values have been kept.');
      }
    } finally { setBusy(false); }
  }

  return { token, sourceKey, file, status, inspection, receipt, busy, error, change, run };
}
