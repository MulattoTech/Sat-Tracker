import { NextRequest, NextResponse } from 'next/server';
import prisma from '../db';
import { withSysAdminAuth } from './auth';
import { decrypt, isEncrypted } from './encryption';
import { getClientInfo } from './api-logger';
import { checkIpLockout, recordFailedAttempt, resetFailedAttempts } from './ip-lockout';
import { equalSecret, readBoundedBody, recoveryResponse } from './recovery-http';
import { RecoveryError } from '@/src/lib/portable-recovery/types';

async function verifyCurrentOwnerPassword(request: NextRequest): Promise<void> {
  const configs = await prisma.appConfig.findMany({ take: 2, select: { adminPass: true } });
  if (configs.length !== 1 || !configs[0].adminPass?.trim()) {
    throw new RecoveryError('OWNER_NOT_CONFIGURED', 'Configure a nondefault installation administrator password before creating a complete backup.', 403);
  }
  const current = isEncrypted(configs[0].adminPass) ? decrypt(configs[0].adminPass) : configs[0].adminPass;
  if (!current.trim() || current === 'admin') {
    throw new RecoveryError('OWNER_NOT_CONFIGURED', 'Configure a nondefault installation administrator password before creating a complete backup.', 403);
  }
  const lockoutKey = 'portable-backup:' + getClientInfo(request).ip;
  if (checkIpLockout(lockoutKey).locked) {
    throw new RecoveryError('OWNER_PASSWORD_LOCKED', 'Too many incorrect administrator passwords. Try again in five minutes.', 429);
  }
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new RecoveryError('OWNER_PASSWORD_REQUIRED', 'Enter the current installation administrator password.');
  }
  let body: unknown;
  try { body = JSON.parse((await readBoundedBody(request, 16 * 1024)).toString('utf8')); }
  catch (error) {
    if (error instanceof RecoveryError) throw error;
    throw new RecoveryError('INVALID_PASSWORD_REQUEST', 'Enter the current installation administrator password.');
  }
  const password = typeof body === 'object' && body !== null && !Array.isArray(body) &&
    Object.keys(body).length === 1 && 'password' in body ? body.password : null;
  if (typeof password !== 'string' || !password || password.length > 1024 || !equalSecret(password, current)) {
    recordFailedAttempt(lockoutKey);
    throw new RecoveryError('OWNER_PASSWORD_INCORRECT', 'The installation administrator password is incorrect.', 401);
  }
  resetFailedAttempts(lockoutKey);
}

/** Central JWT middleware supplies installation authority; fresh password proves current ownership. */
export function withInstallationOwner(handler: () => Promise<NextResponse<any>>) {
  const authorized = withSysAdminAuth(async (request: NextRequest) => {
    // Return the typed denial inside the central audit wrapper so its recorded
    // status is the actual 400/401/403/429, rather than an unhandled-error 500.
    return await recoveryResponse(async () => {
      await verifyCurrentOwnerPassword(request);
      return handler();
    }) as NextResponse<any>;
  });
  return (request: NextRequest) => recoveryResponse(async () => {
    if (process.env.SAT_TRACKER_RECOVERY_MODE === '1') {
      throw new RecoveryError('SOURCE_BACKUP_UNAVAILABLE', 'Backups are unavailable on an isolated recovery instance.', 404);
    }
    return authorized(request);
  });
}

/** Legacy URLs retain authorization checks but can never mutate a database or environment. */
export function retiredDatabaseRoute(request: NextRequest): Promise<Response> {
  return recoveryResponse(() => withSysAdminAuth(async () => NextResponse.json({
    success: false,
    code: 'LEGACY_DATABASE_OPERATION_RETIRED',
    error: 'Use complete backups and an isolated empty recovery destination. Live database replacement and web migrations are unavailable.',
  }, { status: 410 }))(request));
}
