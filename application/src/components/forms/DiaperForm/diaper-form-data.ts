import { DIAPER_RASH_TEXT_FIELDS, type DiaperRashObservation } from '@/src/utils/diaperRash';

export type DiaperRashDraft = {
  rashObserved: boolean | null;
  rashLocation: string;
  rashDescription: string;
  rashProductsApplied: string;
  rashFollowUpNotes: string;
};
export type DiaperRashTouched = Partial<Record<keyof DiaperRashDraft, boolean>>;

export function diaperRashToDraft(observation: DiaperRashObservation = {}): DiaperRashDraft {
  return {
    rashObserved: observation.rashObserved ?? null,
    rashLocation: observation.rashLocation ?? '',
    rashDescription: observation.rashDescription ?? '',
    rashProductsApplied: observation.rashProductsApplied ?? '',
    rashFollowUpNotes: observation.rashFollowUpNotes ?? '',
  };
}

/** Untouched fields stay omitted, even if an old cached activity lacked them. */
export function buildDiaperRashPayload(draft: DiaperRashDraft, touched: DiaperRashTouched): DiaperRashObservation {
  const payload: DiaperRashObservation = {};
  if (touched.rashObserved) payload.rashObserved = draft.rashObserved;
  for (const { key } of DIAPER_RASH_TEXT_FIELDS) {
    if (touched[key]) payload[key] = draft[key].trim() ? draft[key] : null;
  }
  return payload;
}

export function getInvalidDiaperRashField(draft: DiaperRashDraft, touched: DiaperRashTouched) {
  return DIAPER_RASH_TEXT_FIELDS.find(({ key, maxLength }) => touched[key] && draft[key].length > maxLength)?.key;
}

/** The picker edits minutes. Reselecting that minute must not erase stored seconds/ms. */
export function buildDiaperTimePayload(selected: Date, originalTime?: string): { time?: string } {
  const selectedMs = selected.getTime();
  if (!Number.isFinite(selectedMs)) throw new Error('Invalid diaper time');
  if (originalTime && Math.floor(new Date(originalTime).getTime() / 60_000) === Math.floor(selectedMs / 60_000)) {
    return {};
  }
  return { time: selected.toISOString() };
}
