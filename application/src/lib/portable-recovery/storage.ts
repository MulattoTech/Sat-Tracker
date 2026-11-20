import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertPortablePath, authenticateMedia } from './media-inventory';
import type { VerifiedMedia } from './media-types';
import type { RecoveryConfiguration } from './configuration';
import { assertSourceKey } from './crypto';
import { RecoveryError, type RecoveryReceipt } from './types';

const exists = async (target: string) => fs.lstat(target).then(() => true, error => {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
  throw error;
});

/** Refuse symlink traversal even for operator-configured roots. No archive path reaches this helper unchecked. */
export async function assertDirectoryChain(target: string, allowMissing = false): Promise<void> {
  const absolute = path.resolve(target), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const piece of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, piece);
    const stat = await fs.lstat(current).catch(error => {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new RecoveryError('UNSAFE_DESTINATION_PATH', 'Recovery directories must be real, separate directories.', 409);
    }
  }
}

export async function assertEmptyMediaRoot(root: string): Promise<void> {
  await assertDirectoryChain(root, true);
  if (await exists(root) && (await fs.readdir(root)).length !== 0) {
    throw new RecoveryError('DESTINATION_NOT_EMPTY', 'The destination media directory is not empty.', 409);
  }
}

export interface RecoveryInstance {
  version: 1;
  instanceId: string;
  binding: string;
  tokenHash: string;
  createdAt: string;
}

export async function readRecoveryInstance(config: RecoveryConfiguration): Promise<RecoveryInstance> {
  await assertDirectoryChain(config.stateDir);
  if (process.platform !== 'win32' && ((await fs.stat(config.stateDir)).mode & 0o077) !== 0) {
    throw new RecoveryError('PRIVATE_STATE_REQUIRED', 'The recovery state directory must be accessible only by its owner.', 409);
  }
  const marker = path.join(config.stateDir, 'instance.json');
  const handle = await fs.open(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096) throw new Error('Invalid marker');
    const value: RecoveryInstance = JSON.parse(await handle.readFile('utf8'));
    if (value.version !== 1 || value.binding !== config.binding || value.tokenHash !== config.tokenHash ||
      typeof value.instanceId !== 'string' || !/^[a-f\d-]{36}$/i.test(value.instanceId)) throw new Error('Marker mismatch');
    return value;
  } catch {
    throw new RecoveryError('RECOVERY_INSTANCE_MISMATCH', 'The recovery state does not belong to this destination and bootstrap capability.', 409);
  } finally { await handle.close(); }
}

/** Called only by guarded startup after database and media emptiness have been established. */
export async function initializeRecoveryInstance(config: RecoveryConfiguration): Promise<RecoveryInstance> {
  await assertDirectoryChain(config.stateDir, true);
  if (await exists(config.stateDir)) {
    const entries = await fs.readdir(config.stateDir);
    if (entries.includes('instance.json')) return readRecoveryInstance(config);
    if (entries.length) throw new RecoveryError('RECOVERY_STATE_NOT_EMPTY', 'Use an empty private recovery state directory.', 409);
  }
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  await assertDirectoryChain(config.stateDir);
  // Fresh Docker volume roots commonly start as 0755. Only an empty, explicitly
  // selected state directory reaches here; make it private before writing anything.
  if (process.platform !== 'win32') await fs.chmod(config.stateDir, 0o700);
  const instance: RecoveryInstance = { version: 1, instanceId: randomUUID(), binding: config.binding,
    tokenHash: config.tokenHash, createdAt: new Date().toISOString() };
  await fs.writeFile(path.join(config.stateDir, 'instance.json'), JSON.stringify(instance) + '\n', { flag: 'wx', mode: 0o600 });
  await flushFile(path.join(config.stateDir, 'instance.json'));
  await flushDirectory(config.stateDir); await flushDirectory(path.dirname(config.stateDir));
  return instance;
}

export async function recoveryStateFiles(config: RecoveryConfiguration): Promise<string[]> {
  await readRecoveryInstance(config);
  return (await fs.readdir(config.stateDir)).filter(name => name !== 'instance.json');
}

export async function readRecoveryReceipt(config: RecoveryConfiguration): Promise<RecoveryReceipt | null> {
  const file = path.join(config.stateDir, 'receipt.json');
  if (!await exists(file)) return null;
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid receipt');
    const value = JSON.parse(await handle.readFile('utf8'));
    const instance = await readRecoveryInstance(config);
    const receipt = value.receipt as RecoveryReceipt;
    if (value.version !== 1 || value.binding !== config.binding || value.instanceId !== instance.instanceId ||
      !receipt || receipt.status !== 'RECOVERED' || receipt.verified !== true || receipt.activationRequired !== true ||
      receipt.destinationProvider !== config.provider || !/^[a-f\d]{64}$/.test(receipt.archiveSha256) ||
      !Number.isInteger(receipt.recordsRestored) || receipt.recordsRestored < 0 || !Number.isInteger(receipt.filesRestored) || receipt.filesRestored < 0) throw new Error('Invalid receipt');
    return receipt;
  } catch { throw new RecoveryError('INVALID_RECOVERY_RECEIPT', 'Recovery needs an operator review of its retained state.', 409); }
  finally { await handle.close(); }
}

/** Never source the saved recovery environment through a shell. Read and validate one private key line. */
export async function readRecoveredSourceKey(config: RecoveryConfiguration): Promise<string> {
  await readRecoveryInstance(config);
  const filename = path.join(config.stateDir, 'recovery.env');
  let handle;
  try {
    handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 128 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      throw new Error('Unsafe key file');
    }
    const contents = await handle.readFile('utf8');
    const match = /^ENC_HASH="([a-fA-F0-9]{64})"\n$/.exec(contents);
    if (!match) throw new Error('Invalid key file');
    return match[1];
  } catch {
    throw new RecoveryError('RECOVERY_KEY_UNTRUSTED', 'The private recovered key must be reviewed before restart.', 409);
  } finally {
    await handle?.close();
  }
}

interface OwnedFile { path: string; sha256: string; dev: number; ino: number }
async function flushFile(filename: string): Promise<void> {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function flushDirectory(directory: string): Promise<void> {
  // Windows does not expose directory fsync through Node. File flushes still apply.
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
export interface RecoveryPublication {
  stage: string;
  publish(): Promise<void>;
  finish(receipt: RecoveryReceipt): Promise<void>;
  cleanup(rollbackVerified: boolean): Promise<void>;
}

/** Filesystem publication is journaled and remains inaccessible behind recovery mode. It is not a live atomic cutover. */
export async function stageRecoveryPublication(
  config: RecoveryConfiguration, media: readonly VerifiedMedia[], exactKey: string, archiveSha256: string,
): Promise<RecoveryPublication> {
  assertSourceKey(exactKey);
  await readRecoveryInstance(config);
  if ((await recoveryStateFiles(config)).length) throw new RecoveryError('RECOVERY_ALREADY_STARTED', 'This destination already has recovery state. Review it before continuing.', 409);
  const lock = path.join(config.stateDir, 'operation.lock');
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch { throw new RecoveryError('RECOVERY_BUSY', 'Another recovery operation owns this destination.', 409); }
  const stage = path.join(config.stateDir, 'stage-' + randomUUID());
  const files: OwnedFile[] = [], directories: string[] = [];
  let stageCreated = false, finished = false;
  const recordFile = async (filename: string, sha256: string) => {
    const stat = await fs.lstat(filename);
    files.push({ path: filename, sha256, dev: stat.dev, ino: stat.ino });
  };
  const makeParents = async (directory: string) => {
    await assertDirectoryChain(directory, true);
    const missing: string[] = [];
    for (let current = directory; !await exists(current); current = path.dirname(current)) missing.push(current);
    for (const current of missing.reverse()) { await fs.mkdir(current, { mode: 0o700 }); directories.push(current); }
    await assertDirectoryChain(directory);
  };
  const cleanup = async (rollbackVerified: boolean) => {
    if (finished) return;
    if (!rollbackVerified) {
      // finish may have removed the lock before a final filesystem error. Recreate
      // a visible blocking marker instead of allowing receipt+key to look complete.
      await fs.mkdir(lock, { recursive: true, mode: 0o700 });
      await assertDirectoryChain(lock);
      await fs.writeFile(path.join(lock, 'outcome-unknown'), 'Operator verification required before any retry.\n', { flag: 'wx', mode: 0o600 }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
      await flushFile(path.join(lock, 'outcome-unknown')); await flushDirectory(lock); await flushDirectory(config.stateDir);
      return;
    }
    for (const file of [...files].reverse()) {
      const handle = await fs.open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        const hash = createHash('sha256').update(await handle.readFile()).digest('hex');
        if (stat.dev !== file.dev || stat.ino !== file.ino || hash !== file.sha256) throw new RecoveryError('RECOVERY_CLEANUP_CONFLICT', 'An owned recovery file changed; operator review is required.', 409);
      } finally { await handle.close(); }
      await fs.unlink(file.path);
    }
    for (const directory of [...directories].reverse()) await fs.rmdir(directory);
    if (stageCreated) await fs.rm(stage, { recursive: true });
    await fs.rm(lock, { recursive: true });
  };
  try {
    await fs.mkdir(stage, { mode: 0o700 }); stageCreated = true;
    for (const item of media) {
      assertPortablePath(item.storagePath);
      const target = path.join(stage, 'Files', ...item.storagePath.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, item.ciphertext, { flag: 'wx', mode: 0o600 });
      const persisted = await fs.readFile(target);
      if (persisted.length !== item.byteLength || createHash('sha256').update(persisted).digest('hex') !== item.sha256.replace(/^sha256:/, '')) {
        throw new RecoveryError('STAGED_MEDIA_MISMATCH', 'A staged media file did not match its verified archive.', 409);
      }
      authenticateMedia(persisted, item, exactKey);
    }
    await fs.writeFile(path.join(lock, 'journal.json'), JSON.stringify({ version: 1, binding: config.binding, archiveSha256,
      stage: path.basename(stage), mediaPaths: media.map(item => item.storagePath) }) + '\n', { flag: 'wx', mode: 0o600 });
    await flushFile(path.join(lock, 'journal.json')); await flushDirectory(lock); await flushDirectory(config.stateDir);
    return {
      stage,
      async publish() {
        await assertEmptyMediaRoot(config.filesRoot);
        for (const item of media) {
          const target = path.join(config.filesRoot, ...item.storagePath.split('/'));
          await makeParents(path.dirname(target));
          await fs.copyFile(path.join(stage, 'Files', ...item.storagePath.split('/')), target, constants.COPYFILE_EXCL);
          await recordFile(target, item.sha256.replace(/^sha256:/, ''));
          const persisted = await fs.readFile(target);
          authenticateMedia(persisted, item, exactKey);
          if (createHash('sha256').update(persisted).digest('hex') !== item.sha256.replace(/^sha256:/, '')) throw new RecoveryError('PUBLISHED_MEDIA_MISMATCH', 'A recovered media file failed verification.', 409);
          await flushFile(target);
        }
        const env = Buffer.from(`ENC_HASH="${exactKey}"\n`, 'utf8');
        const filename = path.join(config.stateDir, 'recovery.env');
        await fs.writeFile(filename, env, { flag: 'wx', mode: 0o600 });
        await recordFile(filename, createHash('sha256').update(env).digest('hex'));
        await flushFile(filename);
        const durableDirectories = new Set([...directories].reverse().flatMap(directory => [directory, path.dirname(directory)]));
        for (const directory of durableDirectories) await flushDirectory(directory);
        if (await exists(config.filesRoot)) await flushDirectory(config.filesRoot);
        await flushDirectory(config.stateDir);
      },
      async finish(receipt) {
        const instance = await readRecoveryInstance(config);
        const temporary = path.join(stage, 'receipt.json');
        await fs.writeFile(temporary, JSON.stringify({ version: 1, binding: config.binding, instanceId: instance.instanceId, receipt }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        await fs.copyFile(temporary, path.join(config.stateDir, 'receipt.json'), constants.COPYFILE_EXCL);
        await flushFile(path.join(config.stateDir, 'receipt.json')); await flushDirectory(config.stateDir);
        await fs.rm(stage, { recursive: true });
        await fs.rm(lock, { recursive: true });
        await flushDirectory(config.stateDir);
        finished = true;
      },
      cleanup,
    };
  } catch (error) { await cleanup(true); throw error; }
}
