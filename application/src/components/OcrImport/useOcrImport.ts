import { useEffect, useRef, useState } from 'react';
import type { OcrCandidate } from '@/src/lib/ocr/types';
import type { OcrDocumentSummary, OcrDocumentView, OcrReviewPreview, OcrReviewRequest } from '@/src/lib/ocr/contracts';
import { useLocalization } from '@/src/context/localization';
import { ocrRequest } from './api';
import { editOcrRow, manualOcrRow, mergeOcrRows, rowReviewIssues } from './review-helpers';

export function useOcrImport(babyId: string | undefined, defaultTimeZone: string) {
  const { t } = useLocalization();
  const [history, setHistory] = useState<OcrDocumentSummary[]>([]);
  const [document, setDocument] = useState<OcrDocumentView | null>(null);
  const [rows, setRows] = useState<OcrCandidate[]>([]);
  const [timeZone, setTimeZone] = useState(defaultTimeZone);
  const [utcOffsets, setUtcOffsets] = useState<NonNullable<OcrReviewRequest['utcOffsets']>>({});
  const [duplicateDecisions, setDuplicateDecisions] = useState<NonNullable<OcrReviewRequest['duplicateDecisions']>>({});
  const [preview, setPreview] = useState<OcrReviewPreview | null>(null);
  const [acknowledgeWarnings, setAcknowledgeWarnings] = useState(false);
  const [purgeAfterImport, setPurgeAfterImport] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dirty, setDirty] = useState(false);
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    const current = ++generation.current;
    const abort = new AbortController();
    pending.current?.abort(); pending.current = abort;
    setHistory([]); setDocument(null); setRows([]); setUtcOffsets({}); setPreview(null);
    setDuplicateDecisions({}); setAcknowledgeWarnings(false); setDirty(false); setError(''); setNotice(''); setBusy('');
    if (babyId) {
      ocrRequest<OcrDocumentSummary[]>(`?babyId=${encodeURIComponent(babyId)}`, { signal: abort.signal })
        .then(data => { if (generation.current === current) setHistory(data); })
        .catch(reason => { if (generation.current === current && reason?.name !== 'AbortError') setError(reason.message); });
    }
    return () => { abort.abort(); pending.current?.abort(); };
  }, [babyId]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const acceptDocument = (view: OcrDocumentView) => {
    setUtcOffsets(view.utcOffsets ?? {});
    setDocument(view); setRows(view.rows); setTimeZone(view.sourceTimezone); setDirty(false);
    setPreview(null); setAcknowledgeWarnings(false); setPurgeAfterImport(false); setDuplicateDecisions(view.duplicateDecisions ?? {});
    setHistory(current => [view, ...current.filter(item => item.id !== view.id)]);
  };
  const perform = async <T,>(name: string, operation: (signal: AbortSignal) => Promise<T>, accept: (value: T) => void, message = '') => {
    const current = generation.current;
    const abort = new AbortController();
    pending.current?.abort(); pending.current = abort;
    setBusy(name); setError(''); setNotice('');
    try {
      const result = await operation(abort.signal);
      if (generation.current === current && !abort.signal.aborted) { accept(result); setNotice(message); }
    } catch (reason) {
      if (generation.current === current && !abort.signal.aborted) setError(reason instanceof Error ? reason.message : t('The document request could not be completed.'));
    } finally { if (generation.current === current && pending.current === abort) setBusy(''); }
  };
  const invalidate = () => { setPreview(null); setAcknowledgeWarnings(false); setDuplicateDecisions({}); setDirty(true); setNotice(''); };
  const edit = (id: string, patch: Partial<OcrCandidate>) => {
    setRows(current => current.map(row => row.id === id ? editOcrRow(row, patch) : row));
    setUtcOffsets(current => { const next = { ...current }; delete next[id]; return next; }); invalidate();
  };
  const approve = (id: string, approved: boolean) => {
    setRows(current => current.map(row => {
      if (row.id !== id) return row;
      if (approved && (row.rejected || rowReviewIssues(row, timeZone, utcOffsets[id]).errors.length > 0)) return row;
      return { ...row, approved };
    }));
    invalidate();
  };
  const approveValid = () => {
    setRows(current => current.map(row => {
      if (row.rejected) return { ...row, approved: false };
      return { ...row, approved: rowReviewIssues(row, timeZone, utcOffsets[row.id]).errors.length === 0 };
    }));
    invalidate();
  };
  const reject = (id: string, rejected: boolean) => {
    setRows(current => current.map(row => row.id === id ? { ...row, rejected, approved: false } : row));
    setUtcOffsets(current => {
      if (rejected) {
        const next = { ...current };
        delete next[id];
        return next;
      }
      return current;
    });
    invalidate();
  };
  const merge = (targetId: string, sourceId: string) => {
    let mergedRow: OcrCandidate | null = null;
    setRows(current => {
      const target = current.find(r => r.id === targetId);
      const source = current.find(r => r.id === sourceId);
      if (!target || !source) return current;
      mergedRow = mergeOcrRows(target, source);
      return current.filter(r => r.id !== sourceId).map(r => r.id === targetId ? mergedRow! : r);
    });
    setUtcOffsets(current => {
      const next = { ...current };
      delete next[sourceId];
      delete next[targetId];
      return next;
    });
    invalidate();
    setNotice(t('Merged draft events successfully.'));
  };
  const revert = () => {
    if (!document) return;
    setRows(document.rows);
    setTimeZone(document.sourceTimezone);
    setUtcOffsets(document.utcOffsets ?? {});
    setDuplicateDecisions(document.duplicateDecisions ?? {});
    setPreview(null);
    setAcknowledgeWarnings(false);
    setDirty(false);
    setError('');
    setNotice(t('Draft changes reverted to last saved state.'));
  };
  const changeTimeZone = (value: string) => {
    setTimeZone(value); setUtcOffsets({}); setRows(current => current.map(row => ({ ...row, approved: false }))); invalidate();
  };
  const setOffset = (id: string, key: 'start' | 'end', value: number | undefined) => {
    setUtcOffsets(current => ({ ...current, [id]: { ...current[id], [key]: value } }));
    setRows(current => current.map(row => row.id === id ? { ...row, approved: false } : row)); invalidate();
  };
  const changeDuplicateDecision = (id: string, value: '' | 'skip' | 'keep') => {
    setDuplicateDecisions(current => {
      const next = { ...current }; if (value) next[id] = value; else delete next[id]; return next;
    });
    setDirty(true); setAcknowledgeWarnings(false); setNotice('');
  };
  const add = (page: number, copy?: OcrCandidate) => {
    const blank = manualOcrRow(page, crypto.randomUUID());
    const row = copy ? { ...copy, id: blank.id, source: blank.source, approved: false, rejected: false, warnings: blank.warnings,
      fieldSources: Object.fromEntries(Object.keys(copy.fieldSources).map(key => [key, 'corrected' as const])) } : blank;
    setRows(current => [...current.map(item => item.id === copy?.id ? { ...item, approved: false } : item), row]); invalidate();
  };
  const remove = (id: string) => {
    setRows(current => current.filter(row => row.id !== id));
    setUtcOffsets(current => { const next = { ...current }; delete next[id]; return next; }); invalidate();
  };
  const bulkDate = (value: string) => {
    setRows(current => current.map(row => row.rejected ? row : editOcrRow(row, { localDate: value || null })));
    setUtcOffsets({});
    invalidate();
  };
  const payload = (): OcrReviewRequest => ({ revision: document!.revision, rows, timeZone, utcOffsets, duplicateDecisions, acknowledgeWarnings, purgeSourceAfterCommit: purgeAfterImport });
  const open = (id: string) => {
    if (dirty && !window.confirm(t('Discard unsaved draft changes and open another document?'))) return;
    return perform('open', signal => ocrRequest<OcrDocumentView>(`/${encodeURIComponent(id)}`, { signal }), acceptDocument);
  };
  const upload = (form: FormData) => {
    if (dirty && !window.confirm(t('Discard unsaved draft changes and upload another document?'))) return;
    if (!babyId) return;
    form.set('babyId', babyId);
    return perform('upload', signal => ocrRequest<OcrDocumentView>('', { method: 'POST', body: form, signal }), acceptDocument, 'Draft extracted. Review every selected event before importing.');
  };
  const requestReview = (action: 'save' | 'preview' | 'commit') => {
    if (!document) return;
    const path = `/${encodeURIComponent(document.id)}${action === 'save' ? '' : `/${action}`}`;
    const init = { method: action === 'save' ? 'PATCH' : 'POST', body: JSON.stringify(payload()) };
    if (action === 'preview') return perform('preview', signal => ocrRequest<OcrReviewPreview>(path, { ...init, signal }), setPreview, 'Preview checked against current records. No care events were saved.');
    return perform(action, signal => ocrRequest<OcrDocumentView>(path, { ...init, signal }), acceptDocument,
      action === 'save' ? 'Draft saved. No care events were imported.' : 'Review finalized. See the saved import receipt.');
  };
  const purge = () => {
    if (dirty) { setError('Save your draft before removing source files.'); return; }
    if (!document || !window.confirm(t('Permanently remove the original document and page previews? Imported care events and the audit trail will remain.'))) return;
    return perform('purge', signal => ocrRequest<OcrDocumentView>(`/${encodeURIComponent(document.id)}`, { method: 'DELETE', signal }), acceptDocument, 'Source files removed. Care events and audit history are preserved.');
  };
  const refreshHistory = () => {
    if (!babyId) return;
    return perform('history', signal => ocrRequest<OcrDocumentSummary[]>(`?babyId=${encodeURIComponent(babyId)}`, { signal }), setHistory);
  };
  const cancel = () => { pending.current?.abort(); setBusy(''); setNotice('Recognition canceled. Check document history for any retained draft; no events are imported without approval.'); };
  return { history, document, rows, timeZone, utcOffsets, duplicateDecisions, preview, acknowledgeWarnings,
    busy, error, notice, dirty, edit, approve, approveValid, reject, merge, revert, changeTimeZone, setOffset, add, remove,
    bulkDate, open, upload, requestReview, purge, refreshHistory, cancel,
    setAcknowledgeWarnings, changeDuplicateDecision, purgeAfterImport, setPurgeAfterImport };
}

export type OcrImportController = ReturnType<typeof useOcrImport>;
