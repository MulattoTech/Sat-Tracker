'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useBaby } from '@/app/context/baby';
import { useTimezone } from '@/app/context/timezone';
import { useFamily } from '@/src/context/family';
import { useLocalization } from '@/src/context/localization';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/src/components/ui/dialog';
import BottleForm from '@/src/components/BottleJournal/BottleForm';
import PendingBottles from '@/src/components/BottleJournal/PendingBottles';
import { useJournalOutbox } from '@/src/components/BottleJournal/useJournalOutbox';
import type { BottlePayload } from '@/src/components/BottleJournal/types';
import { journalScopeFromToken } from '@/src/lib/bottle-journal/outbox-identity';
import { cacheDefaultBottleUnit, readCachedDefaultBottleUnit, type BottleUnit } from '@/src/utils/defaultBottleUnit';
import { formatFeedNote } from '@/src/utils/nursery/activityDetail';
import { type ActivityHookArgs } from './types';
import { conditionalUndo } from './conditionalUndo';
import '@/src/components/BottleJournal/bottle-journal.css';
import './nursery-bottle.css';

interface OpenBottle { scope: string; unit: BottleUnit; id: string }

/** Nursery uses the journal's existing immutable outbox, not a second queue.
 * No history-derived quantity or milk type is ever submitted by opening it. */
export function useNurseryBottle({ babyId, onLog, onUndoable }: Pick<ActivityHookArgs, 'babyId' | 'onLog' | 'onUndoable'>) {
  const { t } = useLocalization();
  const { selectedBaby } = useBaby();
  const { family, authenticatedFetch } = useFamily();
  const { userTimezone } = useTimezone();
  const [defaultUnit, setDefaultUnit] = useState<BottleUnit>(() => readCachedDefaultBottleUnit());
  const [dialog, setDialog] = useState<OpenBottle | null>(null);
  const [entryComplete, setEntryComplete] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const readScope = useCallback(() => {
    try { return journalScopeFromToken(localStorage.getItem('authToken'), family?.id, babyId); }
    catch { return null; }
  }, [family?.id, babyId]);
  const currentScope = useRef(readScope); currentScope.current = readScope;

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const scope = readScope();
      if (!scope) return;
      try {
        const response = await authenticatedFetch('/api/settings', { cache: 'no-store' });
        const result = await response.json();
        if (!active || currentScope.current() !== scope || !response.ok || !result.success) return;
        const unit = cacheDefaultBottleUnit(result.data?.defaultBottleUnit);
        if (unit) setDefaultUnit(unit);
      } catch { /* The visible unit is captured when the caregiver opens the form. */ }
    };
    const foreground = () => { if (document.visibilityState === 'visible') void refresh(); };
    void refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', foreground);
    return () => { active = false; window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', foreground); };
  }, [readScope, authenticatedFetch]);

  const outbox = useJournalOutbox(babyId, (row, undo) => {
    if (row.scope !== currentScope.current()) return;
    setNotice('Bottle saved.');
    onLog('feed', formatFeedNote({ type: 'BOTTLE', amount: row.bottle.amount,
      unitAbbr: row.bottle.unitAbbr }, {
      breast: t('Breast'), bottle: t('Bottle'), formula: t('Formula'), pumpedBottle: t('Pumped Bottle'), food: t('Food'),
      left: t('Left'), right: t('Right'),
    }), row.bottle.time);
    if (undo) onUndoable(conditionalUndo(undo, t('Bottle logged'), () => currentScope.current()));
  });

  const open = () => {
    const scope = readScope();
    if (!scope || savingRef.current) return;
    setDialog({ scope, unit: defaultUnit, id: crypto.randomUUID() });
    setError(''); setNotice(''); setEntryComplete(false);
  };
  const save = async (bottle: BottlePayload, requestId: string) => {
    const scope = dialog?.scope;
    if (savingRef.current || !scope || scope !== readScope()) {
      setError('The signed-in caregiver or child changed. Review this pending bottle after signing in again.'); return false;
    }
    savingRef.current = true; setSaving(true); setError(''); setNotice('');
    try {
      const result = await outbox.enqueue(bottle, requestId);
      if (scope === currentScope.current()) {
        setNotice(result === 'saved' ? 'Bottle saved.' : 'Bottle saved on this browser. Waiting for server confirmation.');
      }
      return true;
    } catch (failure) {
      if (scope === currentScope.current()) setError(failure instanceof Error ? failure.message : 'The bottle was not confirmed saved. Keep the form open and retry.');
      return false;
    } finally { savingRef.current = false; setSaving(false); }
  };

  const scope = readScope();
  const visible = Boolean(dialog && dialog.scope === scope);
  const overlay = <Dialog open={visible} onOpenChange={next => { if (!next && !savingRef.current) setDialog(null); }}>
    <DialogContent className="nursery-bottle-dialog" hideClose={saving} onInteractOutside={event => { if (savingRef.current) event.preventDefault(); }}>
      <DialogHeader>
        <DialogTitle>{t('Add bottle')}</DialogTitle>
        {selectedBaby?.id === babyId && <p className="nursery-bottle-child">{selectedBaby.firstName}</p>}
        <DialogDescription>{t('Enter the amount you observed, choose the milk type, and check the unit before saving.')}</DialogDescription>
      </DialogHeader>
      <div className="bottle-journal">
        {error && <p className="journal-error" role="alert">{t(error)}</p>}
        {outbox.error && <p className="journal-error" role="alert">{t(outbox.error)}</p>}
        {notice && <p className="journal-notice" role="status">{t(notice)}</p>}
        <PendingBottles rows={outbox.rows} timeZone={userTimezone || 'UTC'} syncing={outbox.syncing} online={outbox.online} onChange={outbox.change} showMilkType />
        {entryComplete ? <button type="button" className="journal-primary" onClick={open}>{t('Add bottle')}</button>
          : <BottleForm key={dialog?.id} timeZone={userTimezone || 'UTC'} initialUnit={dialog?.unit} requireMilkChoice showCancel
            saving={saving} onSave={save} onCancel={() => setDialog(null)} onSaved={() => setEntryComplete(true)} />}
        {family && <Link className="journal-text-link" href={`/${encodeURIComponent(family.slug)}/bottle-journal`}>{t('Bottle Journal')}</Link>}
      </div>
    </DialogContent>
  </Dialog>;
  return { open, overlay, pending: outbox.rows.length > 0, needsReview: outbox.rows.length > 0 || Boolean(outbox.error), available: Boolean(scope) };
}
