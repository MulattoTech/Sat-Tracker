import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';

export type RevisionModel = 'diaper' | 'food' | 'feed' | 'pump';
const fields = {
  diaper: Object.values(Prisma.DiaperLogScalarFieldEnum).sort(),
  food: Object.values(Prisma.FoodLogScalarFieldEnum).sort(),
  feed: Object.values(Prisma.FeedLogScalarFieldEnum).sort(),
  pump: Object.values(Prisma.PumpLogScalarFieldEnum).sort(),
};

// These fields were added nullable, without backfill. An unchanged pre-upgrade
// diaper must still match its saved v1 Undo. Only null/absent values are omitted
// from the hash; false and every recorded text value remain revision-bearing.
// The atomic mutation snapshot below always includes ALL generated scalars.
const nullableDiaperAdditions = new Set<string>([
  'rashObserved', 'rashLocation', 'rashDescription', 'rashProductsApplied', 'rashFollowUpNotes',
]);

/** Generated scalar inventories keep new persisted fields in both the revision
 * and atomic claim. A revision is a precondition, not an authorization token. */
export function careSnapshot(model: RevisionModel, row: object): Record<string, unknown> {
  const values = row as Record<string, unknown>;
  return Object.fromEntries(fields[model].map(field => [field, values[field]]));
}

export function careRevision(model: RevisionModel, row: object): string {
  const entries = Object.entries(careSnapshot(model, row)).filter(([key, value]) =>
    !(model === 'diaper' && nullableDiaperAdditions.has(key) && value == null));
  return createHash('sha256').update(JSON.stringify(entries.map(([key, value]) =>
    [key, value instanceof Date ? value.toISOString() : value]))).digest('hex');
}
