import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCipheriv, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { recoveryConfiguration, assertRunningRecoveryConfiguration } from '@/src/lib/portable-recovery/configuration';
import {
  assertEmptyMediaRoot, initializeRecoveryInstance, readRecoveryInstance, readRecoveryReceipt,
  recoveryStateFiles, stageRecoveryPublication,
} from '@/src/lib/portable-recovery/storage';
import { assertNativeEmptyDestination } from '@/src/lib/portable-recovery/startup-guard';
import type { RecoveryReceipt } from '@/src/lib/portable-recovery/types';
import type { VerifiedMedia } from '@/src/lib/portable-recovery/media-types';
import { metadataRegistry, migrateNativeSQLite } from './portableRecoveryTestUtils';

const roots: string[] = [];
const key = 'ab'.repeat(32), token = 'cd'.repeat(32), digest = 'ef'.repeat(32);
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function destination() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sat-portable-destination-')); roots.push(root);
  const env = { SAT_TRACKER_RECOVERY_MODE: '1', SAT_TRACKER_RECOVERY_TOKEN: token,
    SAT_TRACKER_RECOVERY_DATABASE_URL: `file:${path.join(root, 'database.db')}`, SAT_TRACKER_RECOVERY_STATE_DIR: path.join(root, 'private-state') };
  const config = recoveryConfiguration(env, root);
  return { root, env, config };
}
function media(): VerifiedMedia {
  const plaintext = Buffer.from('synthetic media'), iv = Buffer.alloc(16, 7);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const ciphertext = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  return { storagePath: 'photos/family-synthetic/photo-synthetic.enc', ciphertext,
    byteLength: ciphertext.length, sha256: createHash('sha256').update(ciphertext).digest('hex'),
    references: [{ model: 'Photo', recordId: 'photo-synthetic', field: 'storedName', role: 'photo-display', plaintextBytes: plaintext.length }] };
}
const receipt: RecoveryReceipt = { archiveSha256: digest, format: 'portable-v1', sourceProvider: 'sqlite',
  sourceRevision: 'a'.repeat(40), exportedAt: '2026-11-20T00:00:00.000Z', modelCount: 66, recordCount: 3,
  mediaCount: 1, mediaBytes: 47, coverage: 'complete', omissions: [], diagnostics: [], canRestore: true,
  status: 'RECOVERED', destinationProvider: 'sqlite', completedAt: '2026-11-20T00:01:00.000Z',
  tablesRestored: 66, recordsRestored: 3, filesRestored: 1, verified: true, activationRequired: true };

describe('explicit isolated recovery configuration', () => {
  it('requires mode, an operator capability, absolute separate paths, and matching running database', async () => {
    const { env, root, config } = await destination();
    expect(() => recoveryConfiguration({ ...env, SAT_TRACKER_RECOVERY_MODE: '' }, root)).toThrow();
    expect(() => recoveryConfiguration({ ...env, SAT_TRACKER_RECOVERY_TOKEN: 'admin' }, root)).toThrow();
    expect(() => recoveryConfiguration({ ...env, SAT_TRACKER_RECOVERY_DATABASE_URL: 'file:./live.db' }, root)).toThrow();
    expect(() => recoveryConfiguration({ ...env, SAT_TRACKER_RECOVERY_STATE_DIR: path.join(root, 'Files', 'state') }, root)).toThrow();
    expect(() => recoveryConfiguration({ ...env, SAT_TRACKER_RECOVERY_DATABASE_URL: `file:${path.join(root, 'Files', 'data.db')}` }, root)).toThrow();
    expect(() => assertRunningRecoveryConfiguration(config, { DATABASE_URL: 'file:/some-live.db', DATABASE_PROVIDER: 'sqlite' })).toThrow();
    expect(() => assertRunningRecoveryConfiguration(config, { DATABASE_URL: config.databaseUrl, DATABASE_PROVIDER: 'sqlite', BABYTRACKER_OCR_FILES_DIR: '/some-live-ocr' })).toThrow();
    expect(() => assertRunningRecoveryConfiguration(config, { DATABASE_URL: config.databaseUrl, DATABASE_PROVIDER: 'sqlite' })).not.toThrow();
  });

  it('binds PostgreSQL to one explicit lowercase schema without URL option overrides', async () => {
    const { env, root } = await destination();
    const db = 'postgresql://owner:synthetic@127.0.0.1/sat_tracker_recovery_test';
    const config = recoveryConfiguration({ ...env, SAT_TRACKER_RECOVERY_DATABASE_URL: db + '?schema=isolated_recovery' }, root);
    expect(config).toMatchObject({ provider: 'postgresql', databaseName: 'sat_tracker_recovery_test', databaseSchema: 'isolated_recovery' });
    for (const query of ['?schema=public&schema=other', '?options=-c%20search_path=public', '?schema=MixedCase', '#other']) {
      expect(() => recoveryConfiguration({ ...env, SAT_TRACKER_RECOVERY_DATABASE_URL: db + query }, root)).toThrow();
    }
  });
});

describe('native startup guards before DDL or normal startup', () => {
  it('does not create a missing database, media directory or state during inspection', async () => {
    const { root, config } = await destination();
    await assertNativeEmptyDestination(config, metadataRegistry);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('rejects a populated known application table without changing it', async () => {
    const { config } = await destination();
    const db = new Database(config.databasePath!);
    db.exec("CREATE TABLE Family (id TEXT PRIMARY KEY); INSERT INTO Family VALUES ('owned-synthetic');"); db.close();
    const before = await fs.readFile(config.databasePath!);
    await expect(assertNativeEmptyDestination(config, metadataRegistry)).rejects.toMatchObject({ code: 'DESTINATION_NOT_EMPTY' });
    expect(await fs.readFile(config.databasePath!)).toEqual(before);
  });

  it('distinguishes a fresh database from a complete empty schema and rejects partial or drifted schemas', async () => {
    const { config } = await destination();
    expect(await assertNativeEmptyDestination(config, metadataRegistry)).toBe('fresh');
    let db = new Database(config.databasePath!); db.exec('CREATE TABLE Family (id TEXT PRIMARY KEY)'); db.close();
    await expect(assertNativeEmptyDestination(config, metadataRegistry)).rejects.toMatchObject({ code: 'UNEXPECTED_DESTINATION_SCHEMA' });
    await fs.unlink(config.databasePath!); db = new Database(config.databasePath!); migrateNativeSQLite(db); db.close();
    expect(await assertNativeEmptyDestination(config, metadataRegistry)).toBe('current-empty');
    db = new Database(config.databasePath!); db.exec('ALTER TABLE Family ADD COLUMN unknown_value TEXT'); db.close();
    await expect(assertNativeEmptyDestination(config, metadataRegistry)).rejects.toMatchObject({ code: 'UNEXPECTED_DESTINATION_SCHEMA' });
  });

  it.each(['CREATE TABLE UnrelatedData (id TEXT)', 'CREATE VIEW Family AS SELECT 1 AS id', 'CREATE TABLE Family (id TEXT); CREATE TRIGGER custom_trigger AFTER INSERT ON Family BEGIN SELECT 1; END'])
  ('rejects unknown or active schema objects: %s', async sql => {
    const { config } = await destination(); const db = new Database(config.databasePath!); db.exec(sql); db.close();
    await expect(assertNativeEmptyDestination(config, metadataRegistry)).rejects.toMatchObject({ code: 'UNEXPECTED_DESTINATION_SCHEMA' });
  });

  it('rejects unresolved SQLite journals and any populated media root', async () => {
    const { config } = await destination();
    await fs.writeFile(config.databasePath! + '-wal', 'synthetic unresolved journal');
    await expect(assertNativeEmptyDestination(config, metadataRegistry)).rejects.toMatchObject({ code: 'DATABASE_IN_USE' });
    await fs.unlink(config.databasePath! + '-wal');
    await fs.mkdir(config.filesRoot); await fs.writeFile(path.join(config.filesRoot, 'existing'), 'owned');
    await expect(assertNativeEmptyDestination(config, metadataRegistry)).rejects.toMatchObject({ code: 'DESTINATION_NOT_EMPTY' });
    expect(await fs.readFile(path.join(config.filesRoot, 'existing'), 'utf8')).toBe('owned');
  });

  it.skipIf(process.platform === 'win32')('rejects symlink destinations and world-readable private state', async () => {
    const { root, config } = await destination();
    await fs.mkdir(path.join(root, 'outside')); await fs.symlink(path.join(root, 'outside'), config.filesRoot);
    await expect(assertEmptyMediaRoot(config.filesRoot)).rejects.toMatchObject({ code: 'UNSAFE_DESTINATION_PATH' });
    await fs.unlink(config.filesRoot); await initializeRecoveryInstance(config); await fs.chmod(config.stateDir, 0o755);
    await expect(readRecoveryInstance(config)).rejects.toMatchObject({ code: 'PRIVATE_STATE_REQUIRED' });
  });
});

describe('journaled encrypted media publication and cleanup', () => {
  it('verifies ciphertext, protects the separate exact key and binds the successful receipt to this destination', async () => {
    const { root, config } = await destination(); const file = media();
    await fs.writeFile(path.join(root, '.env'), 'DO_NOT_CHANGE=1\n');
    await initializeRecoveryInstance(config);
    const publication = await stageRecoveryPublication(config, [file], key, digest);
    expect(await fs.readdir(root)).not.toContain('Files');
    await publication.publish(); await publication.finish(receipt);
    expect(await fs.readFile(path.join(config.filesRoot, file.storagePath))).toEqual(file.ciphertext);
    expect(await fs.readFile(path.join(config.stateDir, 'recovery.env'), 'utf8')).toBe(`ENC_HASH="${key}"\n`);
    expect(await fs.readFile(path.join(root, '.env'), 'utf8')).toBe('DO_NOT_CHANGE=1\n');
    expect((await recoveryStateFiles(config)).sort()).toEqual(['receipt.json', 'recovery.env']);
    expect(await readRecoveryReceipt(config)).toEqual(receipt);
    await expect(readRecoveryInstance({ ...config, tokenHash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'RECOVERY_INSTANCE_MISMATCH' });
    const filename = path.join(config.stateDir, 'receipt.json');
    const altered = JSON.parse(await fs.readFile(filename, 'utf8')); altered.binding = '0'.repeat(64);
    await fs.writeFile(filename, JSON.stringify(altered));
    await expect(readRecoveryReceipt(config)).rejects.toMatchObject({ code: 'INVALID_RECOVERY_RECEIPT' });
  });

  it('allows only one concurrent publisher and leaves destination untouched during staging', async () => {
    const { config } = await destination(); await initializeRecoveryInstance(config);
    const attempts = await Promise.allSettled([1, 2].map(() => stageRecoveryPublication(config, [media()], key, digest)));
    expect(attempts.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(item => item.status === 'rejected')).toHaveLength(1);
    await assertEmptyMediaRoot(config.filesRoot);
    const winner = attempts.find(item => item.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof stageRecoveryPublication>>>;
    await winner.value.cleanup(true); expect(await recoveryStateFiles(config)).toEqual([]);
  });

  it('removes only owned unchanged files after verified rollback', async () => {
    const { config } = await destination(); await initializeRecoveryInstance(config);
    const publication = await stageRecoveryPublication(config, [media()], key, digest);
    await publication.publish(); await publication.cleanup(true);
    await assertEmptyMediaRoot(config.filesRoot); expect(await recoveryStateFiles(config)).toEqual([]);
  });

  it('retains media, key, journal and staging when the database outcome is unknown', async () => {
    const { config } = await destination(); await initializeRecoveryInstance(config); const file = media();
    const publication = await stageRecoveryPublication(config, [file], key, digest); await publication.publish(); await publication.cleanup(false);
    expect(await fs.readFile(path.join(config.filesRoot, file.storagePath))).toEqual(file.ciphertext);
    expect(await fs.readdir(path.join(config.stateDir, 'operation.lock'))).toContain('outcome-unknown');
    await expect(stageRecoveryPublication(config, [file], key, digest)).rejects.toMatchObject({ code: 'RECOVERY_ALREADY_STARTED' });
  });

  it('recreates a blocking marker if finalization fails after removing its original lock', async () => {
    const { config } = await destination(); await initializeRecoveryInstance(config); const file = media();
    const publication = await stageRecoveryPublication(config, [file], key, digest); await publication.publish();
    const remove = fs.rm.bind(fs), lock = path.join(config.stateDir, 'operation.lock');
    const failure = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      await remove(target, options);
      if (target === lock) throw Object.assign(new Error('Synthetic post-removal I/O failure'), { code: 'EIO' });
    });
    await expect(publication.finish(receipt)).rejects.toMatchObject({ code: 'EIO' }); failure.mockRestore();
    await publication.cleanup(false);
    expect(await recoveryStateFiles(config)).toContain('operation.lock');
    expect(await fs.readdir(lock)).toContain('outcome-unknown');
    expect(await fs.readFile(path.join(config.filesRoot, file.storagePath))).toEqual(file.ciphertext);
  });

  it('preserves a conflicting file and its journal instead of sweeping the destination', async () => {
    const { config } = await destination(); await initializeRecoveryInstance(config); const file = media();
    const publication = await stageRecoveryPublication(config, [file], key, digest); await publication.publish();
    const filename = path.join(config.filesRoot, file.storagePath); await fs.writeFile(filename, 'changed by another actor');
    await expect(publication.cleanup(true)).rejects.toMatchObject({ code: 'RECOVERY_CLEANUP_CONFLICT' });
    expect(await fs.readFile(filename, 'utf8')).toBe('changed by another actor');
    expect(await recoveryStateFiles(config)).toContain('operation.lock');
  });

  it('rejects wrong keys and collisions without overwriting caller files', async () => {
    const { config } = await destination(); await initializeRecoveryInstance(config);
    await expect(stageRecoveryPublication(config, [media()], '12'.repeat(32), digest)).rejects.toMatchObject({ code: 'DECRYPTION_FAILED' });
    expect(await recoveryStateFiles(config)).toEqual([]);
    const publication = await stageRecoveryPublication(config, [media()], key, digest);
    await fs.mkdir(config.filesRoot); await fs.writeFile(path.join(config.filesRoot, 'existing'), 'owned');
    await expect(publication.publish()).rejects.toMatchObject({ code: 'DESTINATION_NOT_EMPTY' });
    await publication.cleanup(true); expect(await fs.readFile(path.join(config.filesRoot, 'existing'), 'utf8')).toBe('owned');
  });
});
