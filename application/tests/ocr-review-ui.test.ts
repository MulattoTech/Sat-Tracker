import { describe, expect, it } from 'vitest';
import { parseOcrPages } from '../src/lib/ocr/parser';
import { validateOcrCandidate } from '../src/lib/ocr/validation';
import {
  calculateReviewTotals, editOcrRow, isValidTimezone, manualOcrRow,
  mergeOcrRows, rowReviewIssues,
} from '../src/components/OcrImport/review-helpers';

describe('OCR review state safety', () => {
  it('creates unresolved manual drafts with explicit source-page identity', () => {
    const row = manualOcrRow(2, '12345678-abcd-1234-abcd-123456789abc');
    expect(row).toMatchObject({
      id: 'manual-12345678-abcd-1234-abcd-123456789abc',
      approved: false,
      rejected: false,
      eventType: 'unknown',
      localDate: null,
      localTime: null,
      source: { page: 2, line: 1, engine: 'manual', confidence: null },
    });
    expect(validateOcrCandidate(row, { allowIncomplete: true }).valid).toBe(true);
    expect(rowReviewIssues(row, 'UTC').errors.length).toBeGreaterThan(0);
  });

  it('resets prior approval after corrections while retaining original recognized evidence', () => {
    const original = { ...parseOcrPages([{ page: 1, text: '2026-04-14 8 AM bottle 60 ml' }])[0], approved: true };
    const corrected = editOcrRow(original, { amount: 65, notes: 'Corrected against the page' });
    expect(corrected).toMatchObject({ approved: false, amount: 65, fieldSources: { amount: 'corrected', notes: 'corrected' } });
    expect(corrected.source).toEqual(original.source);
    expect(original.approved).toBe(true);
    expect(original.amount).toBe(60);
  });

  it('does not allow client approval without a chosen DST occurrence', () => {
    const row = parseOcrPages([{ page: 1, text: '2026-11-01 1:30 AM bottle 60 ml' }])[0];
    expect(rowReviewIssues(row, 'America/Chicago').errors.some(error => error.includes('repeats'))).toBe(true);
    expect(rowReviewIssues(row, 'America/Chicago', { start: -360 }).errors).toEqual([]);
  });

  it('orders sleep by explicit UTC occurrences when the fall-back clock runs backward', () => {
    const row = { ...parseOcrPages([{ page: 1, text: '2026-11-01 1:50 AM - 1:10 AM night sleep' }])[0], endLocalDate: '2026-11-01' };
    expect(validateOcrCandidate(row).valid).toBe(false);
    expect(validateOcrCandidate(row, { deferSleepOrdering: true }).valid).toBe(true);
    expect(rowReviewIssues(row, 'America/Chicago').errors.some(error => error.includes('repeats'))).toBe(true);
    expect(rowReviewIssues(row, 'America/Chicago', { start: -300, end: -360 }).errors).toEqual([]);
    expect(rowReviewIssues(row, 'America/Chicago', { start: -360, end: -360 }).errors).toContain('Sleep end must be after its start.');
    expect(rowReviewIssues(row, 'UTC').errors).toContain('Sleep end must be after its start.');
  });

  it('rejects an invalid document time zone and retains source warnings', () => {
    const row = parseOcrPages([{ page: 1, text: '2026-04-14 8 AM bottle 60 ml', confidence: 10 }])[0];
    expect(rowReviewIssues(row, 'unknown/place').errors.some(error => error.includes('time zone'))).toBe(true);
    expect(row.warnings.some(warning => warning.includes('Low engine'))).toBe(true);
    expect(row.approved).toBe(false);
  });

  it('validates IANA time zones reliably', () => {
    expect(isValidTimezone('America/Chicago')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('Asia/Tokyo')).toBe(true);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('Invalid/Zone')).toBe(false);
    expect(isValidTimezone('US/Central')).toBe(true);
  });

  it('merges split OCR rows correctly, combining missing fields and notes while resetting approval', () => {
    const row1 = {
      ...parseOcrPages([{ page: 1, text: '2026-04-14 8:00 AM bottle formula 60 ml' }])[0],
      approved: true,
    };
    const row2 = {
      ...manualOcrRow(1, 'row2-id'),
      notes: 'Baby finished quickly and burped',
      warnings: ['Secondary note from caregiver'],
    };

    const merged = mergeOcrRows(row1, row2);
    expect(merged.approved).toBe(false);
    expect(merged.rejected).toBe(false);
    expect(merged.amount).toBe(60);
    expect(merged.unit).toBe('ML');
    expect(merged.feedType).toBe('BOTTLE');
    expect(merged.notes).toBe('2026-04-14 8:00 AM bottle formula 60 ml · Baby finished quickly and burped');
    expect(merged.warnings).toContain('Secondary note from caregiver');
    expect(merged.warnings.some(w => w.includes('Merged with draft row'))).toBe(true);
  });

  it('handles row rejection by suppressing validation errors and resetting approval', () => {
    const incompleteRow = manualOcrRow(1, 'dummy-id');
    const issuesBefore = rowReviewIssues(incompleteRow, 'UTC');
    expect(issuesBefore.errors.length).toBeGreaterThan(0);

    const rejectedRow = { ...incompleteRow, rejected: true, approved: false };
    const contradictory = validateOcrCandidate({ ...rejectedRow, approved: true }, { allowIncomplete: true });
    expect(contradictory.valid).toBe(false);
    expect(contradictory.errors).toContain('A rejected event cannot also be approved.');
    const issuesAfter = rowReviewIssues(rejectedRow, 'UTC');
    expect(issuesAfter.errors).toEqual([]);
    expect(issuesAfter.warnings.some(w => w.includes('rejected'))).toBe(true);

    const validated = validateOcrCandidate(rejectedRow, { allowIncomplete: true });
    expect(validated.valid).toBe(true);
    expect(validated.candidate?.rejected).toBe(true);
  });

  it('recalculates live totals accurately across feeds (mL & oz), diapers, and sleep', () => {
    const feed1 = {
      ...parseOcrPages([{ page: 1, text: '2026-04-14 8:00 AM bottle formula 60 ml' }])[0],
      approved: true,
    };
    const feed2 = {
      ...parseOcrPages([{ page: 1, text: '2026-04-14 11:30 AM bottle breast milk 4 oz' }])[0],
      approved: true,
    };
    const diaperWet = {
      ...parseOcrPages([{ page: 1, text: '2026-04-14 9:00 AM wet diaper' }])[0],
      approved: true,
    };
    const diaperDirty = {
      ...parseOcrPages([{ page: 1, text: '2026-04-14 1:00 PM dirty diaper' }])[0],
      approved: true,
    };
    const diaperBoth = {
      ...parseOcrPages([{ page: 1, text: '2026-04-14 4:00 PM both wet and dirty diaper' }])[0],
      approved: true,
    };
    const unapprovedFeed = {
      ...parseOcrPages([{ page: 1, text: '2026-04-14 6:00 PM bottle 120 ml' }])[0],
      approved: false,
    };
    const rejectedRow = {
      ...manualOcrRow(1, 'rejected-1'),
      rejected: true,
    };
    const sleepRow = {
      ...parseOcrPages([{ page: 1, text: '2026-04-14 2:00 PM - 3:30 PM nap' }])[0],
      approved: true,
    };

    const rows = [feed1, feed2, diaperWet, diaperDirty, diaperBoth, unapprovedFeed, rejectedRow, sleepRow];
    const totals = calculateReviewTotals(rows, 'America/Chicago');

    expect(totals.totalRows).toBe(8);
    expect(totals.approvedCount).toBe(6);
    expect(totals.rejectedCount).toBe(1);
    expect(totals.excludedCount).toBe(1);

    // Feed totals: 60 ml + 4 oz (4 * 29.5735295625 ≈ 118.294) = 178.294 mL ≈ 178.3 mL
    expect(totals.feeds.totalCount).toBe(3);
    expect(totals.feeds.approvedCount).toBe(2);
    expect(totals.feeds.totalMl).toBeCloseTo(178.3, 1);
    expect(totals.feeds.totalOz).toBeCloseTo(6.0, 1);

    // Diaper totals
    expect(totals.diapers.totalCount).toBe(3);
    expect(totals.diapers.approvedCount).toBe(3);
    expect(totals.diapers.wet).toBe(1);
    expect(totals.diapers.dirty).toBe(1);
    expect(totals.diapers.both).toBe(1);
    expect(totals.diapers.dry).toBe(0);

    // Sleep totals: 2:00 PM to 3:30 PM = 90 minutes (1h 30m)
    expect(totals.sleep.totalCount).toBe(1);
    expect(totals.sleep.approvedCount).toBe(1);
    expect(totals.sleep.totalMinutes).toBe(90);
    expect(totals.sleep.napCount).toBe(1);
  });

  it.each([
    ['2026-03-08', '01:30', '03:30', 60],
    ['2026-11-01', '00:30', '02:30', 180],
  ])('totals elapsed sleep across the clock change on %s', (date, start, end, minutes) => {
    const row = { ...manualOcrRow(1, 'sleep-dst'), eventType: 'sleep' as const, approved: true,
      localDate: date, endLocalDate: date, localTime: start, endLocalTime: end, sleepType: 'NIGHT_SLEEP' as const };
    expect(calculateReviewTotals([row], 'America/Chicago').sleep).toMatchObject({ totalMinutes: minutes, unresolvedCount: 0 });
    // The selected source zone, not the browser/server zone, determines duration.
    expect(calculateReviewTotals([row], 'UTC').sleep.totalMinutes).toBe(120);
  });

  it('uses both selected occurrences when a fall-back sleep ends at an earlier wall time', () => {
    const row = { ...manualOcrRow(1, 'sleep-repeat'), eventType: 'sleep' as const, approved: true,
      localDate: '2026-11-01', endLocalDate: '2026-11-01', localTime: '01:50', endLocalTime: '01:10' };
    expect(calculateReviewTotals([row], 'America/Chicago', { [row.id]: { start: -300, end: -360 } }).sleep)
      .toMatchObject({ totalMinutes: 20, unresolvedCount: 0 });
    for (const offsets of [{}, { start: -300 }, { start: -360, end: -360 }, { start: 60, end: -360 }]) {
      expect(calculateReviewTotals([row], 'America/Chicago', { [row.id]: offsets }).sleep)
        .toMatchObject({ totalMinutes: 0, unresolvedCount: 1 });
    }
  });

  it.each([
    ['2026-03-08', '02:30', '03:30', 'America/Chicago'],
    ['2026-04-14', '08:00', '09:00', 'Invalid/Zone'],
    ['2026-04-14', '08:00', '09:00', ''],
    ['2026-02-30', '08:00', '09:00', 'UTC'],
    ['2026-04-14', null, '09:00', 'UTC'],
    ['2026-04-14', '08:00', '08:00', 'UTC'],
    ['2026-04-14', '09:00', '08:00', 'UTC'],
  ])('excludes unresolved sleep without presenting it as a resolved zero (%s %s %s %s)', (date, start, end, zone) => {
    const row = { ...manualOcrRow(1, 'sleep-invalid'), eventType: 'sleep' as const, approved: true,
      localDate: date, endLocalDate: date, localTime: start, endLocalTime: end };
    expect(calculateReviewTotals([row], zone).sleep)
      .toMatchObject({ totalMinutes: 0, approvedCount: 1, unresolvedCount: 1 });
    expect(calculateReviewTotals([{ ...row, approved: false }], zone).sleep.unresolvedCount).toBe(0);
  });

  it('excludes rejected records from every domain total even if an obsolete approval remains', () => {
    const rows = ['8 AM bottle 60 ml', '9 AM wet diaper', '10 AM - 11 AM nap']
      .flatMap(text => parseOcrPages([{ page: 1, text }], { defaultDate: '2026-04-14' }))
      .map(row => ({ ...row, approved: true, rejected: true }));
    const totals = calculateReviewTotals(rows, 'UTC');
    expect(totals).toMatchObject({ approvedCount: 0, rejectedCount: 3,
      feeds: { approvedCount: 0, totalMl: 0 }, diapers: { approvedCount: 0, wet: 0 },
      sleep: { approvedCount: 0, totalMinutes: 0, unresolvedCount: 0 } });
  });
});
