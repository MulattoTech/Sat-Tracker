'use client';

import { useEffect, useState } from 'react';
import { useTimezone } from '@/app/context/timezone';
import { useLocalization } from '@/src/context/localization';
import { localizeSleepLocation } from '@/src/utils/sleepLocationUtils';
import { ActivityHookArgs, ActivityView, ActionButton, formatHMMSS } from './types';
import { useSleepSession, type SleepConfirmation } from './useSleepSession';

const DEFAULT_LOCATIONS = ['Crib', 'Contact'];

/** Presents explicit sleep-state checks and recoverable nursery actions. The
 * session hook owns immutable first times, server revisions and request scope. */
export function useSleepActions({ babyId, onLog, onUndoable, onUndoConfirmed, sleepLocations }: ActivityHookArgs): ActivityView {
  const { t, language } = useLocalization();
  const { userTimezone } = useTimezone();
  const sleep = useSleepSession(babyId);
  const [selecting, setSelecting] = useState(false);
  useEffect(() => setSelecting(false), [sleep.scope]);
  const locations = sleepLocations?.length ? sleepLocations : DEFAULT_LOCATIONS;

  function announce(confirmed: SleepConfirmation | null) {
    if (!confirmed) return;
    const { intent, row } = confirmed;
    if (intent.kind === 'undo-start' || intent.kind === 'undo-wake') { onUndoConfirmed?.('sleep'); return; }
    if (!row) return;
    if (intent.kind === 'start') {
      onLog('sleep', `${t('Start Sleep')} — ${localizeSleepLocation(intent.location, t)}`, intent.startTime);
      onUndoable({ tileId: 'sleep', message: t('Sleep started'),
        undo: async () => Boolean(await sleep.undo(row, 'undo-start', intent.scope)) });
    } else {
      const seconds = Math.max(0, Math.floor((Date.parse(intent.endTime!) - Date.parse(intent.startTime)) / 1000));
      onLog('sleep', `${t('Wake Up')} — ${formatHMMSS(seconds)}`, intent.endTime);
      onUndoable({ tileId: 'sleep', message: t('Sleep logged'),
        undo: async () => Boolean(await sleep.undo(row, 'undo-wake', intent.scope)) });
    }
  }

  const reload: ActionButton = { key: 'reloadSleep', label: t('Reload sleep state'), onClick: sleep.loadCurrent, disabled: sleep.busy, keepOpen: true };
  const inspect: ActionButton = { key: 'reviewSleep', label: t('Review care log'), onClick: sleep.inspectCareLog, keepOpen: true };
  let statusText: string | null = null, buttons: ActionButton[];
  const reviewing = Boolean(sleep.pending || sleep.storageBlocked || sleep.ambiguous);
  if (reviewing) {
    const intent = sleep.pending;
    let startLabel = '';
    if (intent?.kind === 'start') {
      const date = new Date(intent.startTime);
      try { startLabel = date.toLocaleString(language || 'en-US', { timeZone: userTimezone || 'UTC' }); }
      catch { startLabel = date.toLocaleString('en-US', { timeZone: 'UTC' }); }
    }
    statusText = intent?.kind === 'wake'
      ? `${t('Sleep wake review')} · ${formatHMMSS(Math.max(0, Math.floor((Date.parse(intent.endTime!) - Date.parse(intent.startTime)) / 1000)))}`
      : intent?.kind === 'start'
        ? `${t('Sleep start review')} · ${startLabel}`
        : intent ? t('Sleep undo review') : t('Sleep state needs review');
    buttons = [
      ...(intent ? [{ key: 'retrySleep', label: t('Retry saved sleep action'), onClick: async () => announce(await sleep.retry()),
        emphasized: true, disabled: sleep.busy || !sleep.canRetry, keepOpen: true }] : []),
      reload, inspect,
      ...(intent ? [{ key: 'dismissSleep', label: sleep.active ? t('Discard action and use current sleep state') : t('Dismiss sleep review'),
        onClick: sleep.dismissReview, disabled: sleep.busy || !sleep.canDismiss, keepOpen: true }] : []),
    ];
  } else if (!sleep.loaded) {
    statusText = sleep.busy ? t('Checking sleep state') : t('Sleep state needs review');
    buttons = [reload, inspect];
  } else if (sleep.active) {
    statusText = `${t('Sleeping')}: ${formatHMMSS(sleep.elapsed)}`;
    buttons = [
      { key: 'wake', label: t('Wake Up'), onClick: async () => announce(await sleep.wake()), emphasized: true, disabled: sleep.busy, wide: true, keepOpen: true },
      reload,
    ];
  } else if (selecting) {
    statusText = t('Select Location');
    buttons = [
      ...locations.map(location => ({ key: location, label: localizeSleepLocation(location, t), disabled: sleep.busy, keepOpen: true,
        onClick: async () => { setSelecting(false); announce(await sleep.start(location)); } })),
      { key: 'cancel', label: t('Cancel'), onClick: () => setSelecting(false), cancel: true, keepOpen: true },
    ];
  } else {
    buttons = [{ key: 'startSleep', label: t('Start Sleep'), onClick: () => setSelecting(true), disabled: sleep.busy, wide: true, keepOpen: true }];
  }
  return { id: 'sleep', icon: 'moon', label: t('Sleep'), statusText, showStatusInDialog: true,
    errorText: sleep.error ? t(sleep.error) : null, active: Boolean(sleep.active || sleep.pending),
    question: selecting && !reviewing && sleep.loaded && !sleep.active, buttonsWrap: selecting || reviewing, buttons };
}
