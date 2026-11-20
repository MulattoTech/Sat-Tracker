import { NextResponse } from 'next/server';
import type { Prisma, PrismaClient } from '@prisma/client';
import { lockPhotoFamilyRow } from '../../../scripts/photo-integrity-lock';

export class PhotoIntegrityError extends Error {
  constructor(message: string, readonly status = 409, readonly code = 'PHOTO_LINK_CONFLICT') { super(message); }
  response() { return NextResponse.json({ success: false, error: this.message, code: this.code }, { status: this.status }); }
}

/** Authentication supplies the family; never allow an undefined Prisma filter. */
export function requirePhotoFamily(familyId: unknown): asserts familyId is string {
  if (typeof familyId !== 'string' || !familyId.trim()) {
    throw new PhotoIntegrityError('A family is required to access photos.', 403, 'PHOTO_FAMILY_REQUIRED');
  }
}

/** Must be the first statement in a participating transaction. */
export async function lockPhotoFamily(tx: Prisma.TransactionClient, familyId: string) {
  requirePhotoFamily(familyId);
  if (await lockPhotoFamilyRow(tx, familyId) !== 1) {
    throw new PhotoIntegrityError('Family not found.', 404, 'PHOTO_FAMILY_MISSING');
  }
}

function databaseCodes(error: unknown, depth = 0, seen = new Set<unknown>()): Set<string> {
  const codes = new Set<string>();
  if (!error || typeof error !== 'object' || depth > 5 || seen.has(error)) return codes;
  seen.add(error);
  const value = error as Record<string, unknown>;
  for (const key of ['code', 'originalCode', 'sqlState']) {
    if (typeof value[key] === 'string' || typeof value[key] === 'number') codes.add(String(value[key]));
  }
  for (const key of ['cause', 'meta', 'driverAdapterError']) {
    for (const code of databaseCodes(value[key], depth + 1, seen)) codes.add(code);
  }
  return codes;
}

/** Small DB-only operations share a family-first lock across processes/providers.
 * Ownership, target liveness, capacity and the final mutation are all re-read
 * after acquiring it. File IO, notifications and response work stay outside.
 * Only confirmed-aborted conflicts, or BUSY before the callback starts, retry;
 * timeouts/connection failures must never replay an uncertain committed write. */
export async function withPhotoIntegrity<T>(
  db: PrismaClient,
  familyId: string,
  action: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  requirePhotoFamily(familyId);
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    let locked = false;
    try {
      return await db.$transaction(async tx => {
        await lockPhotoFamily(tx, familyId);
        locked = true;
        return action(tx);
      }, { maxWait: 5_000, timeout: 15_000 });
    } catch (error) {
      const codes = databaseCodes(error);
      const aborted = ['P2034', '40001', '40P01'].some(code => codes.has(code));
      const busy = ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED', '5', '6', '517'].some(code => codes.has(code));
      const uncertain = codes.has('P2028') || codes.has('P1008');
      if (!uncertain && (aborted || (!locked && busy)) && attempt < 2 && Date.now() - started < 8_000) {
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
        continue;
      }
      if (aborted || busy || uncertain) {
        throw new PhotoIntegrityError('Another photo or care change is being saved. Review the entry and retry.', 409, 'PHOTO_LINK_BUSY');
      }
      throw error;
    }
  }
}
