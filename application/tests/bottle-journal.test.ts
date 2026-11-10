import { describe, expect, it } from 'vitest';
import { bottleInput, journalTotals, journalWindow, localTimeToInstant } from '@/src/lib/bottle-journal/validation';
import { parseLegacyJournal } from '@/src/lib/bottle-journal/legacy';

const now = new Date('2026-11-02T01:00:00Z');
const bottle = { time: '2026-11-01T08:00:00-06:00', amount: 90, offeredAmount: 120, unitAbbr: 'ML', bottleType: 'Formula', formulaKcalOz: 22 };
describe('Bottle Journal validation and time-aware totals', () => {
  it('preserves consumed/offered volume and rejects contradictions without inventing optional details', () => {
    expect(bottleInput(bottle, now)).toMatchObject({ amount: 90, offeredAmount: 120, formulaKcalOz: 22, formulaName: null, bottleLabel: null });
    expect(() => bottleInput({ ...bottle, offeredAmount: 80 }, now)).toThrow('exceed');
    expect(() => bottleInput({ ...bottle, amount: null }, now)).toThrow('consumed');
    expect(() => bottleInput({ ...bottle, unitAbbr: 'cc' }, now)).toThrow('mL or oz');
    expect(() => bottleInput({ ...bottle, time: '2026-02-30T08:00:00Z' }, now)).toThrow('date');
  });
  it('uses a 25-hour local day at autumn DST but exactly 24 elapsed hours for rolling totals', () => {
    const bounds = journalWindow('2026-11-01', 'America/Chicago', now);
    expect(bounds.dayEnd.getTime() - bounds.dayStart.getTime()).toBe(25 * 3600_000);
    expect(bounds.now.getTime() - bounds.rollingStart.getTime()).toBe(24 * 3600_000);
    const totals = journalTotals([
      { type: 'BOTTLE', time: '2026-11-01T05:00:00Z', amount: 30, unitAbbr: 'ML' },
      { type: 'BOTTLE', time: '2026-11-01T07:30:00Z', amount: 2, unitAbbr: 'OZ' },
      { type: 'BOTTLE', time: '2026-11-01T08:30:00Z', amount: 50, unitAbbr: 'ML' },
      { type: 'BOTTLE', time: '2026-11-01T09:00:00Z', amount: 900, unitAbbr: 'ML', deletedAt: new Date() },
      { type: 'BOTTLE', time: '2026-11-02T03:00:00Z', amount: 900, unitAbbr: 'ML' },
      { type: 'BREAST', time: '2026-11-01T09:00:00Z', amount: 900, unitAbbr: 'ML' },
    ], bounds, 200);
    expect(totals).toMatchObject({ dailyCount: 3, rollingCount: 3, dailyMl: 139.1, rollingMl: 139.1, remainingMl: 60.9, progress: 70 });
  });
  it('rejects missing and ambiguous wall-clock times rather than silently moving them', () => {
    expect(() => localTimeToInstant('2026-03-08T02:30', 'America/Chicago')).toThrow('does not exist');
    expect(() => localTimeToInstant('2026-11-01T01:30', 'America/Chicago')).toThrow('occurs twice');
    expect(localTimeToInstant('2026-11-01T08:30', 'America/Chicago')).toBe('2026-11-01T14:30:00.000Z');
  });
  it('keeps an unknown-volume bottle out of amounts while reporting the missing measurement', () => {
    expect(journalTotals([{ time: now, type: 'BOTTLE', amount: null, unitAbbr: 'ML' }], journalWindow('2026-11-01', 'America/Chicago', now), null)).toMatchObject({ dailyCount: 1, dailyMl: 0, unknownVolumes: 1, targetMl: null });
  });
});
describe('Actual Family Bottle Journal export contracts', () => {
  it('previews both known-time and unknown-time JSON entries without assigning midnight', () => {
    const result = parseLegacyJournal(JSON.stringify({ version: 2, settings: { daily_goal_ml: 510 }, feedings: [
      { id: 'known', feed_date: '2026-10-20', feed_time: '08:15', fed_at_ms: Date.parse('2026-10-20T13:15:00Z'), volume_ml: 85, formula_kcal_oz: 22, notes: 'Synthetic note', created_by: 'Synthetic caregiver' },
      { id: 'unknown', feed_date: '2026-10-20', feed_time: null, fed_at_ms: null, volume_ml: 65, formula_kcal_oz: 22 },
    ] }), 'json', 'America/Chicago');
    expect(result.targetMl).toBe(510);
    expect(result.rows[0]).toMatchObject({ sourceId: 'known', time: '2026-10-20T13:15:00.000Z', amount: 85, sourceCaregiverName: 'Synthetic caregiver', issue: null });
    expect(result.rows[1]).toMatchObject({ time: '', amount: 65 });
    expect(result.rows[1].issue).toMatch('unknown');
  });
  it('gives repeated CSV rows stable distinct IDs and detects malformed exports', () => {
    const csv = 'Date,Time,Consumed (mL),Formula (kcal/fl oz),Energy (kcal),Notes,Recorded by,Sync status\n2026-10-20,08:15,90,22,67,Synthetic,Caregiver,Confirmed\n2026-10-20,08:15,90,22,67,Synthetic,Caregiver,Confirmed';
    const first = parseLegacyJournal(csv, 'csv', 'America/Chicago');
    expect(first.rows).toHaveLength(2);
    expect(first.rows[0].sourceId).not.toBe(first.rows[1].sourceId);
    expect(parseLegacyJournal(csv, 'csv', 'America/Chicago').rows.map(row => row.sourceId)).toEqual(first.rows.map(row => row.sourceId));
    expect(() => parseLegacyJournal('a,b\n1,2', 'csv', 'UTC')).toThrow('exported');
  });
  it('calls out unconfirmed legacy operations and keeps them out of the import', () => {
    const result = parseLegacyJournal(JSON.stringify({ version: 2, feedings: [], pending_changes: [{ type: 'feed.upsert', id: 'unsynced' }], unresolved_conflicts: [{}] }), 'json', 'UTC');
    expect(result.rows).toHaveLength(0); expect(result.warnings).toHaveLength(2);
  });
});
