import type { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { createPortableArchive, preflightPortableArchive } from './archive';
import { assertSourceKey, verifyEncryptedMetadata } from './crypto';
import type { RecoveryConfiguration } from './configuration';
import { inventoryReferencedMedia, readReferencedMedia } from './media-inventory';
import { PortableMediaError } from './media-types';
import {
  assertRestoredMetadataMatches, exportMetadataFromTransaction, importMetadataInTransaction,
  lockAndAssertEmptyMetadataDestination, lockMetadataSnapshot, PortableMetadataError,
  validatePortableMetadata, type PortableProvider,
} from './metadata';
import type { PortableSchemaRegistry } from './schema';
import {
  assertEmptyMediaRoot, readRecoveryInstance, recoveryStateFiles, stageRecoveryPublication,
} from './storage';
import { RecoveryError, type InspectionSummary, type RecoveryReceipt } from './types';

const transactionOptions = { isolationLevel: 'Serializable' as const, maxWait: 5_000, timeout: 120_000 };
export const archiveDigest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Responses never include a database error, connection URL, record value or supplied key. */
export function safeRecoveryError(error: unknown): RecoveryError {
  if (error instanceof RecoveryError) return error;
  if (error instanceof PortableMediaError) return new RecoveryError(error.code, error.message);
  if (error instanceof PortableMetadataError) {
    const conflict = ['DESTINATION_NOT_EMPTY', 'EMPTY_DESTINATION_NOT_LOCKED', 'METADATA_LOCK_FAILED'].includes(error.code);
    return new RecoveryError(error.code, conflict
      ? 'The destination is not available as an empty, isolated recovery destination.'
      : 'The application metadata is incomplete or incompatible with this application schema.', conflict ? 409 : 400);
  }
  return new RecoveryError('RECOVERY_OPERATION_FAILED', 'Recovery could not finish. Inspect the destination recovery status before retrying.', 500);
}

/** Pure, bounded archive/key/schema preflight. No database or destination filesystem access. */
export function preparePortableRecovery(bytes: Buffer, exactSourceKey: string, registry: PortableSchemaRegistry, now = new Date()) {
  const snapshot = Buffer.from(bytes);
  const archiveSha256 = archiveDigest(snapshot);
  const archive = preflightPortableArchive(snapshot, exactSourceKey, { now });
  const validated = validatePortableMetadata(archive.metadata, registry);
  const summary: InspectionSummary = {
    archiveSha256, format: 'portable-v1', sourceProvider: archive.manifest.sourceProvider,
    sourceRevision: archive.manifest.sourceRevision, exportedAt: archive.manifest.exportedAt,
    modelCount: registry.models.length, recordCount: validated.totalRows,
    mediaCount: archive.mediaToRestore.length,
    mediaBytes: archive.mediaToRestore.reduce((sum, item) => sum + item.byteLength, 0),
    coverage: 'complete', canRestore: true,
    omissions: archive.omissions.length ? [`${archive.omissions.length} OCR documents have expired or purged source media; their original metadata and retention dates are preserved.`] : [],
    diagnostics: ['Diagnostic API logs and environment files are excluded. The source encryption key must remain separately protected.',
      ...(archive.encryption.legacyPlaintextValues ? [`${archive.encryption.legacyPlaintextValues} historical configuration values are stored as plaintext. They are preserved exactly and are not counted as authenticated ciphertext.`] : [])],
  };
  return { archive, validated, summary };
}

export async function assertRecoveryReady(client: PrismaClient, config: RecoveryConfiguration, registry: PortableSchemaRegistry): Promise<void> {
  await readRecoveryInstance(config);
  if ((await recoveryStateFiles(config)).length) throw new RecoveryError('RECOVERY_ALREADY_STARTED', 'This destination already has recovery state and cannot accept another archive.', 409);
  await assertEmptyMediaRoot(config.filesRoot);
  await client.$transaction(async tx => {
    await lockAndAssertEmptyMetadataDestination(tx, { provider: config.provider, registry });
  }, transactionOptions);
  await assertEmptyMediaRoot(config.filesRoot);
  if ((await recoveryStateFiles(config)).length) throw new RecoveryError('RECOVERY_ALREADY_STARTED', 'Another recovery operation has started for this destination.', 409);
}

export interface PortableBackupOptions {
  client: PrismaClient;
  provider: PortableProvider;
  registry: PortableSchemaRegistry;
  filesRoot: string;
  ocrRoot?: string;
  exactSourceKey: string;
  sourceRevision: string;
  now?: Date;
}

/** Keep all reference rows and ciphertext reads under the same native source snapshot lock. */
export async function createPortableBackup(options: PortableBackupOptions): Promise<Buffer> {
  assertSourceKey(options.exactSourceKey);
  if (!/^[a-f\d]{40}$/.test(options.sourceRevision)) throw new RecoveryError('SOURCE_REVISION_REQUIRED', 'A complete backup requires the exact application source revision.', 503);
  const now = options.now ?? new Date();
  const captured = await options.client.$transaction(async tx => {
    await lockMetadataSnapshot(tx, options);
    const metadata = await exportMetadataFromTransaction(tx, { ...options, exportedAt: now.toISOString() });
    validatePortableMetadata(metadata, options.registry);
    verifyEncryptedMetadata(metadata, options.exactSourceKey);
    const inventory = inventoryReferencedMedia(metadata, now);
    const media = await readReferencedMedia(inventory, options, options.exactSourceKey);
    return { metadata, media, omissions: inventory.omissions, sourceRevision: options.sourceRevision };
  }, transactionOptions);
  return createPortableArchive(captured, options.exactSourceKey);
}

export interface PortableRestoreOptions {
  client: PrismaClient;
  config: RecoveryConfiguration;
  registry: PortableSchemaRegistry;
  bytes: Buffer;
  exactSourceKey: string;
  expectedArchiveSha256: string;
  now?: Date;
}

/** A journaled isolated recovery, never an atomic live cutover or a retryable transaction callback. */
export async function recoverPortableArchive(options: PortableRestoreOptions): Promise<RecoveryReceipt> {
  const { client, config, registry, exactSourceKey } = options;
  let prepared: ReturnType<typeof preparePortableRecovery>;
  try {
    prepared = preparePortableRecovery(options.bytes, exactSourceKey, registry, options.now);
    if (!/^[a-f\d]{64}$/.test(options.expectedArchiveSha256) || options.expectedArchiveSha256 !== prepared.summary.archiveSha256) {
      throw new RecoveryError('ARCHIVE_CHANGED', 'Inspect this exact archive before recovering it.', 409);
    }
    await assertRecoveryReady(client, config, registry);
  } catch (error) { throw safeRecoveryError(error); }

  // No destination write occurs until the complete archive, key, schema and references pass.
  const publication = await stageRecoveryPublication(config, prepared.archive.mediaToRestore, exactSourceKey, prepared.summary.archiveSha256)
    .catch(error => { throw safeRecoveryError(error); });
  let committed = false;
  try {
    const imported = await client.$transaction(async tx => {
      await lockAndAssertEmptyMetadataDestination(tx, { provider: config.provider, registry });
      await assertEmptyMediaRoot(config.filesRoot);
      await importMetadataInTransaction(tx, prepared.validated);
      await publication.publish();
      return assertRestoredMetadataMatches(tx, prepared.validated);
    }, transactionOptions);
    committed = true;
    const receipt: RecoveryReceipt = {
      ...prepared.summary, status: 'RECOVERED', destinationProvider: config.provider,
      completedAt: new Date().toISOString(), tablesRestored: imported.tablesImported,
      recordsRestored: imported.recordsImported, filesRestored: prepared.archive.mediaToRestore.length,
      verified: true, activationRequired: true,
    };
    await publication.finish(receipt);
    return receipt;
  } catch (error) {
    let rollbackVerified = false;
    if (!committed) {
      try {
        // A lost commit response is ambiguous. Remove owned files only after a new native
        // transaction independently proves every destination application table is empty.
        await client.$transaction(async tx => {
          await lockAndAssertEmptyMetadataDestination(tx, { provider: config.provider, registry });
        }, transactionOptions);
        rollbackVerified = true;
      } catch { /* Retain the journal and bytes for operator review. Never replay the callback. */ }
    }
    try { await publication.cleanup(rollbackVerified); }
    catch { throw new RecoveryError('RECOVERY_QUARANTINED', 'Recovery requires operator review; its journal and conflicting files have been retained.', 409); }
    if (!rollbackVerified) throw new RecoveryError('RECOVERY_QUARANTINED', 'Recovery requires operator review of the retained journal and destination. Do not retry or activate it.', 409);
    throw safeRecoveryError(error);
  }
}
