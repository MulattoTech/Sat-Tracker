'use client';

import type { InspectionSummary, RecoveryReceipt } from '@/src/lib/portable-recovery/types';
import { useLocalization } from '@/src/context/localization';
import { formatRecoveryDetail } from './recovery-details';

export function RecoverySummary({ summary }: { summary: InspectionSummary | RecoveryReceipt }) {
  const { t, language } = useLocalization();
  const number = new Intl.NumberFormat(language);
  const complete = 'status' in summary && summary.status === 'RECOVERED';
  return <section data-testid={complete ? 'recovery-receipt' : 'recovery-inspection'}
    className="space-y-3 rounded-md border border-gray-300 p-4 recovery-summary">
    <h2 className="font-semibold">{t(complete ? 'Recovery verified.' : 'Review this backup before recovery.')}</h2>
    <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
      {[
        ['Source database', summary.sourceProvider], ['Coverage', t(summary.coverage === 'complete' ? 'Complete' : 'Incomplete')],
        ['Source revision', summary.sourceRevision ?? t('Not recorded')], ['Exported at (UTC)', summary.exportedAt ?? t('Not recorded')],
        ['Models', number.format(summary.modelCount)], ['Records', number.format(summary.recordCount)],
        ['Media files', number.format(summary.mediaCount)], ['Media bytes', number.format(summary.mediaBytes)],
      ].map(([label, value]) => <div key={label} className="min-w-0"><dt className="font-medium">{t(label)}</dt><dd className="break-words">{value}</dd></div>)}
      <div className="min-w-0 sm:col-span-2"><dt className="font-medium">{t('Archive SHA-256')}</dt>
        <dd className="break-all font-mono text-xs">{summary.archiveSha256}</dd></div>
    </dl>
    {summary.omissions.length > 0 && <div><h3 className="font-medium">{t('Omissions')}</h3>
      <ul className="list-disc space-y-1 pl-5 text-sm">{summary.omissions.map((item, index) => <li key={index} className="break-words">{formatRecoveryDetail(item, t, language)}</li>)}</ul></div>}
    {summary.diagnostics.length > 0 && <div><h3 className="font-medium">{t('Diagnostics')}</h3>
      <ul className="list-disc space-y-1 pl-5 text-sm">{summary.diagnostics.map((item, index) => <li key={index} className="break-words">{formatRecoveryDetail(item, t, language)}</li>)}</ul></div>}
    {!summary.canRestore && !complete && <p role="alert">{t('This archive cannot be restored.')}</p>}
    {complete && <p role="status" className="font-medium">{t('Activation is required. This screen does not start the normal application or change deployment settings.')}</p>}
  </section>;
}
