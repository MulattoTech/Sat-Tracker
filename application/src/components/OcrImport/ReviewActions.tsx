import { AlertTriangle, BarChart3, CheckCircle2, RotateCcw, Save, ScanSearch, ShieldAlert } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { useLocalization } from '@/src/context/localization';
import type { OcrImportController } from './useOcrImport';
import { ChoiceField } from './Field';
import { calculateReviewTotals, isValidTimezone, rowReviewIssues } from './review-helpers';

export default function ReviewActions({ controller: state }: { controller: OcrImportController }) {
  const { t } = useLocalization();
  if (!state.document) return null;

  if (state.document.committedAt) return <section className="ocr-panel ocr-complete" role="status" aria-label={t('Import receipt')}>
    <CheckCircle2 aria-hidden="true" />
    <h2>{t(state.document.result?.created ? 'Import saved to the care timeline' : 'Review finalized — no new care events')}</h2>
    <p>
      {t('Created')}: <strong>{state.document.result?.created ?? 0}</strong> · {t('Already imported')}: <strong>{state.document.result?.duplicates ?? 0}</strong> · {t('Skipped by duplicate decisions')}: <strong>{state.document.rows.filter(row => row.approved && state.document?.duplicateDecisions?.[row.id] === 'skip').length}</strong>
    </p>
    <p>{state.document.rows.filter(row => !row.approved).length} {t('unchecked rows were excluded from this finalized document')}</p>
    <p className="ocr-hint">{t('This document is locked after import. Its source and review history remain available under the retention policy.')}</p>
  </section>;

  const totals = calculateReviewTotals(state.rows);
  const selected = state.rows.filter(row => row.approved && !row.rejected);
  const selectedIds = new Set(selected.map(row => row.id));
  const validTimezone = isValidTimezone(state.timeZone);
  const localErrors = !validTimezone || selected.some(row => rowReviewIssues(row, state.timeZone, state.utcOffsets[row.id]).errors.length > 0);
  const serverIssues = state.preview?.issues.filter(issue => selectedIds.has(issue.rowId)) ?? [];
  const duplicates = state.preview?.duplicates.filter(item => selectedIds.has(item.rowId)) ?? [];
  const duplicateRowIds = [...new Set(duplicates.map(item => item.rowId))];
  const unresolvedDuplicate = duplicateRowIds.some(id => !state.duplicateDecisions[id]);
  const ready = selected.length > 0 && !localErrors && Boolean(state.preview) && !serverIssues.some(issue => issue.errors.length > 0) && !unresolvedDuplicate && state.acknowledgeWarnings;

  const discardDraft = () => {
    if (window.confirm(t('Discard unsaved draft changes and revert to last saved state?'))) {
      state.revert();
    }
  };

  return <section className="ocr-panel ocr-final-review" aria-label={t('Final review and totals')}>
    {/* Live Recalculating Totals & Counts Summary */}
    <div className="ocr-totals-card" role="region" aria-label={t('Import totals summary')} aria-live="polite">
      <div className="ocr-totals-header">
        <BarChart3 size={18} aria-hidden="true" />
        <h3>{t('Care event totals summary')}</h3>
        <span className="ocr-totals-badge">{totals.approvedCount} / {totals.totalRows} {t('approved')}</span>
      </div>
      <div className="ocr-totals-grid">
        <div className="ocr-totals-metric">
          <span className="ocr-metric-label">{t('Feeding volume')}</span>
          <strong>{totals.feeds.totalMl} mL ({totals.feeds.totalOz} oz)</strong>
          <span className="ocr-hint">{totals.feeds.approvedCount} {t('approved feeds')} ({totals.feeds.bottleCount} {t('bottle')}, {totals.feeds.breastCount} {t('breast')})</span>
        </div>
        <div className="ocr-totals-metric">
          <span className="ocr-metric-label">{t('Diapers summary')}</span>
          <strong>{totals.diapers.approvedCount} {t('diapers')}</strong>
          <span className="ocr-hint">{totals.diapers.wet} {t('wet')}, {totals.diapers.dirty} {t('dirty')}, {totals.diapers.both} {t('both')}, {totals.diapers.dry} {t('dry')}</span>
        </div>
        <div className="ocr-totals-metric">
          <span className="ocr-metric-label">{t('Sleep duration')}</span>
          <strong>{Math.floor(totals.sleep.totalMinutes / 60)}h {totals.sleep.totalMinutes % 60}m</strong>
          <span className="ocr-hint">{totals.sleep.approvedCount} {t('sleep periods')} ({totals.sleep.napCount} {t('nap')}, {totals.sleep.nightSleepCount} {t('night sleep')})</span>
        </div>
        <div className="ocr-totals-metric">
          <span className="ocr-metric-label">{t('Review breakdown')}</span>
          <strong>{totals.approvedCount} {t('approved')}</strong>
          <span className="ocr-hint">{totals.rejectedCount} {t('rejected')}, {totals.excludedCount} {t('unapproved')}</span>
        </div>
      </div>
    </div>

    <div className="ocr-panel-title">
      <ScanSearch aria-hidden="true" />
      <div>
        <h2>{t('Final review')}</h2>
        <p>{selected.length} {t('approved events selected')} · {totals.rejectedCount} {t('rejected')} · {totals.excludedCount} {t('unapproved will be excluded')}</p>
      </div>
    </div>
    <p className="ocr-muted">{t('Saving a draft never writes care events. Preview checks selected events against the current timeline, then you confirm the import.')}</p>

    {!validTimezone && <p className="ocr-alert ocr-error" role="alert">{t('Choose a valid IANA time zone before checking preview or importing.')}</p>}

    <div className="ocr-button-row">
      <Button type="button" variant="outline" onClick={() => state.requestReview('save')} disabled={Boolean(state.busy)}>
        <Save size={16} aria-hidden="true" />{t('Save review draft')}
      </Button>
      <Button type="button" variant="outline" onClick={() => state.requestReview('preview')} disabled={Boolean(state.busy) || selected.length === 0 || localErrors}>
        <ScanSearch size={16} aria-hidden="true" />{t('Check selected events and duplicates')}
      </Button>
      {state.dirty && <Button type="button" variant="ghost" onClick={discardDraft} disabled={Boolean(state.busy)}>
        <RotateCcw size={16} aria-hidden="true" />{t('Discard unsaved changes')}
      </Button>}
    </div>

    {/* Interactive Preview Mode */}
    {state.preview && <div className="ocr-preview-results" role="region" aria-label={t('Import preview')}>
      <div className="ocr-preview-banner" role="status">
        <ShieldAlert size={18} aria-hidden="true" />
        <div>
          <h4>{t('Import preview — no care events saved')}</h4>
          <p>{t('These care events have been checked against the care timeline. Nothing is committed until you confirm below.')}</p>
        </div>
      </div>

      {serverIssues.filter(issue => issue.errors.length > 0 || issue.warnings.length > 0).map(issue => {
        const rowIdx = state.rows.findIndex(row => row.id === issue.rowId);
        return <div key={issue.rowId} className="ocr-notice">
          <strong>{t('Draft event')} {rowIdx + 1}</strong>
          {issue.errors.map(message => <p key={message} className="ocr-error">{t(message)}</p>)}
          {issue.warnings.map(message => <p key={message}>{t(message)}</p>)}
        </div>;
      })}

      {duplicateRowIds.map(id => {
        const rowIdx = state.rows.findIndex(row => row.id === id);
        const row = state.rows[rowIdx];
        const rowDuplicates = duplicates.filter(item => item.rowId === id);
        return <div key={id} className="ocr-duplicate" role="alert">
          <div className="ocr-duplicate-header">
            <AlertTriangle size={16} aria-hidden="true" />
            <strong>{t('Possible duplicate for draft event')} {rowIdx + 1} ({t(row?.eventType || 'event')})</strong>
          </div>
          <p>{t('Compare these existing records before choosing whether this is a separate event.')}</p>
          <ul className="ocr-duplicate-list">
            {rowDuplicates.map(item => {
              const isDraftCollision = item.recordId.startsWith('draft:');
              let draftCollisionIdx: number | null = null;
              if (isDraftCollision) {
                const targetId = item.recordId.slice('draft:'.length);
                draftCollisionIdx = state.rows.findIndex(r => r.id === targetId);
              }
              return <li key={item.recordId}>
                {isDraftCollision
                  ? <span><strong>{t('Same-sheet collision')}:</strong> {t('Matches draft event')} #{draftCollisionIdx !== null && draftCollisionIdx >= 0 ? draftCollisionIdx + 1 : '?'} ({t(item.eventType)} · {item.occurredAt})</span>
                  : <span><strong>{t('Timeline record')}:</strong> {t(item.eventType)} · {item.occurredAt}</span>}
              </li>;
            })}
          </ul>
          <p className="ocr-hint">{t('Two legitimate same-time events (e.g. twin feeding, simultaneous diaper and bottle, or top-up feed) remain distinct if you choose Keep.')}</p>
          <ChoiceField
            label="Duplicate decision"
            value={state.duplicateDecisions[id] ?? ''}
            choices={[
              ['', 'Choose after comparing'],
              ['skip', 'Skip this row — already recorded'],
              ['keep', 'Keep this row — a separate real event'],
            ]}
            onChange={value => state.changeDuplicateDecision(id, value as '' | 'skip' | 'keep')}
            disabled={Boolean(state.busy)}
          />
        </div>;
      })}

      {duplicates.length === 0 && <p className="ocr-muted">{t('No possible duplicates were reported for the selected events.')}</p>}
      {(totals.excludedCount > 0 || totals.rejectedCount > 0) && <p className="ocr-notice">
        {t('Confirming finalizes this document. Unchecked and rejected rows will be excluded and locked. Correct and approve them before confirming if you need to import them.')}
      </p>}

      <label className="ocr-approval ocr-final-approval">
        <input
          type="checkbox"
          checked={state.acknowledgeWarnings}
          disabled={Boolean(state.busy)}
          onChange={event => state.setAcknowledgeWarnings(event.target.checked)}
        />
        <span>{t('I reviewed the original source, every selected event, all corrections and warnings, and any duplicate decisions. Import these approved events.')}</span>
      </label>

      <label className="ocr-approval ocr-purge-option">
        <input
          type="checkbox"
          checked={state.purgeAfterImport}
          disabled={Boolean(state.busy)}
          onChange={event => state.setPurgeAfterImport(event.target.checked)}
        />
        <span>{t('Purge raw source document and page images immediately after successful import')}</span>
      </label>
    </div>}

    <Button
      type="button"
      variant="success"
      onClick={() => state.requestReview('commit')}
      disabled={!ready || Boolean(state.busy)}
    >
      {state.busy === 'commit' ? t('Importing approved events…') : t('Confirm and import approved events')}
    </Button>
  </section>;
}
