import { describe, expect, it } from 'vitest';
import { mapBabyBuddyFeeding } from '@/src/lib/importers/baby-buddy';
import { normalizeFeedingTimestamp, resolveExternalImportFeedTiming, resolveFeedingTimestamp } from '@/src/lib/importers/feeding-time';
import type { ExternalImportFeedRecord } from '@/src/types/external-import';

const source = { id: 'feed-1', child_id: '7', start: '2026-10-31 23:59:30', end: '2026-11-01 00:14:45',
  type: 'formula', method: 'bottle', amount: '90', notes: 'Synthetic source observation' };
function record(overrides = {}): ExternalImportFeedRecord {
  const value = mapBabyBuddyFeeding({ ...source, ...overrides }, 'ML');
  if (!value) throw new Error('Expected mapped feed');
  return value;
}

describe('Baby Buddy feeding timestamp and duration fidelity', () => {
  it.each(['bottle', 'left breast', 'right breast', 'both breasts', 'parent fed', 'self fed'])(
    'retains both source endpoints for %s without guessing duration before source-zone resolution', method => {
      const mapped = record({ method });
      expect(mapped).toMatchObject({ startTime: '2026-10-31T23:59:30', endTime: '2026-11-01T00:14:45',
        time: '2026-11-01T00:14:45', source: { providerId: 'baby-buddy', entityType: 'feeding', recordId: 'feed-1', childId: '7' } });
      expect(mapped.feedDuration).toBeUndefined();
      expect(resolveExternalImportFeedTiming(mapped, 'America/Chicago')).toEqual({
        time: new Date('2026-11-01T05:14:45Z'), startTime: new Date('2026-11-01T04:59:30Z'),
        endTime: new Date('2026-11-01T05:14:45Z'), feedDuration: 915,
      });
    },
  );

  it('retains solid-food session timing and leaves an absent amount unknown', () => {
    const mapped = record({ type: 'solid food', method: 'parent fed', amount: '' });
    expect(mapped).toMatchObject({ type: 'SOLIDS', startTime: '2026-10-31T23:59:30', endTime: '2026-11-01T00:14:45' });
    expect(mapped.amount).toBeUndefined();
    expect(resolveExternalImportFeedTiming(mapped, 'America/Chicago').feedDuration).toBe(915);
  });

  it.each([
    ['2026-03-08 01:55:10', '2026-03-08 03:05:20', 610],
    ['2026-11-01 00:55:10', '2026-11-01 02:05:20', 7810],
    ['2026-11-01 01:55:10-05:00', '2026-11-01 01:05:20-06:00', 610],
    ['2026-10-20T08:15:00Z', '2026-10-20 14:00:15+05:30', 915],
    ['2026-10-20T08:15:00.500Z', '2026-10-20T08:15:01.500Z', 1],
  ])('uses elapsed UTC seconds for %s to %s', (start, end, expected) => {
    expect(resolveExternalImportFeedTiming(record({ start, end }), 'America/Chicago').feedDuration).toBe(expected);
  });

  it('preserves explicit offsets independently of the configured source timezone', () => {
    expect(normalizeFeedingTimestamp(' 2026-11-01 01:05:20-0600 ')).toBe('2026-11-01T01:05:20-06:00');
    expect(resolveFeedingTimestamp('2026-11-01T01:05:20-06:00', 'Asia/Tokyo').toISOString()).toBe('2026-11-01T07:05:20.000Z');
    expect(resolveFeedingTimestamp('2026-10-20T08:15:00Z', 'America/Chicago').toISOString()).toBe('2026-10-20T08:15:00.000Z');
  });

  it.each([
    ['2026-03-08 02:15:00', 'America/Chicago', 'does not exist'],
    ['2026-11-01 01:15:00', 'America/Chicago', 'ambiguous'],
    ['2026-04-05 01:45:00', 'Australia/Lord_Howe', 'ambiguous'],
    ['2026-10-04 02:15:00', 'Australia/Lord_Howe', 'does not exist'],
    ['2011-12-30 12:00:00', 'Pacific/Apia', 'does not exist'],
  ])('refuses to guess %s in %s', (time, zone, error) => {
    expect(() => resolveFeedingTimestamp(time, zone)).toThrow(error);
  });

  it.each(['2026-02-29 12:00:00', '2026-02-30 12:00:00Z', '2026-04-31 12:00:00',
    '2026-10-20 24:00:00', '2026-10-20 12:60:00', '2026-10-20 12:00:60',
    '2026-10-20 12:00:00+24:00', '2026-10-20 12:00:00+05:60', '10/20/2026 12:00',
    '2026-10-20 12:00:00.1234Z', 'not-a-date'])('rejects invalid or unsupported source timestamp %s', time => {
    expect(() => normalizeFeedingTimestamp(time)).toThrow('Invalid feeding');
  });

  it('accepts a real leap date and exact zero duration', () => {
    expect(normalizeFeedingTimestamp('2024-02-29 12:00:00')).toBe('2024-02-29T12:00:00');
    expect(resolveExternalImportFeedTiming(record({ start: '2026-01-01 12:00:00', end: '2026-01-01 12:00:00' }), 'UTC').feedDuration).toBe(0);
  });

  it.each(['start', 'end'])('rejects a missing %s instead of inventing a point event', field => {
    expect(() => record({ [field]: '' })).toThrow(`Required field is missing: ${field}`);
  });

  it('rejects reverse or unrepresentable elapsed times and conflicting declared duration', () => {
    expect(() => resolveExternalImportFeedTiming(record({ start: '2026-01-01 12:00:00Z', end: '2026-01-01 11:59:59Z' }), 'UTC')).toThrow('non-negative whole number');
    expect(() => resolveExternalImportFeedTiming(record({ start: '2026-01-01 12:00:00Z', end: '2026-01-01 12:00:00.5Z' }), 'UTC')).toThrow('whole number of seconds');
    expect(() => resolveExternalImportFeedTiming({ ...record(), feedDuration: 0 }, 'America/Chicago')).toThrow('conflicts');
    expect(() => resolveExternalImportFeedTiming({ ...record(), endTime: undefined }, 'America/Chicago')).toThrow('Both feeding start and end');
  });

  it('keeps an explicitly untimed generic feed duration unknown and validates its source timezone', () => {
    const untimed = { ...record(), startTime: undefined, endTime: undefined };
    expect(resolveExternalImportFeedTiming(untimed, 'America/Chicago').feedDuration).toBeUndefined();
    expect(() => resolveFeedingTimestamp('2026-01-01 12:00:00Z', '')).toThrow('Source timezone is required');
    expect(() => resolveFeedingTimestamp('2026-01-01 12:00:00Z', 'Not/A-Timezone')).toThrow('Invalid source timezone');
  });
});
