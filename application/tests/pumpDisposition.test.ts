import { describe, expect, it } from 'vitest';
import type { PumpLogCreate, PumpLogResponse } from '@/app/api/types';
import { changedPumpFields } from '@/src/utils/pumpFormUpdate';
import { isPumpAction, pumpActionLabel } from '@/src/utils/pumpAction';
import { calculateBreastMilkBalance } from '@/src/utils/breastMilkInventory';

const existing = {
  id: 'synthetic-pump', familyId: 'synthetic-family', babyId: 'synthetic-baby', caretakerId: null,
  startTime: '2026-10-20T08:00:10.000Z', endTime: '2026-10-20T08:20:20.000Z', duration: 21,
  leftAmount: null, rightAmount: null, totalAmount: 100, unitAbbr: 'ML', pumpAction: 'UNKNOWN', notes: 'Source note',
  createdAt: '2026-10-20T09:00:00.000Z', updatedAt: '2026-10-20T09:00:00.000Z', deletedAt: null,
} satisfies PumpLogResponse;
const draft: PumpLogCreate = {
  babyId: existing.babyId, startTime: existing.startTime, endTime: existing.endTime, duration: 20,
  leftAmount: undefined, rightAmount: undefined, totalAmount: existing.totalAmount,
  unitAbbr: existing.unitAbbr, pumpAction: 'UNKNOWN', notes: existing.notes,
};

describe('unresolved pump disposition', () => {
  it('accepts only canonical actions and presents unknown as needing review', () => {
    for (const action of ['UNKNOWN', 'STORED', 'FED', 'DISCARDED']) expect(isPumpAction(action)).toBe(true);
    for (const action of ['unknown', '', null, undefined, 1, 'FROZEN']) expect(isPumpAction(action)).toBe(false);
    expect(pumpActionLabel('UNKNOWN')).toBe('Needs review');
    expect(pumpActionLabel('STORED')).toBe('Stored');
  });

  it('excludes unresolved amounts regardless of units or zero amounts', () => {
    expect(calculateBreastMilkBalance({
      pumpLogs: [
        { pumpAction: 'UNKNOWN', totalAmount: 100, unitAbbr: 'ML' },
        { pumpAction: 'UNKNOWN', totalAmount: 8, unitAbbr: 'OZ' },
        { pumpAction: 'UNKNOWN', totalAmount: 0, unitAbbr: 'ML' },
        { pumpAction: 'STORED', totalAmount: 50, unitAbbr: 'ML' },
      ], adjustments: [], feedLogs: [], targetUnit: 'ML',
    })).toBe(50);
  });

  it('sends only the explicit disposition change, preserving source duration and missing sides', () => {
    expect(changedPumpFields(existing, { ...draft, pumpAction: 'STORED' }, { start: false, end: false }))
      .toEqual({ pumpAction: 'STORED' });
  });

  it('unrelated edits preserve unknown and every untouched source field', () => {
    expect(changedPumpFields(existing, { ...draft, notes: 'Reviewed note' }, { start: false, end: false }))
      .toEqual({ notes: 'Reviewed note' });
    expect(changedPumpFields(existing, draft, { start: false, end: false })).toEqual({});
  });

  it('only explicit endpoint changes recalculate duration and preserve absent end times otherwise', () => {
    expect(changedPumpFields(existing, { ...draft, endTime: '2026-10-20T08:30:20Z', duration: 30 }, { start: false, end: true }))
      .toEqual({ endTime: '2026-10-20T08:30:20Z', duration: 30 });
    expect(changedPumpFields({ ...existing, endTime: null, duration: null }, draft, { start: false, end: false })).toEqual({});
    expect(changedPumpFields({ ...existing, endTime: null, duration: null }, { ...draft, startTime: '2026-10-20T08:05:10Z' }, { start: true, end: false }))
      .toEqual({ startTime: '2026-10-20T08:05:10Z' });
    expect(changedPumpFields(existing, { ...draft, startTime: '2026-10-20T03:00:10-05:00' }, { start: true, end: false })).toEqual({});
  });
});
