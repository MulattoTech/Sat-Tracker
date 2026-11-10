'use client';

import { Button } from '@/src/components/ui/button';
import { useLocalization } from '@/src/context/localization';
import { useTimezone } from '@/app/context/timezone';
import type { SavedMedicineDose } from '@/src/utils/medicine-dose-request';

export function MedicineDoseRecovery({ snapshot, busy, blocked, familySlug, onRetry, onDismiss }: {
  snapshot: SavedMedicineDose; busy: boolean; blocked: boolean; familySlug?: string;
  onRetry: () => void; onDismiss: () => void;
}) {
  const { t } = useLocalization();
  const { formatDateTime } = useTimezone();
  const request = snapshot.request;
  return (
    <section aria-label={t('Dose awaiting confirmation')} className="space-y-4">
      <h3 className="font-semibold">{t('Dose awaiting confirmation')}</h3>
      <p className="text-sm">{t('Saving this dose could not be confirmed. Its original details are kept. Retry the saved request.')}</p>
      <dl className="space-y-3 break-words">
        <div><dt className="font-medium">{snapshot.isSupplement ? t('Supplement') : t('Medicine')}</dt><dd>{snapshot.medicineName}</dd></div>
        <div><dt className="font-medium">{t('Time')}</dt><dd>{formatDateTime(request.time)}</dd></div>
        <div><dt className="font-medium">{t('Dose')}</dt><dd>{request.doseAmount} {request.unitAbbr}</dd></div>
        {request.notes && <div><dt className="font-medium">{t('Notes')}</dt><dd className="whitespace-pre-wrap">{request.notes}</dd></div>}
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy || blocked} onClick={onRetry}>{busy ? t('Saving...') : t('Retry saved dose')}</Button>
        {familySlug && <Button type="button" variant="outline" onClick={() => window.location.assign(
          `/${encodeURIComponent(familySlug)}/full-log?babyId=${encodeURIComponent(request.babyId)}`
        )}>{t('Review care log')}</Button>}
        <Button type="button" variant="outline" disabled={busy || blocked} onClick={onDismiss}>{t('Dismiss saved dose')}</Button>
      </div>
    </section>
  );
}
