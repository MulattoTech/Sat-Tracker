export type RecoveryProvider = 'sqlite' | 'postgresql';

export interface InspectionSummary {
  archiveSha256: string;
  format: 'portable-v1' | 'legacy';
  sourceProvider: RecoveryProvider;
  sourceRevision: string | null;
  exportedAt: string | null;
  modelCount: number;
  recordCount: number;
  mediaCount: number;
  mediaBytes: number;
  coverage: 'complete' | 'incomplete';
  omissions: string[];
  diagnostics: string[];
  canRestore: boolean;
}

export interface RecoveryReceipt extends InspectionSummary {
  status: 'RECOVERED';
  destinationProvider: RecoveryProvider;
  completedAt: string;
  tablesRestored: number;
  recordsRestored: number;
  filesRestored: number;
  verified: true;
  activationRequired: true;
  /** Created only for recoveries sealed by the restart-verification protocol. */
  mediaSnapshotAt?: string;
  integrityTag?: string;
}

export interface RecoveryStatus {
  mode: 'recovery';
  state: 'empty' | 'complete' | 'blocked';
  ready: boolean;
  maxArchiveBytes: number;
  reason?: string;
  receipt?: RecoveryReceipt;
}

/** Public diagnostics never include keys, connection strings or stored scalar values. */
export class RecoveryError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = 'RecoveryError';
  }
}
