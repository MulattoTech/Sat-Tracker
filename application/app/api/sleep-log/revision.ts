import { createHash } from 'node:crypto';
import { Prisma, type SleepLog } from '@prisma/client';

// Use the generated scalar inventory so new persisted fields cannot silently
// disappear from either the client revision or the transactional write claim.
const fields = Object.values(Prisma.SleepLogScalarFieldEnum).sort();

/** An opaque content revision also observes hook and bulk edits whose clocks
 * may share a millisecond. It is a precondition, never an authorization token. */
export function sleepRevision(row: SleepLog): string {
  return createHash('sha256').update(JSON.stringify(fields.map(field => {
    const value = row[field];
    return [field, value instanceof Date ? value.toISOString() : value];
  }))).digest('hex');
}

export function sleepSnapshot(row: SleepLog): Prisma.SleepLogWhereInput {
  return Object.fromEntries(fields.map(field => [field, row[field]]));
}
