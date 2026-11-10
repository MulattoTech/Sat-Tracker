'use client';
import { useState } from 'react';
import { useLocalization } from '@/src/context/localization';
import { bottleInput, localTimeToInstant } from '@/src/lib/bottle-journal/validation';
import type { LegacyBottle } from '@/src/lib/bottle-journal/legacy';
import type { JournalRequest } from './types';

interface Row extends LegacyBottle { imported: boolean; possible: boolean; approved?: boolean; duplicateDecision?: string }
interface Preview { rows: Row[]; warnings: string[]; targetMl: number | null }
export default function LegacyImport({ babyId, timeZone, request, onImported }: { babyId: string; timeZone: string; request: JournalRequest; onImported: () => void }) {
  const { t } = useLocalization();
  const [preview, setPreview] = useState<Preview | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [summary, setSummary] = useState(''), [confirmed, setConfirmed] = useState(false);
  async function upload(file?: File) {
    if (!file) return; setError(''); setSummary(''); setPreview(null); setConfirmed(false); setBusy(true);
    try {
      if (file.size > 1_500_000) throw new Error('Choose a journal export smaller than 1.5 MB.');
      const format = file.name.toLowerCase().endsWith('.json') ? 'json' : file.name.toLowerCase().endsWith('.csv') ? 'csv' : '';
      setPreview(await request<Preview>('/api/bottle-journal/import', { action: 'preview', babyId, timeZone, format, content: await file.text() }));
    } catch (error) { setError(error instanceof Error ? error.message : 'The backup could not be read.'); }
    finally { setBusy(false); }
  }
  function edit(index: number, patch: Partial<Row>) {
    setConfirmed(false);
    setPreview(current => current ? { ...current, rows: current.rows.map((original, i) => {
      if (i !== index) return original;
      const row = { ...original, ...patch, approved: false };
      try {
        if ('localTime' in patch) row.time = /(?:Z|[+-]\d{2}:\d{2})$/.test(row.localTime) ? row.localTime : localTimeToInstant(row.localTime, timeZone);
        bottleInput(row); row.issue = null;
      } catch (error) { row.issue = error instanceof Error ? error.message : 'Correct this bottle before importing.'; }
      return row;
    }) } : null);
  }
  async function commit() {
    if (!preview) return; setBusy(true); setError('');
    try {
      const result = await request<{ created: number; duplicates: number; skipped: number }>('/api/bottle-journal/import', {
        action: 'commit', babyId, confirmed, rows: preview.rows.filter(row => row.approved && !row.imported),
      });
      setSummary(`${result.created} ${t('bottles imported')}; ${result.duplicates} ${t('already imported')}; ${result.skipped} ${t('duplicates skipped')}.`);
      setPreview(null); setConfirmed(false); onImported();
    } catch (error) { setError(error instanceof Error ? error.message : 'The import was not confirmed. Keep this review open and retry.'); }
    finally { setBusy(false); }
  }
  return <details className="journal-card journal-import"><summary>{t('Recover Family Bottle Journal history')}</summary>
    <p>{t('Choose a JSON backup or CSV export from the old journal. Review each bottle before adding it to this child. The original file stays unchanged.')}</p>
    <label>{t('Journal backup or CSV')}<input type="file" accept=".json,.csv,application/json,text/csv" disabled={busy} onChange={event => { void upload(event.target.files?.[0]); event.target.value = ''; }} /></label>
    {busy && <p role="status">{t('Working…')}</p>}
    {error && <p role="alert" className="journal-error">{t(error)}</p>}
    {summary && <p role="status" className="journal-notice">{summary}</p>}
    {preview && <>
      {preview.warnings.map(warning => <p className="journal-warning" key={warning}>{t(warning)}</p>)}
      {preview.targetMl !== null && <p>{t('Target in the old journal')}: {preview.targetMl} mL. {t('Set the target separately after reviewing it; importing bottles does not change it.')}</p>}
      <p>{preview.rows.length} {t('bottles found')}. {t('Dates and times use')} {timeZone}.</p>
      <div className="journal-review-rows">
        {preview.rows.map((row, index) => <section key={row.sourceId} className="journal-review-row" aria-label={`${t('Bottle')} ${index + 1}`}>
          <div className="journal-section-title"><strong>{t('Bottle')} {index + 1}</strong><label className="journal-check"><input type="checkbox" checked={row.approved || false} disabled={busy || row.imported || Boolean(row.issue)} onChange={e => { const checked = e.target.checked; setConfirmed(false); setPreview(current => current ? { ...current, rows: current.rows.map((r, i) => i === index ? { ...r, approved: checked } : r) } : null); }} />{t(row.imported ? 'Already imported' : 'Reviewed')}</label></div>
          <div className="journal-fields">
            <label>{t('Date and time (ISO)')}<input value={row.localTime} placeholder="2026-11-01T08:30" disabled={busy || row.imported} onChange={e => edit(index, { localTime: e.target.value })} /></label>
            <label>{t('Consumed (mL)')}<input type="number" inputMode="decimal" step="any" value={row.amount ?? ''} disabled={busy || row.imported} onChange={e => edit(index, { amount: e.target.value === '' ? null : Number(e.target.value) })} /></label>
            <label>{t('Concentration (kcal/oz, optional)')}<input type="number" inputMode="decimal" step="any" value={row.formulaKcalOz ?? ''} disabled={busy || row.imported} onChange={e => edit(index, { formulaKcalOz: e.target.value === '' ? null : Number(e.target.value) })} /></label>
            <label>{t('Milk type')}<select value={row.bottleType} disabled={busy || row.imported} onChange={e => edit(index, { bottleType: e.target.value })}><option value="Formula">{t('Formula')}</option><option value="Breast Milk">{t('Breast Milk')}</option><option value="Other">{t('Other')}</option></select></label>
          </div>
          <label>{t('Notes')}<textarea aria-label={t('Notes')} value={row.notes || ''} disabled={busy || row.imported} onChange={e => edit(index, { notes: e.target.value || null })} maxLength={2000} /></label>
          {row.sourceCaregiverName && <p>{t('Recorded by')}: {row.sourceCaregiverName}</p>}
          {row.issue && <p className="journal-warning">{t(row.issue)}</p>}
          {!row.imported && <label className={row.possible ? 'journal-warning' : ''}>{t(row.possible ? 'Possible duplicate' : 'If a matching bottle is found')}<select disabled={busy} value={row.duplicateDecision || ''} onChange={e => edit(index, { duplicateDecision: e.target.value })}><option value="">{t('Choose a decision')}</option><option value="skip">{t('Skip matching bottle')}</option><option value="keep">{t('Keep both bottles')}</option></select></label>}
        </section>)}
      </div>
      <label className="journal-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />{t('I checked every selected bottle against the original journal.')}</label>
      <button type="button" className="journal-primary" disabled={busy || !confirmed || !preview.rows.some(row => row.approved && !row.imported)} onClick={() => void commit()}>{t('Import reviewed bottles')}</button>
    </>}
  </details>;
}
