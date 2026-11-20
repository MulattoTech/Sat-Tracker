/** Product input ceiling, not a clinical prematurity threshold. Unknown is null. */
export const MAX_GESTATIONAL_AGE_DAYS = 45 * 7;
const PRETERM_BEFORE_DAYS = 37 * 7;
const CORRECTION_ANCHOR_DAYS = 40 * 7;
const DAY_MS = 86_400_000;

export function isValidGestationalAgeDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= 1 && value <= MAX_GESTATIONAL_AGE_DAYS;
}

export interface AgeSpan {
  /** Total completed calendar days, weeks and months. */
  days: number;
  weeks: number;
  daysAfterWeeks: number;
  months: number;
  years: number;
  monthsAfterYears: number;
  daysAfterMonths: number;
}

export type ChildAgeResult =
  | { status: 'invalid'; reason: 'invalid-time-zone' | 'invalid-birth-date' | 'invalid-as-of' | 'before-birth' | 'invalid-gestation' }
  | {
    status: 'valid';
    chronological: AgeSpan;
    correction:
      | { status: 'unknown' }
      | { status: 'not-applicable' }
      | { status: 'before-due-date'; estimatedDueDate: string; daysUntilDue: number }
      | { status: 'corrected'; estimatedDueDate: string; age: AgeSpan };
  };

/** An integer day is a calendar coordinate, never an elapsed 24-hour interval. */
function parseDateKey(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return null;
  const millis = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== value) return null;
  return millis / DAY_MS;
}

function calendarDay(value: Date | string, formatter: Intl.DateTimeFormat): number | null {
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return parseDateKey(value);
    // Reject ambiguous local timestamps and impossible dates before Date can normalize them.
    const instant = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
    if (!instant.test(value) || parseDateKey(value.slice(0, 10)) === null) return null;
  } else if (!(value instanceof Date)) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = formatter.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? '';
  if (part('era') !== 'AD') return null;
  return parseDateKey(`${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`);
}

function utcDay(year: number, month: number, day: number): number {
  const value = new Date(0);
  value.setUTCFullYear(year, month, day);
  return value.getTime() / DAY_MS;
}

function monthAnniversary(start: Date, months: number): number {
  const index = start.getUTCMonth() + months;
  const year = start.getUTCFullYear() + Math.floor(index / 12);
  const month = index % 12;
  const lastDay = new Date(utcDay(year, month + 1, 0) * DAY_MS).getUTCDate();
  return utcDay(year, month, Math.min(start.getUTCDate(), lastDay));
}

function span(startDay: number, endDay: number): AgeSpan {
  const start = new Date(startDay * DAY_MS);
  const end = new Date(endDay * DAY_MS);
  const days = endDay - startDay;
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
  if (monthAnniversary(start, months) > endDay) months -= 1;
  return {
    days, weeks: Math.floor(days / 7), daysAfterWeeks: days % 7,
    months, years: Math.floor(months / 12), monthsAfterYears: months % 12,
    daysAfterMonths: endDay - monthAnniversary(start, months),
  };
}

/**
 * Daily age in one explicit display timezone; inputs are never changed.
 * Date/offset-ISO inputs preserve existing instants and use their local date in
 * that zone. YYYY-MM-DD inputs are literal calendar dates. Month anniversaries
 * clamp to the target month's final day (including February 29 in other years).
 *
 * Corrected age follows the AAP 40-week calculation for WHO-defined preterm
 * births (<37 completed weeks). This is an age display, not a developmental
 * assessment; no automatic two-year cutoff, growth reindexing or care advice.
 * References and compatibility policy: documentation/Architecture-Documentation/ChildAge.md.
 */
export function calculateChildAge({ birthDate, gestationalAgeDays, asOf, timeZone }: {
  birthDate: Date | string;
  gestationalAgeDays?: number | null;
  asOf: Date | string;
  timeZone: string;
}): ChildAgeResult {
  let formatter: Intl.DateTimeFormat;
  try {
    if (typeof timeZone !== 'string' || !timeZone || /^[+-]/.test(timeZone)) throw new RangeError('Missing IANA timezone');
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, calendar: 'gregory', numberingSystem: 'latn', era: 'short', year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    return { status: 'invalid', reason: 'invalid-time-zone' };
  }
  const birthDay = calendarDay(birthDate, formatter);
  if (birthDay === null) return { status: 'invalid', reason: 'invalid-birth-date' };
  const asOfDay = calendarDay(asOf, formatter);
  if (asOfDay === null) return { status: 'invalid', reason: 'invalid-as-of' };
  if (asOfDay < birthDay) return { status: 'invalid', reason: 'before-birth' };
  const chronological = span(birthDay, asOfDay);
  if (gestationalAgeDays == null) return { status: 'valid', chronological, correction: { status: 'unknown' } };
  if (!isValidGestationalAgeDays(gestationalAgeDays)) return { status: 'invalid', reason: 'invalid-gestation' };
  if (gestationalAgeDays >= PRETERM_BEFORE_DAYS) return { status: 'valid', chronological, correction: { status: 'not-applicable' } };
  const dueDay = birthDay + CORRECTION_ANCHOR_DAYS - gestationalAgeDays;
  const estimatedDueDate = new Date(dueDay * DAY_MS).toISOString().slice(0, 10);
  if (parseDateKey(estimatedDueDate) === null) return { status: 'invalid', reason: 'invalid-birth-date' };
  return {
    status: 'valid', chronological,
    correction: asOfDay < dueDay
      ? { status: 'before-due-date', estimatedDueDate, daysUntilDue: dueDay - asOfDay }
      : { status: 'corrected', estimatedDueDate, age: span(dueDay, asOfDay) },
  };
}
