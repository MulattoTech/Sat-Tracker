'use client';

import { cn } from '@/src/lib/utils';
import { useLocalization } from '@/src/context/localization';
import { OwnerBackupControls } from './OwnerBackupControls';
import type { BackupRestoreProps } from './backup-restore.types';
import './backup-restore.css';

/** Normal installations export; recovery only runs on a separately started empty instance. */
export function BackupRestore(props: BackupRestoreProps) {
  const { t } = useLocalization();
  return <section className={cn('space-y-4', props.className)}>
    <h2 className="text-lg font-semibold backup-restore-title">{t('Complete backup and recovery')}</h2>
    {!props.importOnly && !props.initialSetup && <OwnerBackupControls {...props} />}
    <p className="text-sm backup-restore-help-text">
      {t('Recovery requires a separate, empty instance started in recovery mode. Existing installation data cannot be replaced here.')}
    </p>
    <a href="https://github.com/MulattoTech/Sat-Tracker/blob/main/application/documentation/Admin-Documentation/portable-recovery.md"
      className="inline-flex min-h-11 items-center rounded-md border border-gray-300 px-4 py-2 text-sm font-medium backup-restore-button">
      {t('View recovery setup instructions')}
    </a>
  </section>;
}

export default BackupRestore;
