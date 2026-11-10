import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';

export type RevisionModel = 'diaper' | 'food' | 'feed' | 'pump';
const fields = {
  diaper: Object.values(Prisma.DiaperLogScalarFieldEnum).sort(),
  food: Object.values(Prisma.FoodLogScalarFieldEnum).sort(),
  feed: Object.values(Prisma.FeedLogScalarFieldEnum).sort(),
  pump: Object.values(Prisma.PumpLogScalarFieldEnum).sort(),
};

/** Generated scalar inventories keep new persisted fields in both the revision
 * and atomic claim. A revision is a precondition, not an authorization token. */
export function careSnapshot(model: RevisionModel, row: object): Record<string, unknown> {
  const values = row as Record<string, unknown>;
  return Object.fromEntries(fields[model].map(field => [field, values[field]]));
}

export function careRevision(model: RevisionModel, row: object): string {
  return createHash('sha256').update(JSON.stringify(Object.entries(careSnapshot(model, row)).map(([key, value]) =>
    [key, value instanceof Date ? value.toISOString() : value]))).digest('hex');
}
