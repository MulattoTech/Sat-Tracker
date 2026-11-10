'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useLocalization } from '@/src/context/localization';
import { useBreastfeedSession } from './useBreastfeedSession';
import { formatFeedNote, FeedNoteLabels } from '@/src/utils/nursery/activityDetail';
import { ActivityHookArgs, ActivityView, ActionButton, formatMMSS } from './types';
import { useNurseryBottle } from './useNurseryBottle';
import { conditionalUndo } from './conditionalUndo';
import { useNurseryOwner } from './useNurseryOwner';

/**
 * Feed controls. Breastfeeding requests and first-stop recovery are owned by
 * useBreastfeedSession; this view presents its timer and explicit review actions.
 */
export function useFeedActions({ babyId, onLog, onUndoable }: ActivityHookArgs): ActivityView {
  const { t } = useLocalization();
  const owner = useNurseryOwner(babyId);
  const bottle = useNurseryBottle({ babyId, onLog, onUndoable });
  const [lastBreastSide, setLastBreastSide] = useState<'LEFT' | 'RIGHT' | ''>('');
  const currentBaby = useRef(babyId);
  currentBaby.current = babyId;
  const lastSideRequest = useRef(0);

  // "· Last used" hint — re-read after each completed breast feed so it points
  // at the side to use next, not the one from before this session's feeds.
  const refreshLastBreastSide = useCallback(async () => {
    const request = ++lastSideRequest.current;
    const authToken = localStorage.getItem('authToken');
    const headers = { Authorization: authToken ? `Bearer ${authToken}` : '' };

    try {
      const lastBreastRes = await fetch(`/api/feed-log/last?babyId=${babyId}&type=BREAST`, { headers, cache: 'no-store' });
      const lastBreastData = await lastBreastRes.json();
      if (request === lastSideRequest.current && currentBaby.current === babyId
        && localStorage.getItem('authToken') === authToken && lastBreastData.success && (lastBreastData.data?.side === 'LEFT' || lastBreastData.data?.side === 'RIGHT')) {
        setLastBreastSide(lastBreastData.data.side);
      }
    } catch { /* no last side available */ }
  }, [babyId]);

  // The breast-side hint remains independent of the bottle review form.
  useEffect(() => {
    setLastBreastSide('');
    if (babyId) void refreshLastBreastSide();
  }, [babyId, refreshLastBreastSide]);

  const feedNoteLabels: FeedNoteLabels = {
    breast: t('Breast'), bottle: t('Bottle'), formula: t('Formula'), pumpedBottle: t('Pumped Bottle'), food: t('Food'),
    left: t('Left'), right: t('Right'),
  };

  const breast = useBreastfeedSession(babyId, (intent, createdIds, undo) => {
    void refreshLastBreastSide();
    // Ending a zero-second session is valid and creates no feeding history.
    if (createdIds.length === 0) return;
    const note = formatFeedNote({
      type: 'BREAST',
      breastSides: [{ side: 'LEFT', seconds: intent.leftDuration }, { side: 'RIGHT', seconds: intent.rightDuration }],
    }, feedNoteLabels);
    onLog('feed', note, intent.stoppedAt);
    if (undo) onUndoable(conditionalUndo(undo, t('Feed logged'), owner.scopeNow));
  });
  const { phase, session: activeFeed, leftTotal, rightTotal } = breast;

  let statusText: string | null = null;
  let buttons: ActionButton[];

  if (phase === 'reviewing') {
    statusText = breast.hasStopIntent ? `${t('Stop review')} · L: ${formatMMSS(leftTotal)} R: ${formatMMSS(rightTotal)}` : t('Stop review');
    buttons = [
      { key: 'retryStop', label: t('Retry stopped feed'), onClick: breast.stop, emphasized: true, disabled: breast.busy || !breast.canRetry, keepOpen: true },
      { key: 'reload', label: t('Reload current session'), onClick: breast.loadCurrent, disabled: breast.busy, keepOpen: true },
      { key: 'inspect', label: t('Review care log'), onClick: breast.inspectCareLog, keepOpen: true },
      { key: 'dismiss', label: activeFeed ? t('Discard stop and use current timer') : t('Dismiss stop review'),
        onClick: breast.dismissReview, disabled: breast.busy || !breast.canDismiss, keepOpen: true },
    ];
  } else if (phase === 'paused' && activeFeed) {
    statusText = `${t('Paused')} · L: ${formatMMSS(leftTotal)} R: ${formatMMSS(rightTotal)}`;
    buttons = [
      { key: 'resumeLeft', label: t('Resume Left'), onClick: () => breast.change('resume', 'LEFT'), disabled: breast.busy, keepOpen: true },
      { key: 'resumeRight', label: t('Resume Right'), onClick: () => breast.change('resume', 'RIGHT'), disabled: breast.busy, keepOpen: true },
      { key: 'stop', label: t('Stop'), onClick: breast.stop, emphasized: true, disabled: breast.busy, keepOpen: true },
    ];
  } else if (phase === 'feeding' && activeFeed) {
    const sideLabel = activeFeed.activeSide === 'LEFT' ? t('Left Side') : t('Right Side');
    const activeSideTotal = activeFeed.activeSide === 'LEFT' ? leftTotal : rightTotal;
    statusText = `${sideLabel}: ${formatMMSS(activeSideTotal)}`;
    buttons = [
      { key: 'switch', label: t('Switch'), onClick: () => breast.change('switch'), disabled: breast.busy, keepOpen: true },
      { key: 'pause', label: t('Pause'), onClick: () => breast.change('pause'), disabled: breast.busy, keepOpen: true },
      { key: 'stop', label: t('Stop'), onClick: breast.stop, emphasized: true, disabled: breast.busy, keepOpen: true },
    ];
  } else {
    buttons = [
      { key: 'bottle', label: t('Bottle'), onClick: bottle.open, disabled: breast.busy || !bottle.available },
      {
        key: 'breastL',
        label: lastBreastSide === 'LEFT' ? `${t('Left Breast')} · ${t('Last used')}` : t('Left Breast'),
        onClick: () => breast.start('LEFT'),
        disabled: breast.busy || !breast.loaded, keepOpen: true,
      },
      {
        key: 'breastR',
        label: lastBreastSide === 'RIGHT' ? `${t('Right Breast')} · ${t('Last used')}` : t('Right Breast'),
        onClick: () => breast.start('RIGHT'),
        disabled: breast.busy || !breast.loaded, keepOpen: true,
      },
    ];
  }

  if (phase !== 'reviewing' && breast.error) buttons.push(
    { key: 'reload', label: t('Reload current session'), onClick: breast.loadCurrent, disabled: breast.busy, keepOpen: true },
    { key: 'inspect', label: t('Review care log'), onClick: breast.inspectCareLog, keepOpen: true },
  );

  if (phase !== 'idle' && bottle.needsReview) {
    buttons.push({ key: 'pendingBottles', label: t('Pending bottles on this browser'), onClick: bottle.open, disabled: !bottle.available });
  }

  return {
    id: 'feed',
    icon: 'bottle',
    label: t('Feed'),
    statusText: statusText || (bottle.pending ? t('Pending bottles on this browser') : null),
    active: phase !== 'idle',
    question: phase === 'reviewing',
    showStatusInDialog: phase === 'reviewing',
    errorText: breast.error ? t(breast.error) : phase === 'reviewing'
      ? t('Your first stop time is kept. Reload to inspect the current session. Using the current timer discards this stop time.') : null,
    buttonsWrap: phase === 'reviewing' || Boolean(breast.error) || (phase !== 'idle' && bottle.needsReview),
    overlay: bottle.overlay,
    buttons,
  };
}
