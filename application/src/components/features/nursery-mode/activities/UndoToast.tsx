'use client';

import { ReactElement, useEffect } from 'react';
import { useLocalization } from '@/src/context/localization';
import { UndoInfo } from './types';

export interface UndoToastProps {
  undo: UndoInfo | null;
  onUndo: () => void;
  onDismiss: (undo: UndoInfo) => void;
  busy?: boolean;
  error?: string;
  retryable?: boolean;
  onReview?: () => void;
}

/**
 * Unattempted actions expire after six seconds. An in-flight or unconfirmed
 * Undo stays visible until it settles or the caregiver dismisses its review.
 */
export function UndoToast({ undo, onUndo, onDismiss, busy = false, error = '', retryable = false, onReview }: UndoToastProps): ReactElement | null {
  const { t } = useLocalization();

  useEffect(() => {
    if (!undo || busy || error) return;
    const timer = setTimeout(() => onDismiss(undo), 6000);
    return () => clearTimeout(timer);
  }, [undo, onDismiss, busy, error]);

  if (!undo) return null;

  return (
    <div
      className={`nursery-toast${error ? ' nursery-toast-review' : ''}`}
      role={error ? 'alert' : 'status'}
      aria-live="polite"
    >
      <span className="nursery-toast-copy">
        <span>{undo.message}</span>
        {error && <span className="nursery-toast-error">{t(error)}</span>}
      </span>
      <div className="nursery-toast-actions">
        {(!error || retryable) && (
          <button type="button" className="nursery-undo-control" onClick={onUndo} disabled={busy}>
            {t(busy ? 'Undoing…' : error ? 'Retry Undo' : 'Undo')}
          </button>
        )}
        {error && <>
          <button type="button" className="nursery-undo-control" onClick={onReview}>{t('Review care log')}</button>
          <button type="button" className="nursery-undo-control" onClick={() => onDismiss(undo)}>{t('Dismiss Undo review')}</button>
        </>}
      </div>
    </div>
  );
}
