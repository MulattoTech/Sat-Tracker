import type { AgeSpan } from '@/src/utils/childAge';

type AgeUnit = 'year' | 'month' | 'week' | 'day';

const formatUnits = (parts: [AgeUnit, number][], language: string) => {
  const nonzero = parts.filter(([, value]) => value > 0);
  const visible: [AgeUnit, number][] = nonzero.length ? nonzero : [['day', 0]];
  return new Intl.ListFormat(language, { style: 'short', type: 'unit' }).format(
    visible.map(([unit, value]) => new Intl.NumberFormat(language, {
      style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 0,
    }).format(value)),
  );
};

/** Uses completed calendar months/years supplied by the canonical age helper. */
export function formatChildAgeSpan(age: AgeSpan, language: string): string {
  if (age.months < 6) {
    return formatUnits([['week', age.weeks], ['day', age.daysAfterWeeks]], language);
  }
  if (age.months < 24) {
    return formatUnits([['month', age.months], ['day', age.daysAfterMonths]], language);
  }
  return formatUnits([
    ['year', age.years], ['month', age.monthsAfterYears], ['day', age.daysAfterMonths],
  ], language);
}

export function formatDaysUntilDue(days: number, language: string): string {
  return formatUnits([['week', Math.floor(days / 7)], ['day', days % 7]], language);
}
