'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatInTimeZone } from 'date-fns-tz';
import { Baby, FileScan, RefreshCw, MoonStar } from 'lucide-react';
import { useBaby } from '@/app/context/baby';
import { useTimezone } from '@/app/context/timezone';
import { useFamily } from '@/src/context/family';
import { useLocalization } from '@/src/context/localization';
import { useBottleJournal } from './useBottleJournal';
import BottleForm from './BottleForm';
import LegacyImport from './LegacyImport';
import PendingBottles from './PendingBottles';
import type { BottleRow } from './types';
import './bottle-journal.css';

export default function BottleJournal() {
  const { selectedBaby } = useBaby(), { userTimezone } = useTimezone(), { family } = useFamily(), { t } = useLocalization();
  const zone = userTimezone || 'UTC';
  const [day, setDay] = useState(() => formatInTimeZone(new Date(), zone, 'yyyy-MM-dd'));
  const [editing, setEditing] = useState<BottleRow | undefined>(), [target, setTarget] = useState('');
  const state = useBottleJournal(selectedBaby?.id, day, zone);
  useEffect(() => { setDay(formatInTimeZone(new Date(), zone, 'yyyy-MM-dd')); }, [zone]);
  useEffect(() => { setEditing(undefined); }, [selectedBaby?.id]);
  useEffect(() => { setTarget(state.data?.targetMl == null ? '' : String(state.data.targetMl)); }, [state.data?.targetMl]);
  const totals = state.data?.totals;
  return <section className="bottle-journal" aria-labelledby="bottle-journal-title">
    <header className="journal-hero"><div><span className="journal-eyebrow"><MoonStar size={17} aria-hidden="true" />{t('Sat Tracker · Family care journal')}</span>
      <h1 id="bottle-journal-title">{t('Bottle Journal')}</h1><p>{t('Every bottle, together. Paper logs and everyday entries share one history.')}</p></div>
      {family && <Link className="journal-link" href={`/${family.slug}/ocr-import`}><FileScan size={19} aria-hidden="true" />{t('Scan a feeding log')}</Link>}
    </header>
    {!selectedBaby ? <div className="journal-card"><Baby aria-hidden="true" /><h2>{t('Choose a child first')}</h2><p>{t('Use the child selector above to choose whose care records you want to view.')}</p></div> : <>
      <div className="journal-toolbar"><label>{t('Journal date')}<input type="date" value={day} onChange={e => { if (e.target.value) setDay(e.target.value); }} /></label>
        <div><button type="button" onClick={() => { void state.refresh(true); void state.outbox.sync(); }} disabled={state.refreshing}><RefreshCw size={16} aria-hidden="true" />{t(state.refreshing ? 'Refreshing…' : 'Sync now')}</button>
          <p className="journal-muted" role="status">{state.lastSynced ? `${t('Last synced')} ${formatInTimeZone(state.lastSynced, zone, 'HH:mm:ss')}` : t('Waiting for a confirmed connection')}</p></div>
      </div>
      {state.error && <p className="journal-error" role="alert">{t(state.error)}</p>}
      {state.notice && <p className="journal-notice" role="status">{t(state.notice)}</p>}
      {state.outbox.error && <p className="journal-error" role="alert">{t(state.outbox.error)}</p>}
      <PendingBottles rows={state.outbox.rows} timeZone={zone} syncing={state.outbox.syncing} online={state.outbox.online} onChange={state.outbox.change} />
      <div className="journal-stats" aria-label={t('Bottle totals')}>
        <article className="journal-card"><span>{t('Selected day')}</span><strong data-testid="journal-daily-total">{totals ? `${totals.dailyMl} mL` : '—'}</strong><small>{totals?.dailyCount ?? '—'} {t('bottles')}</small></article>
        <article className="journal-card"><span>{t('Last 24 hours')}</span><strong data-testid="journal-rolling-total">{totals ? `${totals.rollingMl} mL` : '—'}</strong><small>{t('Rolling total through now')}</small></article>
        <article className="journal-card"><span>{t('Daily tracking target')}</span><strong>{totals?.targetMl == null ? t('Not set') : `${totals.targetMl} mL`}</strong>
          {totals?.progress != null ? <><progress aria-label={t('Daily target progress')} max={100} value={Math.min(100, totals.progress)} /><small>{totals.progress}% · {totals.remainingMl} mL {t('remaining')}</small></> : <small>{t('Enter the target agreed with your care team')}</small>}</article>
      </div>
      {Boolean(totals?.unknownVolumes) && <p className="journal-warning">{t('Some bottles have no measurable volume. Their amounts are excluded from totals.')}</p>}
      <div className="journal-main">
        <BottleForm key={`${selectedBaby.id}:${editing?.id || 'new'}`} initial={editing} timeZone={zone} saving={state.saving} onSave={state.save} onCancel={() => setEditing(undefined)} />
        <section className="journal-card journal-history" aria-labelledby="journal-history-title"><div className="journal-section-title"><h2 id="journal-history-title">{t('Bottle history')}</h2><span>{selectedBaby.firstName}</span></div>
          {!state.data ? <p>{t('Loading journal…')}</p> : state.data.rows.length === 0 ? <p>{t('No bottles on this date yet. Add a bottle or import a feeding log.')}</p> : <ol>
            {state.data.rows.map(row => <li key={row.id}><div className="journal-history-time"><time dateTime={row.time}>{formatInTimeZone(row.time, zone, 'HH:mm')}</time><span>{row.caretakerName || t('Caregiver not recorded')}</span></div>
              <div className="journal-history-entry"><strong>{row.amount ?? '—'} {row.unitAbbr || 'OZ'}</strong><span>{t(row.bottleType || 'Bottle')}{row.offeredAmount != null ? ` · ${t('Offered')} ${row.offeredAmount} ${row.unitAbbr || 'OZ'}` : ''}</span>
                {(row.formulaName || row.formulaKcalOz || row.bottleLabel) && <small>{[row.formulaName, row.formulaKcalOz ? `${row.formulaKcalOz} kcal/oz` : '', row.bottleLabel].filter(Boolean).join(' · ')}</small>}
                {row.notes && <p>{row.notes}</p>}</div>
              <button type="button" disabled={state.saving} onClick={() => { setEditing(row); document.querySelector('.journal-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} aria-label={`${t('Edit bottle')} ${formatInTimeZone(row.time, zone, 'HH:mm')}`}>{t('Edit')}</button></li>)}
          </ol>}
          {family && <Link className="journal-text-link" href={`/${family.slug}/full-log`}>{t('View the shared activity timeline')}</Link>}
        </section>
      </div>
      {state.data?.canManage && <><details className="journal-card"><summary>{t('Intake target')}</summary><p>{t('This is a tracking goal you choose, not a feeding limit or a medical recommendation.')}</p>
        <form className="journal-target" onSubmit={event => { event.preventDefault(); void state.setTarget(target === '' ? null : Number(target)); }}><label>{t('Daily target (mL)')}<input type="number" inputMode="decimal" min="1" max="10000" step="any" value={target} onChange={e => setTarget(e.target.value)} placeholder={t('Optional')} disabled={state.saving} /></label><button type="submit" disabled={state.saving}>{t('Save target')}</button></form></details>
        <LegacyImport key={selectedBaby.id} babyId={selectedBaby.id} timeZone={zone} request={state.request} onImported={() => void state.refresh(true)} /></>}
      <p className="journal-muted">{t('The journal refreshes while this page is open. OCR imports, bottles and the timeline use the same family records.')}</p>
    </>}
  </section>;
}
