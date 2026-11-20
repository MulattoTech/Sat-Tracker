'use client';

import { useId } from 'react';
import { Button } from '@/src/components/ui/button';
import { Input } from '@/src/components/ui/input';
import { Label } from '@/src/components/ui/label';
import { useLocalization } from '@/src/context/localization';
import { useRecovery } from './useRecovery';
import { RecoverySummary } from './RecoverySummary';
import './backup-restore.css';

export function RecoveryPanel() {
  const { t } = useLocalization();
  const id = useId();
  const state = useRecovery();
  return <main className="mx-auto w-full max-w-3xl space-y-5 p-4 sm:p-8 recovery-panel">
    <h1 className="text-2xl font-semibold">{t('Isolated recovery')}</h1>
    <p>{t('Recover into an empty destination. The normal application stays unavailable until an operator activates this instance separately.')}</p>
    {state.receipt ? <RecoverySummary summary={state.receipt} /> : <>
      <div className="space-y-1">
        <Label htmlFor={id + '-token'}>{t('Recovery operator token')}</Label>
        <Input id={id + '-token'} type="password" autoComplete="off" spellCheck={false} maxLength={128}
          value={state.token} disabled={state.busy} onChange={event => state.change('token', event.target.value)} />
      </div>
      <Button type="button" variant="outline" className="min-h-11" disabled={state.busy || !state.token}
        onClick={() => void state.run('status')}>{t(state.busy ? 'Working...' : 'Check recovery destination')}</Button>
      {state.status && <div role="status" data-testid="recovery-destination-status" className="space-y-1">
        <p>{t(state.status.ready ? 'Destination is empty and ready.' : 'Recovery is blocked. Review the destination status before continuing.')}</p>
        {state.status.reason && <p className="text-sm">{t(state.status.reason)}</p>}
      </div>}
      <div className="space-y-1">
        <Label htmlFor={id + '-archive'}>{t('Backup archive')}</Label>
        <Input id={id + '-archive'} type="file" accept=".zip,.db,.sqlite" disabled={state.busy}
          onChange={event => state.change('file', event.target.files?.[0] ?? null)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={id + '-key'}>{t('Source recovery key')}</Label>
        <p id={id + '-key-help'} className="text-sm">{t('Use the source installation’s exact ENC_HASH, including its original letter case.')}</p>
        <Input id={id + '-key'} type="password" autoComplete="off" spellCheck={false} maxLength={64}
          aria-describedby={id + '-key-help'}
          value={state.sourceKey} disabled={state.busy} onChange={event => state.change('sourceKey', event.target.value)} />
      </div>
      <Button type="button" className="min-h-11" disabled={state.busy || !state.status?.ready || !state.file || !state.sourceKey}
        onClick={() => void state.run('inspect')}>{t(state.busy ? 'Working...' : 'Inspect backup')}</Button>
      {state.inspection && <>
        <RecoverySummary summary={state.inspection} />
        <Button type="button" className="min-h-11 w-full whitespace-normal" disabled={state.busy || !state.inspection.canRestore || !state.status?.ready}
          onClick={() => void state.run('commit')}>{t(state.busy ? 'Working...' : 'Recover into this empty destination')}</Button>
      </>}
    </>}
    {state.error && <p role="alert" className="rounded-md border border-red-300 p-3 backup-restore-error-text">{t(state.error)}</p>}
  </main>;
}
