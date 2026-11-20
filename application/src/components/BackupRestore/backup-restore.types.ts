/**
 * Props for the BackupRestore component
 */
export interface BackupRestoreProps {
  /** Whether the component is in a loading state */
  isLoading?: boolean;
  
  /** Whether the component is in a saving state */
  isSaving?: boolean;
  
  /** Callback for when backup succeeds */
  onBackupSuccess?: () => void;
  
  /** Callback for when backup fails */
  onBackupError?: (error: string) => void;
  
  /** @deprecated Recovery uses its dedicated isolated screen and never activates this installation. */
  onRestoreSuccess?: () => void;

  /** @deprecated Recovery errors are displayed on the dedicated recovery screen. */
  onRestoreError?: (error: string) => void;

  /** @deprecated Recovery never resets the installation administrator password. */
  onAdminPasswordReset?: () => void;

  /**
   * @deprecated Retained for existing callers; recovery never resets passwords or reloads the application.
   */
  onAdminResetAcknowledged?: () => Promise<void>;

  /** Custom className for the container */
  className?: string;

  /** Show only the link explaining isolated recovery (no local import action). */
  importOnly?: boolean;

  /** Initial setup shows isolated recovery guidance; it has no restore authority. */
  initialSetup?: boolean;
}
