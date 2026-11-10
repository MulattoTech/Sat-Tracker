'use client';

import { useLocalization } from '@/src/context/localization';
import { useTimezone } from '@/app/context/timezone';
import { ActivityHookArgs, ActivityView } from './types';
import { useNurseryOwner } from './useNurseryOwner';
import { conditionalUndo } from './conditionalUndo';
import { useQuickCareRecovery, type QuickCareConfirmation } from './useQuickCareRecovery';
import { quickCareReview } from './quickCareReview';

/**
 * Quick diaper actions retain their first intent until the save is confirmed.
 * Undo still claims the original server-issued full row revision.
 */
export function useDiaperActions({ babyId, toUTCString, onLog, onUndoable }: ActivityHookArgs): ActivityView {
  const { t, language } = useLocalization(), { userTimezone } = useTimezone();
  const owner = useNurseryOwner(babyId), recovery = useQuickCareRecovery('diaper', babyId, owner);
  function announce(saved: QuickCareConfirmation | null) {
    if (!saved || saved.intent.kind !== 'diaper' || !owner.isCurrent(saved.owner)) return;
    const labels = { WET: 'Wet', DIRTY: 'Dirty', BOTH: 'Both', DRY: 'Dry' };
    const messages = { WET: 'Wet diaper logged', DIRTY: 'Dirty diaper logged', BOTH: 'Diaper logged', DRY: 'Dry diaper logged' };
    onLog('diaper', t(labels[saved.intent.type]), saved.time);
    onUndoable(conditionalUndo(saved.undo, t(messages[saved.intent.type]), owner.scopeNow, () => owner.isCurrent(saved.owner)));
  }
  const submitDiaper = async (type: string) => announce(await recovery.create({ type, time: toUTCString(new Date()) }));

  return {
    id: 'diaper',
    icon: 'diaper',
    label: t('Diaper'),
    statusText: null,
    active: false,
    question: false,
    // Four buttons (Wet/Dirty/Both/Dry) no longer fit one nowrap row at narrow widths
    // in longer-label locales (e.g. Italian, Dutch); wrap instead of silently
    // overflowing past the card with no scroll affordance.
    buttonsWrap: true,
    buttons: [
      { key: 'wet', label: t('Wet'), onClick: () => submitDiaper('WET'), disabled: recovery.busy, keepOpen: true },
      { key: 'dirty', label: t('Dirty'), onClick: () => submitDiaper('DIRTY'), disabled: recovery.busy, keepOpen: true },
      { key: 'both', label: t('Both'), onClick: () => submitDiaper('BOTH'), disabled: recovery.busy, keepOpen: true },
      { key: 'dry', label: t('Dry'), onClick: () => submitDiaper('DRY'), disabled: recovery.busy, keepOpen: true },
    ],
    ...(recovery.reviewing ? quickCareReview(recovery, t, language, userTimezone, announce) : {}),
  };
}
