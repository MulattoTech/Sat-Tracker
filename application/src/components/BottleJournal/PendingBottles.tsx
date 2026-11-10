'use client';
import { useState } from 'react';
import { formatInTimeZone } from 'date-fns-tz';
import { useLocalization } from '@/src/context/localization';
import type { PendingBottle } from '@/src/lib/bottle-journal/outbox';

interface Props {
  rows: PendingBottle[]; timeZone: string; syncing: boolean; online: boolean;
  showMilkType?: boolean;
  onChange: (id: string, action: 'retry' | 'discard') => Promise<void>;
}
export default function PendingBottles({ rows, timeZone, syncing, online, onChange, showMilkType = false }: Props) {
  const { t } = useLocalization();
  const [discard, setDiscard] = useState<string | null>(null);
  if (!rows.length) return null;
  return <section className="journal-card journal-pending" aria-labelledby="journal-pending-title">
    <div className="journal-section-title"><h2 id="journal-pending-title">{t('Pending bottles on this browser')}</h2><span role="status">{t(syncing ? 'Syncing…' : rows.every(row => row.state === 'blocked') ? 'Needs review' : online ? 'Waiting to sync' : 'Offline')}</span></div>
    <p className="journal-muted">{t('These entries are stored on this browser only and are excluded from totals until confirmed by the server. Open this journal after reconnecting to sync. Clearing browser data removes unsent entries.')}</p>
    <ol>{rows.map(row => <li key={row.requestId} data-testid="pending-bottle">
      <div><strong>{row.bottle.amount} {row.bottle.unitAbbr}</strong><time dateTime={row.bottle.time}>{formatInTimeZone(row.bottle.time, timeZone, 'yyyy-MM-dd HH:mm')}</time>
        {showMilkType && <p>{t('Milk type')}: {t(row.bottle.bottleType === 'Formula/Breast' ? 'Formula and breast milk' : row.bottle.bottleType)}</p>}
        {row.bottle.notes && <p>{row.bottle.notes}</p>}
        <p className={row.state === 'blocked' ? 'journal-error' : 'journal-muted'}>{t(row.state === 'blocked'
          ? 'Needs review. Check saved history and your access before retrying. Conflicting values will never overwrite a saved bottle.'
          : 'Saved on this browser; not yet confirmed by the server.')}</p></div>
      <div className="journal-actions"><button type="button" disabled={syncing || !online} onClick={() => void onChange(row.requestId, 'retry')}>{t('Retry this entry')}</button>
        {discard === row.requestId ? <><span>{t('This may already be saved online. Discard only the local pending copy?')}</span><button type="button" disabled={syncing} onClick={() => { void onChange(row.requestId, 'discard'); setDiscard(null); }}>{t('Confirm discard')}</button><button type="button" onClick={() => setDiscard(null)}>{t('Cancel')}</button></>
          : <button type="button" disabled={syncing} onClick={() => setDiscard(row.requestId)}>{t('Discard pending entry')}</button>}</div>
    </li>)}</ol>
  </section>;
}
