'use client';

import { useEffect, useRef, useState } from 'react';
import { Columns2, FileCheck2, Plus, RefreshCw, Rows2 } from 'lucide-react';
import { useBaby } from '@/app/context/baby';
import { useTimezone } from '@/app/context/timezone';
import { useLocalization } from '@/src/context/localization';
import { Button } from '@/src/components/ui/button';
import { isOcrDate } from '@/src/lib/ocr/validation';
import { useOcrImport } from './useOcrImport';
import { isValidTimezone } from './review-helpers';
import { ChoiceField, TextField } from './Field';
import UploadPanel from './UploadPanel';
import SourcePanel from './SourcePanel';
import RowEditor from './RowEditor';
import ReviewActions from './ReviewActions';
import './ocr-import.css';

export default function OcrImport() {
  const { selectedBaby } = useBaby();
  const { userTimezone } = useTimezone();
  const { t } = useLocalization();
  const state = useOcrImport(selectedBaby?.id, userTimezone);
  const [page, setPage] = useState(1);
  const [bulkDate, setBulkDate] = useState('');
  const [showUpload, setShowUpload] = useState(true);
  const [layoutMode, setLayoutMode] = useState<'side-by-side' | 'stacked'>('side-by-side');
  const sourceRef = useRef<HTMLDivElement>(null);
useEffect(() => { setPage(state.document?.pages?.[0] ?? 1); setBulkDate(''); if (state.document) setShowUpload(false); }, [state.document?.id]);
  useEffect(() => { setShowUpload(true); }, [selectedBaby?.id]);

  const document = state.document?.babyId === selectedBaby?.id ? state.document : null;
  const locked = Boolean(state.busy || document?.committedAt);
  const selectedCount = state.rows.filter(row => row.approved && !row.rejected).length;
  const isTzValid = isValidTimezone(state.timeZone);

  const viewSource = (nextPage: number) => {
    setPage(nextPage);
    sourceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return <section className="ocr-import" aria-labelledby="ocr-import-title">
    <header className="ocr-hero">
      <div className="ocr-eyebrow"><FileCheck2 size={17} aria-hidden="true" />{t('Care record import')}</div>
      <h1 id="ocr-import-title">{t('Document import')}</h1>
      <p>{t('Turn paper feeding, diaper and sleep logs into reviewed care events. Your original stays beside every correction.')}</p>
      <div className="ocr-badges"><span>{t('Local recognition')}</span><span>{t('Explicit approval')}</span><span>{t('Source history')}</span></div>
    </header>

    {!selectedBaby ? <section className="ocr-panel"><h2>{t('Choose a child first')}</h2><p>{t('Use the child selector above to choose whose care records you want to import.')}</p></section> : <>
      <div className="ocr-workflow" aria-label={t('Import stages')}>
        <span className={document ? 'ocr-stage-done' : 'ocr-stage-current'}>1 · {t('Upload source')}</span>
        <span className={document && !document.committedAt ? 'ocr-stage-current' : ''}>2 · {t('Review and correct')}</span>
        <span className={document?.committedAt ? 'ocr-stage-done' : ''}>3 · {t('Confirm import')}</span>
      </div>

      {state.error && <div className="ocr-alert ocr-error" role="alert">{t(state.error)}</div>}
      {state.notice && <div className="ocr-alert ocr-notice" role="status">{t(state.notice)}</div>}
      {state.busy && <p className="ocr-hint" role="status" aria-live="polite">{t('Working on this document…')}</p>}

      <section className="ocr-panel ocr-history" aria-label={t('Document history')}>
        <ChoiceField label="Document history" value={document?.id ?? ''} disabled={Boolean(state.busy)} onChange={id => { if (id) state.open(id); }} choices={[
          ['', 'Choose a saved draft or import'], ...state.history.filter(item => item.babyId === selectedBaby.id).map(item => [item.id, `${item.originalName} · ${t(item.committedAt ? 'Imported' : 'Draft')} · ${new Date(item.createdAt).toLocaleDateString()}`] as const),
        ]} />
        <Button type="button" variant="outline" size="sm" disabled={Boolean(state.busy)} onClick={state.refreshHistory}><RefreshCw size={14} aria-hidden="true" />{t('Refresh history')}</Button>
        <Button type="button" variant="outline" size="sm" disabled={Boolean(state.busy)} onClick={() => setShowUpload(value => !value)}>{t(showUpload ? 'Hide upload form' : 'Upload another document')}</Button>
      </section>

      {showUpload && <UploadPanel key={selectedBaby.id} babyName={selectedBaby.firstName} defaultTimeZone={userTimezone} busy={state.busy} onUpload={state.upload} onCancel={state.cancel} />}

      {document && <>
        <div className="ocr-review-heading">
          <div>
            <h2>{document.committedAt ? t('Saved import review') : t('Review draft')}</h2>
            <p>{t('For')}: <strong>{selectedBaby.firstName}</strong> · {state.rows.length} {t('draft rows')} · {selectedCount} {t('approved')}</p>
          </div>
          <div className="ocr-heading-actions">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setLayoutMode(mode => mode === 'side-by-side' ? 'stacked' : 'side-by-side')}
              aria-label={t(layoutMode === 'side-by-side' ? 'Switch to stacked view' : 'Switch to side-by-side view')}
            >
              {layoutMode === 'side-by-side' ? <Rows2 size={14} aria-hidden="true" /> : <Columns2 size={14} aria-hidden="true" />}
              {t(layoutMode === 'side-by-side' ? 'Stacked view' : 'Side-by-side view')}
            </Button>
            <span className="ocr-status">{t(document.committedAt ? 'Imported' : state.dirty ? 'Unsaved draft changes' : 'Draft saved')}</span>
          </div>
        </div>

        <div className={`ocr-review-layout ${layoutMode === 'stacked' ? 'ocr-layout-stacked' : 'ocr-layout-side-by-side'}`}>
          <div ref={sourceRef}><SourcePanel document={document} page={page} onPage={setPage} busy={Boolean(state.busy)} onPurge={state.purge} /></div>
          <section className="ocr-events" aria-label={t('Editable care events')}>
            {!document.committedAt && <section className="ocr-panel ocr-review-tools">
              <div className="ocr-timezone-container">
                <TextField label="Time zone for this document" value={state.timeZone} onChange={state.changeTimeZone} disabled={locked} />
                {!isTzValid && <span className="ocr-field-error" role="alert">{t('Invalid IANA time zone (e.g. America/Chicago, UTC)')}</span>}
              </div>
              <p className="ocr-hint">{t('Changing a field or time zone clears approval. Unchecked rows are excluded from import. Confirming locks every row in this document.')}</p>
              <div className="ocr-bulk-date">
                <TextField label="Apply date to all draft rows" type="date" value={bulkDate} onChange={setBulkDate} disabled={locked} />
                <Button type="button" variant="outline" size="sm" disabled={locked || !isOcrDate(bulkDate)} onClick={() => state.bulkDate(bulkDate)}>{t('Apply date and clear approvals')}</Button>
              </div>
              <div className="ocr-button-row">
                <Button type="button" variant="outline" size="sm" disabled={locked || state.rows.length >= 200} onClick={() => state.add(page)}><Plus size={14} aria-hidden="true" />{t('Add manual event')}</Button>
                <Button type="button" variant="outline" size="sm" disabled={locked || state.rows.length === 0 || !isTzValid} onClick={state.approveValid}>{t('Approve all valid rows I reviewed')}</Button>
              </div>
            </section>}

            {state.rows.length === 0 && <section className="ocr-panel ocr-empty"><h3>{t('No events recognized yet')}</h3><p>{t('Keep the source open and add events manually. Unreadable handwriting never becomes a guessed care record.')}</p></section>}

            {state.rows.map((row, index) => {
              const isDuplicate = state.preview?.duplicates.some(d => d.rowId === row.id);
              const duplicateDecision = state.duplicateDecisions[row.id];
              return <RowEditor
                key={row.id}
                row={row}
                number={index + 1}
                timeZone={state.timeZone}
                offsets={state.utcOffsets[row.id]}
                locked={locked}
                isDuplicate={isDuplicate}
                duplicateDecision={duplicateDecision}
                canMergePrevious={index > 0 && !locked}
                canMergeNext={index < state.rows.length - 1 && !locked}
                onEdit={patch => state.edit(row.id, patch)}
                onApprove={approved => state.approve(row.id, approved)}
                onReject={rejected => state.reject(row.id, rejected)}
                onOffset={(key, value) => state.setOffset(row.id, key, value)}
                onSource={() => viewSource(row.source.page)}
                onSplit={() => { if (state.rows.length < 200) state.add(row.source.page, row); }}
                onMergePrevious={() => { if (index > 0) state.merge(row.id, state.rows[index - 1].id); }}
                onMergeNext={() => { if (index < state.rows.length - 1) state.merge(row.id, state.rows[index + 1].id); }}
                onRemove={() => state.remove(row.id)}
              />;
            })}
          </section>
        </div>
        <ReviewActions controller={state} />
      </>}
    </>}
  </section>;
}
