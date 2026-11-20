import { describe, expect, it } from 'vitest';
import { calculateChildAge, isValidGestationalAgeDays, MAX_GESTATIONAL_AGE_DAYS } from '../src/utils/childAge';

const age = (birthDate: string, asOf: string, gestationalAgeDays?: number | null, timeZone = 'UTC') =>
  calculateChildAge({ birthDate, asOf, gestationalAgeDays, timeZone });

describe('recorded gestational age validation', () => {
  it.each([1, 224, 235, 258, 259, 280, 315])('accepts whole-day input %s', value => {
    expect(isValidGestationalAgeDays(value)).toBe(true);
  });
  it.each([undefined, null, 0, -1, 316, 231.5, NaN, Infinity, '231', true, {}, []])('rejects noncanonical input %s', value => {
    expect(isValidGestationalAgeDays(value)).toBe(false);
  });
  it('keeps the product input ceiling separate from the preterm threshold', () => {
    expect(MAX_GESTATIONAL_AGE_DAYS).toBe(315);
    expect(age('2024-01-01', '2024-03-11', 315)).toMatchObject({ correction: { status: 'not-applicable' } });
  });
});

describe('shared chronological and corrected calendar age', () => {
  it('matches the published 32-week, 16-week-chronological example', () => {
    expect(age('2024-01-01', '2024-04-22', 224)).toMatchObject({
      status: 'valid', chronological: { days: 112, weeks: 16 },
      correction: { status: 'corrected', estimatedDueDate: '2024-02-26', age: { days: 56, weeks: 8, daysAfterWeeks: 0 } },
    });
  });
  it('retains gestational days rather than rounding to completed weeks', () => {
    expect(age('2024-01-01', '2024-03-11', 235)).toMatchObject({
      chronological: { days: 70, weeks: 10 },
      correction: { status: 'corrected', estimatedDueDate: '2024-02-15', age: { days: 25, weeks: 3, daysAfterWeeks: 4 } },
    });
  });
  it.each([undefined, null])('treats absent gestation %s as unknown, not term', gestation => {
    expect(age('2024-01-01', '2024-01-29', gestation)).toMatchObject({
      status: 'valid', chronological: { days: 28 }, correction: { status: 'unknown' },
    });
  });
  it('distinguishes 36 weeks 6 days from 37 completed weeks', () => {
    expect(age('2024-01-01', '2024-01-29', 258)).toMatchObject({ correction: { status: 'corrected', age: { days: 6 } } });
    for (const gestation of [259, 266, 273, 280]) {
      expect(age('2024-01-01', '2024-01-29', gestation)).toMatchObject({ correction: { status: 'not-applicable' } });
    }
  });
  it('preserves a before-due-date state instead of clamping it to zero age', () => {
    expect(age('2024-01-01', '2024-02-01', 224)).toMatchObject({
      chronological: { days: 31 }, correction: { status: 'before-due-date', estimatedDueDate: '2024-02-26', daysUntilDue: 25 },
    });
  });
  it('returns zero corrected days on the derived due date', () => {
    expect(age('2024-01-01', '2024-02-26', 224)).toMatchObject({
      correction: { status: 'corrected', age: { days: 0, weeks: 0, months: 0, years: 0 } },
    });
  });
  it('supports historical as-of dates without a two-year storage cutoff', () => {
    expect(age('2021-01-01', '2024-01-01', 224)).toMatchObject({
      chronological: { days: 1095, years: 3 }, correction: { status: 'corrected', age: { days: 1039 } },
    });
  });
  it.each([
    ['2024-01-31', '2024-02-28', 28, 0, 28],
    ['2024-01-31', '2024-02-29', 29, 1, 0],
    ['2024-01-31', '2024-03-30', 59, 1, 30],
    ['2024-01-31', '2024-03-31', 60, 2, 0],
    ['2024-02-29', '2025-02-28', 365, 12, 0],
    ['2024-12-31', '2025-01-31', 31, 1, 0],
  ])('uses clamped calendar anniversaries from %s to %s', (birth, asOf, days, months, daysAfterMonths) => {
    expect(age(birth, asOf)).toMatchObject({
      chronological: { days, months, daysAfterMonths, years: Math.floor(months / 12), monthsAfterYears: months % 12 },
    });
  });
  it('counts local calendar days across spring-forward rather than 24-hour blocks', () => {
    expect(age('2024-03-09T17:00:00Z', '2024-03-11T16:00:00Z', null, 'America/Chicago')).toMatchObject({ chronological: { days: 2 } });
  });
  it('counts local calendar days across fall-back', () => {
    expect(age('2024-11-02T16:00:00Z', '2024-11-04T17:00:00Z', null, 'America/Chicago')).toMatchObject({ chronological: { days: 2 } });
  });
  it('changes the displayed day at the requested timezone midnight', () => {
    const birth = '2024-03-10T05:59:00Z';
    const asOf = '2024-03-10T06:00:00Z';
    expect(age(birth, asOf, null, 'America/Chicago')).toMatchObject({ chronological: { days: 1 } });
    expect(age(birth, asOf, null, 'UTC')).toMatchObject({ chronological: { days: 0 } });
  });
  it('treats date-only values as literal calendar dates in any display timezone', () => {
    expect(age('2024-01-01', '2024-01-02', null, 'Pacific/Honolulu')).toMatchObject({ chronological: { days: 1 } });
  });
  it('is stable under host timezone changes and leaves Date inputs untouched', () => {
    const birthDate = new Date('2024-03-09T17:00:00.123Z');
    const asOf = new Date('2024-03-11T16:00:00.456Z');
    const before = [birthDate.getTime(), asOf.getTime()];
    const original = process.env.TZ;
    try {
      const outputs = ['UTC', 'Pacific/Honolulu', 'Asia/Tokyo'].map(hostTimezone => {
        process.env.TZ = hostTimezone;
        return calculateChildAge({ birthDate, asOf, timeZone: 'America/Chicago', gestationalAgeDays: 224 });
      });
      expect(outputs[1]).toEqual(outputs[0]);
      expect(outputs[2]).toEqual(outputs[0]);
      expect([birthDate.getTime(), asOf.getTime()]).toEqual(before);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
  it.each(['', 'not-a-zone'])('rejects invalid timezone %s', timeZone => {
    expect(age('2024-01-01', '2024-01-29', null, timeZone)).toMatchObject({ status: 'invalid', reason: 'invalid-time-zone' });
  });
  it.each(['', 'not-a-date', '2024-02-30', '2024-02-30T12:00:00Z', '2024-01-01T00:00:00', '2024-01-01T24:00:00Z'])('rejects malformed or ambiguous birth date %s', birthDate => {
    expect(age(birthDate, '2024-04-01')).toMatchObject({ status: 'invalid', reason: 'invalid-birth-date' });
  });
  it('rejects an invalid as-of value and a reference date before birth', () => {
    expect(age('2024-01-01', 'bad')).toMatchObject({ status: 'invalid', reason: 'invalid-as-of' });
    expect(age('2024-01-02', '2024-01-01')).toMatchObject({ status: 'invalid', reason: 'before-birth' });
  });
  it('rejects an invalid Date instance', () => {
    expect(calculateChildAge({ birthDate: new Date(NaN), asOf: new Date(), timeZone: 'UTC' })).toMatchObject({ status: 'invalid', reason: 'invalid-birth-date' });
  });
  it('does not misread a BCE Date as an AD calendar year', () => {
    expect(calculateChildAge({ birthDate: new Date('0000-01-01T00:00:00Z'), asOf: new Date('2024-01-01T00:00:00Z'), timeZone: 'UTC' })).toMatchObject({ status: 'invalid', reason: 'invalid-birth-date' });
  });
  it.each([0, 316, 231.5, NaN])('does not silently calculate from invalid gestation %s', gestation => {
    expect(age('2024-01-01', '2024-03-11', gestation)).toMatchObject({ status: 'invalid', reason: 'invalid-gestation' });
  });
});
