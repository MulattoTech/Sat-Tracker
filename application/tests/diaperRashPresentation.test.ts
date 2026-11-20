import { describe, expect, it } from 'vitest';
import {
  getDiaperRashDetails, getDiaperRashSearchText, getDiaperRashSummary,
  DIAPER_RASH_TEXT_LIMITS,
} from '@/src/utils/diaperRash';
import {
  diaperRashToDraft, buildDiaperRashPayload, buildDiaperTimePayload, getInvalidDiaperRashField,
} from '@/src/components/forms/DiaperForm/diaper-form-data';
import { getActivityDescription, getActivityDetails } from '@/src/components/Timeline/utils';
import type { DiaperLogResponse } from '@/app/api/types';

describe('observational diaper rash presentation', () => {
  it.each([
    [true, 'Rash observed'], [false, 'No rash observed'], [null, 'Not recorded'],
    [undefined, 'Not recorded'],
  ])('keeps %s distinct in history and export', (rashObserved, status) => {
    expect(getDiaperRashDetails({ rashObserved })).toEqual([
      { label: 'Rash observation', value: status },
    ]);
  });

  it('does not infer a rash from cream use, text, or a legacy record', () => {
    const legacy = { creamApplied: true, notes: 'red area', rashDescription: 'red area' };
    expect(getDiaperRashDetails(legacy)).toEqual([
      { label: 'Rash observation', value: 'Not recorded' },
      { label: 'Rash description', value: 'red area' },
    ]);
    expect(getDiaperRashSummary(legacy)).toBe('Rash observation: Not recorded');
  });

  it('localizes labels and states, preserving caregiver text verbatim', () => {
    const t = (key: string) => `[${key}]`;
    expect(getDiaperRashDetails({
      rashObserved: false, rashLocation: '  left side  ', rashDescription: '=caregiver text',
      rashProductsApplied: 'product\nrecorded', rashFollowUpNotes: 'look again later',
    }, t)).toEqual([
      { label: '[Rash observation]', value: '[No rash observed]' },
      { label: '[Rash location]', value: '  left side  ' },
      { label: '[Rash description]', value: '=caregiver text' },
      { label: '[Products applied]', value: 'product\nrecorded' },
      { label: '[Follow-up notes]', value: 'look again later' },
    ]);
  });

  it('leaves blank optional text out of presentation and exposes every recorded text to search', () => {
    const record = {
      rashObserved: true, rashLocation: 'Left fold', rashDescription: 'Small red area',
      rashProductsApplied: 'Product A', rashFollowUpNotes: 'After next change',
    };
    const search = getDiaperRashSearchText(record);
    for (const value of ['Rash observed', 'Left fold', 'Small red area', 'Product A', 'After next change']) {
      expect(search).toContain(value);
    }
    expect(getDiaperRashDetails({ rashLocation: '', rashDescription: ' \n ', rashProductsApplied: null }))
      .toEqual([{ label: 'Rash observation', value: 'Not recorded' }]);
  });

  it.each(['WET', 'DIRTY', 'BOTH', 'DRY'] as const)('includes observations in actual %s history detail and summary', type => {
    const record: DiaperLogResponse = {
      id: 'synthetic-diaper', babyId: 'synthetic-baby', familyId: 'synthetic-family', caretakerId: null,
      time: '2026-11-20T08:00:45.789Z', createdAt: '2026-11-20T08:01:00Z', updatedAt: '2026-11-20T08:01:00Z',
      deletedAt: null, type, condition: null, color: null, blowout: false, creamApplied: true, notes: 'Caregiver note',
      rashObserved: false, rashLocation: 'Left fold', rashDescription: 'Observed description',
      rashProductsApplied: 'Recorded product', rashFollowUpNotes: 'Follow-up observation',
    };
    const result = getActivityDetails(record, null, key => key);
    expect(result.title).toBe('Diaper Record');
    expect(result.details).toEqual(expect.arrayContaining([
      { label: 'Rash observation', value: 'No rash observed' },
      { label: 'Rash location', value: 'Left fold' },
      { label: 'Rash description', value: 'Observed description' },
      { label: 'Products applied', value: 'Recorded product' },
      { label: 'Follow-up notes', value: 'Follow-up observation' },
    ]));
    expect(getActivityDescription(record, null, key => key).details).toContain('Rash observation: No rash observed');
  });
});

describe('diaper form compatibility payloads', () => {
  it('starts legacy/unknown fields blank without deciding that no rash was observed', () => {
    expect(diaperRashToDraft()).toEqual({
      rashObserved: null, rashLocation: '', rashDescription: '', rashProductsApplied: '', rashFollowUpNotes: '',
    });
    expect(diaperRashToDraft({ rashObserved: false }).rashObserved).toBe(false);
  });

  it('omits all untouched rash fields from edits, including stale legacy drafts', () => {
    expect(buildDiaperRashPayload(diaperRashToDraft(), {})).toEqual({});
    expect(buildDiaperRashPayload(diaperRashToDraft({ rashObserved: true, rashDescription: 'recorded' }), {}))
      .toEqual({});
  });

  it.each([true, false, null])('sends the explicit observation %s only when touched', rashObserved => {
    expect(buildDiaperRashPayload({ ...diaperRashToDraft(), rashObserved }, { rashObserved: true }))
      .toEqual({ rashObserved });
  });

  it('clears each edited blank text with null and keeps other fields untouched', () => {
    expect(buildDiaperRashPayload({
      ...diaperRashToDraft(), rashLocation: '  ', rashDescription: 'Caregiver description',
    }, { rashLocation: true, rashDescription: true })).toEqual({
      rashLocation: null, rashDescription: 'Caregiver description',
    });
  });

  it.each(Object.entries(DIAPER_RASH_TEXT_LIMITS))('validates the %s text boundary before submitting', (key, maxLength) => {
    const draft = { ...diaperRashToDraft(), [key]: 'x'.repeat(maxLength) };
    expect(getInvalidDiaperRashField(draft, { [key]: true })).toBeUndefined();
    draft[key as keyof typeof DIAPER_RASH_TEXT_LIMITS] += 'x';
    expect(getInvalidDiaperRashField(draft, { [key]: true })).toBe(key);
    expect(getInvalidDiaperRashField(draft, {})).toBeUndefined();
  });

  it('counts text limits in the same UTF-16 units as HTML maxLength and the API', () => {
    expect(getInvalidDiaperRashField({ ...diaperRashToDraft(), rashLocation: '🙂'.repeat(101) }, { rashLocation: true }))
      .toBe('rashLocation');
  });

  it('preserves the original instant when editing other fields or reselecting its minute', () => {
    const original = '2026-11-01T01:30:45.789-05:00';
    expect(buildDiaperTimePayload(new Date(original), original)).toEqual({});
    expect(buildDiaperTimePayload(new Date('2026-11-01T06:30:00.000Z'), original)).toEqual({});
    expect(buildDiaperTimePayload(new Date('2026-11-01T07:30:00.000Z'), original))
      .toEqual({ time: '2026-11-01T07:30:00.000Z' });
  });

  it('sends an exact ISO timestamp for a new entry or changed minute', () => {
    expect(buildDiaperTimePayload(new Date('2026-11-20T07:38:42.123Z')))
      .toEqual({ time: '2026-11-20T07:38:42.123Z' });
    expect(buildDiaperTimePayload(new Date('2026-11-20T07:39:00Z'), '2026-11-20T07:38:42.123Z'))
      .toEqual({ time: '2026-11-20T07:39:00.000Z' });
    expect(() => buildDiaperTimePayload(new Date('invalid'))).toThrow();
  });
});
