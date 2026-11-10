'use client';
import { FormEvent, useEffect, useState } from 'react';
import { formatInTimeZone } from 'date-fns-tz';
import { useLocalization } from '@/src/context/localization';
import { localTimeToInstant } from '@/src/lib/bottle-journal/validation';
import { convertVolume, normalizeVolumeUnit } from '@/src/utils/unit-conversion';
import type { BottlePayload, BottleRow } from './types';

interface Props { timeZone: string; saving: boolean; initial?: BottleRow; initialUnit?: 'ML' | 'OZ'; requireMilkChoice?: boolean; showCancel?: boolean; onSaved?: () => void; onSave: (bottle: BottlePayload, id: string, editing?: BottleRow) => Promise<boolean>; onCancel: () => void }
export default function BottleForm({ timeZone, saving, initial, initialUnit = 'ML', requireMilkChoice = false, showCancel = false, onSaved, onSave, onCancel }: Props) {
  const { t } = useLocalization();
  const [localTime, setLocalTime] = useState(() => formatInTimeZone(initial?.time || new Date(), timeZone, "yyyy-MM-dd'T'HH:mm"));
  const [unit, setUnit] = useState(initial ? normalizeVolumeUnit(initial.unitAbbr) || initial.unitAbbr || 'OZ' : initialUnit);
  const [followNow, setFollowNow] = useState(!initial), [retryTime, setRetryTime] = useState<string | null>(null);
  const [amount, setAmount] = useState(initial?.amount == null ? '' : String(initial.amount));
  const [offered, setOffered] = useState(initial?.offeredAmount == null ? '' : String(initial.offeredAmount));
  const [milk, setMilk] = useState(initial?.bottleType || (requireMilkChoice ? '' : 'Formula'));
  const [kcal, setKcal] = useState(initial?.formulaKcalOz == null ? '' : String(initial.formulaKcalOz));
  const [formula, setFormula] = useState(initial?.formulaName || ''), [label, setLabel] = useState(initial?.bottleLabel || '');
  const [notes, setNotes] = useState(initial?.notes || ''), [error, setError] = useState('');
  const [exactTime, setExactTime] = useState('');
  const [requestId, setRequestId] = useState<string | null>(initial?.id || null);
  useEffect(() => {
    if (!followNow || saving || retryTime) return;
    const timer = setInterval(() => setLocalTime(formatInTimeZone(new Date(), timeZone, "yyyy-MM-dd'T'HH:mm")), 30_000);
    return () => clearInterval(timer);
  }, [followNow, saving, retryTime, timeZone]);
  function changeUnit(next: string) {
    if (amount !== '') setAmount(String(Math.round(convertVolume(Number(amount), unit, next) * 100) / 100));
    if (offered !== '') setOffered(String(Math.round(convertVolume(Number(offered), unit, next) * 100) / 100));
    setUnit(next);
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    try {
      const time = retryTime || exactTime || (followNow ? new Date().toISOString() : initial && localTime === formatInTimeZone(initial.time, timeZone, "yyyy-MM-dd'T'HH:mm") ? initial.time : localTimeToInstant(localTime, timeZone));
      // Keep the exact first-attempt time on network retries with the same request ID.
      setRetryTime(time); setFollowNow(false); setLocalTime(formatInTimeZone(time, timeZone, "yyyy-MM-dd'T'HH:mm"));
      const id = requestId || crypto.randomUUID(); setRequestId(id);
      const saved = await onSave({ time, amount: amount === '' ? null : Number(amount), offeredAmount: offered === '' ? null : Number(offered),
        unitAbbr: unit, bottleType: milk, formulaKcalOz: kcal === '' ? null : Number(kcal), formulaName: formula || null,
        bottleLabel: label || null, notes: notes || null, sourceCaregiverName: initial?.sourceCaregiverName || null }, id, initial);
      if (saved) { setRequestId(null); setRetryTime(null); setFollowNow(true); setAmount(''); setOffered(''); setNotes(''); setLabel(''); setExactTime(''); if (requireMilkChoice) setMilk(''); setLocalTime(formatInTimeZone(new Date(), timeZone, "yyyy-MM-dd'T'HH:mm")); (onSaved || onCancel)(); }
    } catch (error) { setError(error instanceof Error ? error.message : 'Check this bottle before saving.'); }
  }
  return <form className="journal-card journal-form" onSubmit={submit} aria-label={t(initial ? 'Edit bottle' : 'Add bottle')}>
    <div className="journal-section-title"><h2>{t(initial ? 'Edit bottle' : 'Add bottle')}</h2><span>{timeZone}</span></div>
    {error && <p className="journal-error" role="alert">{t(error)}</p>}
    <div className="journal-fields">
      <label>{t('Feeding date and time')}<input type="datetime-local" value={localTime} onChange={e => { setLocalTime(e.target.value); setFollowNow(false); setRetryTime(null); setExactTime(''); }} required disabled={saving} /></label>
      <label>{t('Milk type')}<select aria-label={t('Milk type')} value={milk} onChange={e => setMilk(e.target.value)} disabled={saving} required={requireMilkChoice}>
        {requireMilkChoice && <option value="" disabled>{t('Choose a milk type.')}</option>}
        <option value="Formula">{t('Formula')}</option><option value="Breast Milk">{t('Breast Milk')}</option><option value="Formula/Breast">{t('Formula and breast milk')}</option><option value="Other">{t('Other')}</option>
      </select></label>
      <label>{t('Consumed')}<div className="journal-volume"><input type="number" inputMode="decimal" min="0" step="any" required value={amount} onChange={e => setAmount(e.target.value)} disabled={saving} />
        <select aria-label={t('Volume unit')} value={unit} onChange={e => changeUnit(e.target.value)} disabled={saving}><option value="ML">mL</option><option value="OZ">oz</option></select></div></label>
      <label>{t('Offered (optional)')}<div className="journal-volume"><input type="number" inputMode="decimal" min="0" step="any" value={offered} onChange={e => setOffered(e.target.value)} disabled={saving} /><span>{unit === 'ML' ? 'mL' : 'oz'}</span></div></label>
    </div>
    {!initial && <label className="journal-check"><input type="checkbox" checked={followNow} disabled={saving} onChange={e => { setFollowNow(e.target.checked); setRetryTime(null); setExactTime(''); if (e.target.checked) setLocalTime(formatInTimeZone(new Date(), timeZone, "yyyy-MM-dd'T'HH:mm")); }} />{t('Use current time until saved')}</label>}
    <div className="journal-presets" aria-label={t('Quick consumed volumes')}>
      {[30, 60, 90, 120].map(ml => <button key={ml} type="button" disabled={saving} onClick={() => { setUnit('ML'); if (offered) setOffered(String(Math.round(convertVolume(Number(offered), unit, 'ML') * 10) / 10)); setAmount(String(ml)); }}>{ml} mL</button>)}
    </div>
    <details open={Boolean(initial?.formulaName || initial?.bottleLabel || initial?.notes)}><summary>{t('Notes and bottle details')}</summary>
      <div className="journal-fields">
        <label>{t('Formula name (optional)')}<input value={formula} maxLength={120} onChange={e => setFormula(e.target.value)} disabled={saving} /></label>
        <label>{t('Concentration (kcal/oz, optional)')}<input type="number" inputMode="decimal" step="any" min="0.1" max="60" value={kcal} onChange={e => setKcal(e.target.value)} disabled={saving} /></label>
        <label>{t('Bottle label (optional)')}<input value={label} maxLength={80} onChange={e => setLabel(e.target.value)} disabled={saving} /></label>
        <label>{t('Exact time with UTC offset (optional)')}<input value={exactTime} maxLength={40} placeholder="2026-11-01T01:30:00-06:00" onChange={e => { setExactTime(e.target.value); setFollowNow(false); setRetryTime(null); }} disabled={saving} /></label>
      </div>
      <label>{t('Notes')}<textarea aria-label={t('Notes')} value={notes} maxLength={2000} onChange={e => setNotes(e.target.value)} disabled={saving} /></label>
    </details>
    <div className="journal-actions"><button className="journal-primary" disabled={saving} type="submit">{t(saving ? 'Saving…' : initial ? 'Save changes' : 'Save bottle')}</button>
      {(initial || showCancel) && <button type="button" disabled={saving} onClick={onCancel}>{t('Cancel')}</button>}</div>
    <p className="journal-muted">{t(initial ? 'Wait for Bottle saved before closing. If the connection drops, keep this form open and retry.' : 'New bottles can wait on this browser while offline. Wait for a saved or pending confirmation before closing. Historical edits require a connection.')}</p>
  </form>;
}
