/** Caregiver observations only. Unknown never implies that a rash was absent. */
export interface DiaperRashObservation {
  rashObserved?: boolean | null;
  rashLocation?: string | null;
  rashDescription?: string | null;
  rashProductsApplied?: string | null;
  rashFollowUpNotes?: string | null;
}

export const DIAPER_RASH_TEXT_LIMITS = {
  rashLocation: 200, rashDescription: 2000, rashProductsApplied: 1000, rashFollowUpNotes: 2000,
} as const;

export const DIAPER_RASH_TEXT_FIELDS = [
  { key: 'rashLocation', label: 'Rash location', maxLength: DIAPER_RASH_TEXT_LIMITS.rashLocation },
  { key: 'rashDescription', label: 'Rash description', maxLength: DIAPER_RASH_TEXT_LIMITS.rashDescription },
  { key: 'rashProductsApplied', label: 'Products applied', maxLength: DIAPER_RASH_TEXT_LIMITS.rashProductsApplied },
  { key: 'rashFollowUpNotes', label: 'Follow-up notes', maxLength: DIAPER_RASH_TEXT_LIMITS.rashFollowUpNotes },
] as const;

type Translate = (key: string) => string;
const identity: Translate = key => key;

export function getDiaperRashStatus(observation: DiaperRashObservation, t: Translate = identity): string {
  return t(observation.rashObserved === true ? 'Rash observed'
    : observation.rashObserved === false ? 'No rash observed' : 'Not recorded');
}

/** Shared by history and exports; caregiver text remains verbatim, including newlines. */
export function getDiaperRashDetails(observation: DiaperRashObservation, t: Translate = identity) {
  const details = [{ label: t('Rash observation'), value: getDiaperRashStatus(observation, t) }];
  for (const field of DIAPER_RASH_TEXT_FIELDS) {
    const value = observation[field.key];
    if (value?.trim()) details.push({ label: t(field.label), value });
  }
  return details;
}

export function getDiaperRashSummary(observation: DiaperRashObservation, t: Translate = identity): string {
  return `${t('Rash observation')}: ${getDiaperRashStatus(observation, t)}`;
}

export function getDiaperRashSearchText(observation: DiaperRashObservation, t: Translate = identity): string {
  return getDiaperRashDetails(observation, t).map(({ label, value }) => `${label}: ${value}`).join('\n');
}
