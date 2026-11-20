import { lstat, readdir } from 'node:fs/promises';
import type { PrismaClient } from '@prisma/client';
import path from 'node:path';
import { assertNativeRestoredDestination } from './startup-guard';
import { readRecoveredSourceKey, readRecoveryReceipt, recoveryStateFiles } from './storage';
import { exportMetadataReadOnly, validatePortableMetadata } from './metadata';
import { verifyEncryptedMetadata } from './crypto';
import { inventoryReferencedMedia, readReferencedMedia } from './media-inventory';
import { verifyRecoveryIntegrity } from './integrity-seal';
import type { RecoveryConfiguration } from './configuration';
import type { PortableSchemaRegistry } from './schema';
import { RecoveryError, type RecoveryReceipt } from './types';

function invalid(): never {
  throw new RecoveryError('RECOVERY_RESUME_UNVERIFIED',
    'A completed recovery could not be verified. Keep its original data and private state for operator review.', 409);
}

function verifiedMediaSnapshot(receipt: RecoveryReceipt): Date {
  const text = receipt.mediaSnapshotAt;
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*\.\d{3}Z$/.test(text)
    || !Number.isFinite(new Date(text).getTime()) || new Date(text).toISOString() !== text
    || new Date(text).getTime() > new Date(receipt.completedAt).getTime()) invalid();
  return new Date(text);
}

async function assertExactMediaTree(root: string, expected: readonly string[]): Promise<void> {
  const actual: string[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory)) {
      const relative = prefix ? prefix + '/' + entry : entry;
      const stat = await lstat(path.join(directory, entry));
      if (stat.isSymbolicLink()) invalid();
      if (stat.isDirectory()) await walk(path.join(directory, entry), relative);
      else if (stat.isFile()) actual.push(relative);
      else invalid();
      if (actual.length > 20_000) invalid();
    }
  }
  await walk(root, '');
  const wanted = [...expected].sort(), found = actual.sort();
  if (wanted.length !== found.length || wanted.some((value, index) => value !== found[index])) invalid();
}

/** No source environment, seed, migration, imported-row mutation or activation. */
export async function verifyCompletedRecovery(config: RecoveryConfiguration, registry: PortableSchemaRegistry, providerClient?: PrismaClient): Promise<RecoveryReceipt> {
  try {
    const state = (await recoveryStateFiles(config)).sort();
    if (state.length !== 2 || state[0] !== 'receipt.json' || state[1] !== 'recovery.env') invalid();
    const receipt = await readRecoveryReceipt(config);
    if (!receipt || !receipt.integrityTag || !receipt.mediaSnapshotAt) invalid();
    const sourceKey = await readRecoveredSourceKey(config);
    const snapshot = verifiedMediaSnapshot(receipt);
    await assertNativeRestoredDestination(config, registry);
    const client = providerClient ?? await (async () => {
      const [{ PrismaClient }, { createPrismaAdapter }] = await Promise.all([
        import('@prisma/client'), import('../../../prisma/prisma-adapter'),
      ]);
      return new PrismaClient({ adapter: createPrismaAdapter(config.databaseUrl), log: [] });
    })();
    try {
      const metadata = await exportMetadataReadOnly(client, {
        provider: config.provider, registry, exportedAt: receipt.exportedAt ?? undefined,
      });
      const validated = validatePortableMetadata(metadata, registry);
      verifyEncryptedMetadata(metadata, sourceKey);
      const inventory = inventoryReferencedMedia(metadata, snapshot);
      const media = await readReferencedMedia(inventory, { filesRoot: config.filesRoot }, sourceKey);
      if (validated.totalRows !== receipt.recordsRestored || validated.totalRows !== receipt.recordCount
        || registry.models.length !== receipt.tablesRestored || registry.models.length !== receipt.modelCount
        || media.length !== receipt.filesRestored || media.length !== receipt.mediaCount
        || media.reduce((sum, item) => sum + item.byteLength, 0) !== receipt.mediaBytes) invalid();
      verifyRecoveryIntegrity(receipt, validated.tableHashes, media, sourceKey);
      await assertExactMediaTree(config.filesRoot, media.map(item => item.storagePath));
      await assertNativeRestoredDestination(config, registry);
    } finally { if (!providerClient) await client.$disconnect(); }
    return receipt;
  } catch {
    return invalid(); // Never expose key, family metadata, provider exceptions or file paths.
  }
}
