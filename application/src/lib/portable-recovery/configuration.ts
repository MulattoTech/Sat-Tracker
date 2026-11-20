import { createHash } from 'node:crypto';
import path from 'node:path';
import { RecoveryError, type RecoveryProvider } from './types';

export interface RecoveryConfiguration {
  provider: RecoveryProvider;
  databaseUrl: string;
  databasePath?: string;
  databaseName?: string;
  databaseSchema?: string;
  filesRoot: string;
  stateDir: string;
  tokenHash: string;
  binding: string;
}

export const hashText = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
export function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

/** All paths are explicit operator settings. Request/archive values cannot select a destination. */
export function recoveryConfiguration(env: Readonly<Record<string, string | undefined>> = process.env, cwd = process.cwd()): RecoveryConfiguration {
  if (env.SAT_TRACKER_RECOVERY_MODE !== '1') {
    throw new RecoveryError('RECOVERY_MODE_REQUIRED', 'Start an isolated recovery instance before restoring a backup.', 403);
  }
  const token = env.SAT_TRACKER_RECOVERY_TOKEN;
  if (!token || !/^[a-f\d]{64,128}$/i.test(token)) {
    throw new RecoveryError('BOOTSTRAP_TOKEN_REQUIRED', 'Recovery requires an explicit operator bootstrap token.', 503);
  }
  const value = env.SAT_TRACKER_RECOVERY_DATABASE_URL;
  const state = env.SAT_TRACKER_RECOVERY_STATE_DIR;
  if (!value || value !== value.trim() || /[\r\n\0]/.test(value) || !state || !path.isAbsolute(state)) {
    throw new RecoveryError('EXPLICIT_DESTINATION_REQUIRED', 'Recovery requires an explicit database and absolute private state directory.', 503);
  }
  const filesRoot = path.resolve(cwd, 'Files'), stateDir = path.resolve(state);
  if (isWithin(filesRoot, stateDir) || isWithin(stateDir, filesRoot)) {
    throw new RecoveryError('OVERLAPPING_DESTINATION', 'Recovery media and private state directories must be separate.', 503);
  }
  let config: RecoveryConfiguration;
  if (value.startsWith('file:')) {
    const filename = value.slice(5);
    if (!filename || !path.isAbsolute(filename) || /[?#\0]/.test(filename)) {
      throw new RecoveryError('INVALID_DATABASE_DESTINATION', 'Recovery requires an absolute SQLite file path.', 503);
    }
    const databasePath = path.resolve(filename);
    if (isWithin(filesRoot, databasePath) || isWithin(stateDir, databasePath)) {
      throw new RecoveryError('OVERLAPPING_DESTINATION', 'The recovery database must be separate from media and private state.', 503);
    }
    config = { provider: 'sqlite', databaseUrl: 'file:' + databasePath, databasePath, filesRoot, stateDir, tokenHash: hashText(token), binding: '' };
  } else {
    let url: URL;
    try { url = new URL(value); } catch { throw new RecoveryError('INVALID_DATABASE_DESTINATION', 'Invalid recovery database configuration.', 503); }
    const schema = url.searchParams.get('schema') ?? 'public';
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !/^\/[A-Za-z0-9_-]+$/.test(url.pathname) ||
      !/^[a-z_][a-z0-9_]*$/.test(schema) || url.hash ||
      [...url.searchParams.keys()].some(key => key !== 'schema' && key !== 'sslmode') ||
      url.searchParams.getAll('schema').length > 1 || url.searchParams.getAll('sslmode').length > 1) {
      throw new RecoveryError('INVALID_DATABASE_DESTINATION', 'Invalid recovery database configuration.', 503);
    }
    config = { provider: 'postgresql', databaseUrl: value, databaseName: url.pathname.slice(1), databaseSchema: schema,
      filesRoot, stateDir, tokenHash: hashText(token), binding: '' };
  }
  config.binding = hashText([config.provider, config.databaseUrl, config.filesRoot, config.stateDir].join('\0'));
  return config;
}

/** The running ORM must use the explicitly guarded destination, never the normal fallback. */
export function assertRunningRecoveryConfiguration(config: RecoveryConfiguration, env: Readonly<Record<string, string | undefined>> = process.env): void {
  if (env.DATABASE_URL !== config.databaseUrl || env.DATABASE_PROVIDER !== config.provider) {
    throw new RecoveryError('RECOVERY_STARTUP_REQUIRED', 'The isolated recovery startup must configure the destination before serving requests.', 503);
  }
  if (env.BABYTRACKER_OCR_FILES_DIR && path.resolve(env.BABYTRACKER_OCR_FILES_DIR) !== path.join(config.filesRoot, 'ocr')) {
    throw new RecoveryError('EXTERNAL_OCR_DESTINATION', 'Recovery requires OCR media inside its isolated media directory.', 503);
  }
}
