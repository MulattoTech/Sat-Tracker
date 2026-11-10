'use client';

import type { PumpLogResponse } from '@/app/api/types';
import { Button } from '@/src/components/ui/button';
import { useLocalization } from '@/src/context/localization';
import { pumpActionLabel } from '@/src/utils/pumpAction';

interface Props {
  latest: PumpLogResponse | null;
  loading: boolean;
  error: string;
  reconciliationError?: string;
  onLoad: () => void;
  onReplace: () => void;
}

/** Fetching the winner never changes the draft or authorizes its stale values. */
export function PumpConflictReview({ latest, loading, error, reconciliationError, onLoad, onReplace }: Props) {
  const { t } = useLocalization();
  const missing = t('Not recorded');
  const fields = latest ? [
    [t('Start Time'), new Date(latest.startTime).toLocaleString()],
    [t('End Time'), latest.endTime ? new Date(latest.endTime).toLocaleString() : missing],
    [t('Duration'), latest.duration == null ? missing : `${latest.duration} ${t('min')}`],
    [t('Left Amount'), latest.leftAmount ?? missing],
    [t('Right Amount'), latest.rightAmount ?? missing],
    [t('Total Amount'), latest.totalAmount ?? missing],
    [t('Unit'), latest.unitAbbr ?? missing],
    [t('Action'), t(pumpActionLabel(latest.pumpAction))],
    [t('Notes'), latest.notes || missing],
  ] : [];

  return (
    <section aria-label={t('Pumping correction conflict')} className="mb-4 rounded-lg border border-amber-400 bg-amber-50 p-4 text-amber-950 pump-conflict-panel">
      <p role="alert" className="font-medium">{t(reconciliationError || 'This pumping record changed. Your changes were not saved.')}</p>
      <p className="mt-2 text-sm">{t('Your unsaved input is still below. Loading the latest record does not change it.')}</p>
      {reconciliationError && <p className="mt-2 text-sm">{t('Loading the latest pump does not resolve feeding ownership. Review the feeding history before reopening this correction.')}</p>}
      <Button type="button" variant="outline" className="mt-3" disabled={loading} onClick={onLoad}>
        {loading ? t('Loading...') : t('Load latest record')}
      </Button>
      {error && <p role="alert" className="mt-2 text-sm">{t(error)}</p>}
      {latest && (
        <div className="mt-4">
          <h3 className="font-medium">{t('Latest saved values')}</h3>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {fields.map(([label, value]) => (
              <div key={label} className="col-span-2 grid grid-cols-2 gap-x-4">
                <dt>{label}</dt>
                <dd className="min-w-0 whitespace-pre-wrap break-words">{value}</dd>
              </div>
            ))}
          </dl>
          {!reconciliationError && <>
            <p className="mt-3 text-sm">{t('Replacing your draft discards its unsaved values. You can then enter your correction using the latest record.')}</p>
            <Button type="button" variant="outline" className="mt-3" disabled={loading} onClick={onReplace}>
              {t('Replace draft with latest values')}
            </Button>
          </>}
        </div>
      )}
    </section>
  );
}
