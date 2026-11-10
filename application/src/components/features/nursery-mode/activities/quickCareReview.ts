import type { ActivityView } from './types';
import type { useQuickCareRecovery, QuickCareConfirmation } from './useQuickCareRecovery';

/** Shared presentation keeps the same recovery controls in Cards and Big Tiles. */
export function quickCareReview(recovery: ReturnType<typeof useQuickCareRecovery>,
  t: (text: string) => string, language: string, timezone: string,
  confirm: (value: QuickCareConfirmation | null) => void): Pick<ActivityView, 'statusText' | 'errorText' | 'buttons' | 'buttonsWrap' | 'showStatusInDialog' | 'wrapStatus'> {
  const intent = recovery.pending;
  let at = '';
  if (intent) {
    try { at = new Date(intent.time).toLocaleString(language || 'en-US', { timeZone: timezone || 'UTC' }); }
    catch { at = new Date(intent.time).toLocaleString('en-US', { timeZone: 'UTC' }); }
  }
  const labels = { WET: 'Wet', DIRTY: 'Dirty', BOTH: 'Both', DRY: 'Dry' };
  const detail = intent?.kind === 'food' ? intent.foodName : intent ? t(labels[intent.type]) : '';
  return {
    statusText: intent ? `${t('Saved care action')} · ${detail} · ${at}` : t('Care action needs review'),
    errorText: recovery.error ? t(recovery.error) : null,
    showStatusInDialog: true,
    wrapStatus: true,
    buttonsWrap: true,
    buttons: [
      ...(intent ? [{ key: 'retryQuickCare', label: t('Retry saved care action'),
        onClick: async () => confirm(await recovery.retry()), disabled: recovery.busy || !recovery.canRetry, emphasized: true, keepOpen: true }] : []),
      { key: 'reloadQuickCare', label: t('Reload saved action'), onClick: recovery.reload, disabled: recovery.busy, keepOpen: true },
      { key: 'reviewQuickCare', label: t('Review care log'), onClick: recovery.inspectCareLog, keepOpen: true },
      ...(intent ? [{ key: 'dismissQuickCare', label: t('Dismiss saved care action'), onClick: recovery.dismiss,
        disabled: recovery.busy || !recovery.canDismiss, keepOpen: true }] : []),
    ],
  };
}
