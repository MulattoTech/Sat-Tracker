'use client';

import { useId, useState } from 'react';
import { Button } from '@/src/components/ui/button';
import { Input } from '@/src/components/ui/input';
import { Label } from '@/src/components/ui/label';
import { useLocalization } from '@/src/context/localization';
import type { BackupRestoreProps } from './backup-restore.types';

export function OwnerBackupControls({ isLoading, isSaving, onBackupSuccess, onBackupError }: BackupRestoreProps) {
  const { t } = useLocalization();
  const passwordId = useId();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function download(action: 'backup' | 'recovery-key') {
    setBusy(true); setError(null); setSuccess(false);
    try {
      const token = localStorage.getItem('authToken');
      const response = await fetch('/api/database/' + action, {
        method: 'POST', cache: 'no-store', headers: {
          'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}),
        }, body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || 'The download could not be completed.');
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      const name = response.headers.get('Content-Disposition')?.match(/filename="([a-zA-Z0-9._-]+)"/)?.[1];
      anchor.href = url;
      anchor.download = name ?? (action === 'backup' ? 'sat-tracker-portable.zip' : 'sat-tracker-recovery-key.txt');
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setPassword(''); setSuccess(true);
      if (action === 'backup') onBackupSuccess?.();
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'The download could not be completed.';
      setError(message); onBackupError?.(message);
    } finally { setBusy(false); }
  }

  return <div className="space-y-3">
    <p className="text-sm backup-restore-help-text">{t('Create a portable backup of all application metadata and encrypted media. Download its recovery key separately and keep both private.')}</p>
    <p className="text-sm backup-restore-help-text">{t('Use the source installation’s exact ENC_HASH, including its original letter case.')}</p>
    <div className="space-y-1">
      <Label htmlFor={passwordId}>{t('Installation administrator password')}</Label>
      <Input id={passwordId} type="password" autoComplete="current-password" value={password}
        onChange={event => setPassword(event.target.value)} maxLength={1024} disabled={busy} />
    </div>
    <div className="flex flex-col gap-2 sm:flex-row">
      <Button type="button" variant="outline" className="min-h-11 backup-restore-backup-button"
        disabled={isLoading || isSaving || busy || !password} onClick={() => void download('backup')}>
        {t(busy ? 'Preparing download...' : 'Download complete backup')}
      </Button>
      <Button type="button" variant="outline" className="min-h-11 backup-restore-backup-button"
        disabled={isLoading || isSaving || busy || !password} onClick={() => void download('recovery-key')}>
        {t('Download recovery key')}
      </Button>
    </div>
    {error && <p role="alert" className="text-sm backup-restore-error-text">{t(error)}</p>}
    {success && <p role="status" className="text-sm backup-restore-success-text">{t('Download complete.')}</p>}
  </div>;
}
