import { careFields, CareWriteError, readCareWrite } from '@/app/api/utils/care-write';
import type { DiaperRashObservation } from '@/src/utils/diaperRash';

export const DIAPER_RASH_FIELDS = [
  'rashObserved', 'rashLocation', 'rashDescription', 'rashProductsApplied', 'rashFollowUpNotes',
] as const;
const fields = Object.fromEntries(DIAPER_RASH_FIELDS.map(key => [key, careFields.diaper[key]]));

/** Route allowlists reject other keys; this subset uses canonical scalar rules. */
export async function readHookDiaperRash(body: Record<string, unknown>): Promise<{ data?: DiaperRashObservation; error?: string }> {
  const input = Object.fromEntries(DIAPER_RASH_FIELDS.filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
  try {
    return { data: await readCareWrite<DiaperRashObservation>({ json: async () => input }, fields) };
  } catch (error) {
    if (error instanceof CareWriteError) return { error: error.message };
    throw error;
  }
}

export function hookDiaperRashDetails(row: DiaperRashObservation) {
  return {
    rashObserved: row.rashObserved ?? null,
    rashLocation: row.rashLocation ?? null,
    rashDescription: row.rashDescription ?? null,
    rashProductsApplied: row.rashProductsApplied ?? null,
    rashFollowUpNotes: row.rashFollowUpNotes ?? null,
  };
}
