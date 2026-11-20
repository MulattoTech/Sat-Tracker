import { createHash, timingSafeEqual } from 'node:crypto';
import { RecoveryError } from './types';

export function equalSecret(left: string, right: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(left), digest(right));
}

/** Lightweight shared capability check; no database, archive, media or auth-session imports. */
export function assertRecoveryToken(request: Pick<Request, 'headers'>): void {
  if (process.env.SAT_TRACKER_RECOVERY_MODE !== '1') {
    throw new RecoveryError('RECOVERY_MODE_REQUIRED', 'Start an isolated recovery instance before restoring a backup.', 404);
  }
  const expected = process.env.SAT_TRACKER_RECOVERY_TOKEN;
  if (!expected || !/^[a-f\d]{64,128}$/i.test(expected)) {
    throw new RecoveryError('BOOTSTRAP_TOKEN_REQUIRED', 'A recovery operator token must be configured.', 503);
  }
  if (!equalSecret(request.headers.get('X-Sat-Recovery-Token') ?? '', expected)) {
    throw new RecoveryError('RECOVERY_UNAUTHORIZED', 'A valid recovery operator token is required.', 401);
  }
}
