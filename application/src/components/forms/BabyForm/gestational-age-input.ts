import { isValidGestationalAgeDays } from '@/src/utils/childAge';

export interface GestationalAgeInput {
  weeks: string;
  days: string;
}

export type ParsedGestationalAge =
  | { valid: true; value: number | null }
  | { valid: false };

export function parseGestationalAgeInput({ weeks, days }: GestationalAgeInput): ParsedGestationalAge {
  const wholeWeeks = weeks.trim();
  const additionalDays = days.trim();
  if (!wholeWeeks && !additionalDays) return { valid: true, value: null };
  if (!/^\d+$/.test(wholeWeeks) || (additionalDays && !/^\d+$/.test(additionalDays))) {
    return { valid: false };
  }
  const remainder = additionalDays ? Number(additionalDays) : 0;
  const total = Number(wholeWeeks) * 7 + remainder;
  return remainder <= 6 && isValidGestationalAgeDays(total)
    ? { valid: true, value: total }
    : { valid: false };
}

export function gestationalAgeToInput(value?: number | null): GestationalAgeInput {
  return value == null
    ? { weeks: '', days: '' }
    : { weeks: String(Math.floor(value / 7)), days: String(value % 7) };
}
