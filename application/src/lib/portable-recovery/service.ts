import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PrismaClient } from '@prisma/client';
import { assertSourceKey } from './crypto';
import { assertRunningRecoveryConfiguration, recoveryConfiguration, type RecoveryConfiguration } from './configuration';
import {
  assertRecoveryReady, createPortableBackup, recoverPortableArchive, safeRecoveryError,
} from './engine';
import { inspectRecoveryInput } from './inspection';
import { MAX_PORTABLE_ARCHIVE_BYTES } from './archive';
import { loadPortableSchema } from './schema';
import { readRecoveryInstance, readRecoveryReceipt, recoveryStateFiles } from './storage';
import { RecoveryError, type InspectionSummary, type RecoveryReceipt, type RecoveryStatus } from './types';

const clients = new Map<string, PrismaClient>();

async function recoveryClient(config: RecoveryConfiguration): Promise<PrismaClient> {
  assertRunningRecoveryConfiguration(config);
  await readRecoveryInstance(config);
  const existing = clients.get(config.binding);
  if (existing) return existing;
  const [{ PrismaClient }, { createPrismaAdapter }] = await Promise.all([
    import('@prisma/client'), import('../../../prisma/prisma-adapter'),
  ]);
  // No query/error logging: imported rows include private configuration and credentials.
  const client = new PrismaClient({ adapter: createPrismaAdapter(config.databaseUrl), log: [] });
  clients.set(config.binding, client);
  return client;
}

export async function getRecoveryStatus(): Promise<RecoveryStatus> {
  try {
    const config = recoveryConfiguration();
    assertRunningRecoveryConfiguration(config);
    await readRecoveryInstance(config);
    const state = await recoveryStateFiles(config);
    if (state.includes('operation.lock') || state.some(name => !['receipt.json', 'recovery.env'].includes(name))) {
      return { mode: 'recovery', state: 'blocked', ready: false, maxArchiveBytes: MAX_PORTABLE_ARCHIVE_BYTES,
        reason: 'Recovery is in progress or requires operator review of retained state.' };
    }
    if (state.includes('receipt.json') && state.includes('recovery.env')) {
      const receipt = await readRecoveryReceipt(config);
      if (receipt) return { mode: 'recovery', state: 'complete', ready: false, maxArchiveBytes: MAX_PORTABLE_ARCHIVE_BYTES, receipt };
    }
    if (state.length) throw new RecoveryError('INCOMPLETE_RECOVERY_STATE', 'Recovery requires operator review of retained state.', 409);
    await assertRecoveryReady(await recoveryClient(config), config, await loadPortableSchema());
    return { mode: 'recovery', state: 'empty', ready: true, maxArchiveBytes: MAX_PORTABLE_ARCHIVE_BYTES };
  } catch (error) {
    const safe = safeRecoveryError(error);
    return { mode: 'recovery', state: 'blocked', ready: false, maxArchiveBytes: MAX_PORTABLE_ARCHIVE_BYTES, reason: safe.message };
  }
}

export async function inspectRecoveryArchive(bytes: Buffer, exactSourceKey: string): Promise<InspectionSummary> {
  try {
    const config = recoveryConfiguration(), registry = await loadPortableSchema();
    const summary = await inspectRecoveryInput(bytes, exactSourceKey, registry);
    await assertRecoveryReady(await recoveryClient(config), config, registry);
    return summary;
  } catch (error) { throw safeRecoveryError(error); }
}

export async function commitRecoveryArchive(bytes: Buffer, exactSourceKey: string, expectedArchiveSha256: string): Promise<RecoveryReceipt> {
  try {
    const config = recoveryConfiguration(), registry = await loadPortableSchema();
    return await recoverPortableArchive({ client: await recoveryClient(config), config, registry, bytes, exactSourceKey, expectedArchiveSha256 });
  } catch (error) { throw safeRecoveryError(error); }
}

/** Used only behind configured installation-owner authority and current-password verification. */
export function getSourceRecoveryKey(): string {
  const key = process.env.ENC_HASH;
  try { assertSourceKey(key); } catch { throw new RecoveryError('SOURCE_KEY_UNAVAILABLE', 'The installation encryption key is unavailable or invalid.', 503); }
  return key as string;
}

async function sourceRevision(): Promise<string> {
  const configured = process.env.SAT_TRACKER_SOURCE_REVISION;
  if (configured && /^[a-f\d]{40}$/.test(configured)) return configured;
  if (!configured) {
    try {
      const run = promisify(execFile);
      const [head, status] = await Promise.all([
        run('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), timeout: 2_000, maxBuffer: 1024 }),
        run('git', ['status', '--porcelain', '--untracked-files=normal', '--', '.'], { cwd: process.cwd(), timeout: 2_000, maxBuffer: 4096 }),
      ]);
      const revision = head.stdout.trim();
      if (!status.stdout && /^[a-f\d]{40}$/.test(revision)) return revision;
    } catch { /* Production images carry an explicit immutable build revision. */ }
  }
  throw new RecoveryError('SOURCE_REVISION_REQUIRED', 'This application build must identify its exact source revision before creating a complete backup.', 503);
}

export async function createInstallationBackup(): Promise<{ bytes: Buffer; fileName: string }> {
  if (process.env.SAT_TRACKER_RECOVERY_MODE === '1') throw new RecoveryError('NORMAL_INSTALLATION_REQUIRED', 'A backup must be created from the normal source installation.', 409);
  try {
    const exactSourceKey = getSourceRecoveryKey(), url = process.env.DATABASE_URL;
    const provider = url?.startsWith('file:') ? 'sqlite' : /^postgres(?:ql)?:\/\//.test(url ?? '') ? 'postgresql' : null;
    if (!provider || (process.env.DATABASE_PROVIDER && process.env.DATABASE_PROVIDER !== provider)) {
      throw new RecoveryError('SOURCE_DATABASE_REQUIRED', 'The source installation must have an explicit, consistent database configuration.', 503);
    }
    const [{ default: client }, registry, revision] = await Promise.all([
      import('../../../app/api/db'), loadPortableSchema(), sourceRevision(),
    ]);
    const now = new Date();
    const bytes = await createPortableBackup({ client, provider, registry, exactSourceKey, sourceRevision: revision, now,
      filesRoot: path.resolve(process.cwd(), 'Files'), ocrRoot: process.env.BABYTRACKER_OCR_FILES_DIR || undefined });
    return { bytes, fileName: `sat-tracker-portable-${now.toISOString().replace(/[:.]/g, '-')}.zip` };
  } catch (error) { throw safeRecoveryError(error); }
}
