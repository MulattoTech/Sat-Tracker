import { describe, expect, it } from 'vitest';
import { calculateChildAge } from '@/src/utils/childAge';
import { formatChildAgeSpan, formatDaysUntilDue } from '@/src/components/ChildAgeDisplay/format';
import { gestationalAgeToInput, parseGestationalAgeInput } from '@/src/components/forms/BabyForm/gestational-age-input';

const ageBetween = (birthDate: string, asOf: string) => {
  const result = calculateChildAge({ birthDate, asOf, timeZone: 'UTC' });
  if (result.status !== 'valid') throw new Error(result.reason);
  return result.chronological;
};

describe('child age presentation', () => {
  it('shows weeks plus the remaining days for a young baby', () => {
    expect(formatChildAgeSpan(ageBetween('2026-01-01', '2026-03-15'), 'en'))
      .toBe('10 wks, 3 days');
  });

  it('changes units at the completed calendar-month anniversary', () => {
    expect(formatChildAgeSpan(ageBetween('2026-01-31', '2026-07-30'), 'en'))
      .toBe('25 wks, 5 days');
    expect(formatChildAgeSpan(ageBetween('2026-01-31', '2026-07-31'), 'en'))
      .toBe('6 mths');
    expect(formatChildAgeSpan(ageBetween('2026-01-31', '2026-08-01'), 'en'))
      .toBe('6 mths, 1 day');
  });

  it('keeps calendar years and residual months/days for older children', () => {
    expect(formatChildAgeSpan(ageBetween('2024-02-29', '2026-02-28'), 'en'))
      .toBe('2 yrs');
    expect(formatChildAgeSpan(ageBetween('2023-01-31', '2026-03-02'), 'en'))
      .toBe('3 yrs, 1 mth, 2 days');
  });

  it('shows zero age and a positive pre-due interval without a negative age', () => {
    expect(formatChildAgeSpan(ageBetween('2026-03-01', '2026-03-01'), 'en')).toBe('0 days');
    expect(formatDaysUntilDue(10, 'en')).toBe('1 wk, 3 days');
  });

  it('localizes units rather than joining translated English plural labels', () => {
    const french = formatChildAgeSpan(ageBetween('2026-01-01', '2026-03-15'), 'fr');
    expect(french).toContain('sem.');
    expect(french).not.toMatch(/wks|days/);
    expect(formatDaysUntilDue(1, 'es')).toBe('1 d');
  });
});

describe('optional gestational weeks and days', () => {
  it.each([
    ['', '', null], [' ', ' ', null], ['33', '', 231], ['33', '4', 235],
    [' 33 ', ' 4 ', 235], ['45', '0', 315], ['0', '1', 1],
  ])('parses weeks %s / days %s without inventing unknown gestation', (weeks, days, value) => {
    expect(parseGestationalAgeInput({ weeks: String(weeks), days: String(days) }))
      .toEqual({ valid: true, value });
  });

  it.each([
    ['46', '0'], ['45', '1'], ['36', '7'], ['34.5', '0'], ['32', '1.5'],
    ['-1', '0'], ['32', '-1'], ['', '3'], ['0', '0'], ['3e1', '0'],
    ['NaN', '0'], ['Infinity', '0'], ['99999999999999999', '0'],
  ])('rejects invalid weeks %s / days %s before a request', (weeks, days) => {
    expect(parseGestationalAgeInput({ weeks, days })).toEqual({ valid: false });
  });

  it('restores saved gestation exactly and leaves legacy unknown values blank', () => {
    expect(gestationalAgeToInput(235)).toEqual({ weeks: '33', days: '4' });
    expect(gestationalAgeToInput(224)).toEqual({ weeks: '32', days: '0' });
    expect(gestationalAgeToInput(null)).toEqual({ weeks: '', days: '' });
    expect(gestationalAgeToInput(undefined)).toEqual({ weeks: '', days: '' });
  });
});
