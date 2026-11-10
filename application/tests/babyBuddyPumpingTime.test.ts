import { describe, expect, it } from 'vitest';
import { mapBabyBuddyPumping } from '@/src/lib/importers/baby-buddy';
import { resolveExternalImportPumpTiming } from '@/src/lib/importers/pumping-time';

const source = { id: 'pump-1', child_id: '7', start: '2026-03-08 01:55:10',
  end: '2026-03-08 03:05:20', amount: '100', notes: 'Synthetic source observation' };
const record = (overrides = {}) => mapBabyBuddyPumping({ ...source, ...overrides }, 'ML');

describe('Baby Buddy pumping timestamp and duration fidelity', () => {
  it('keeps source endpoints and identity without guessing a duration before timezone resolution', () => {
    const mapped = record();
    expect(mapped).toMatchObject({ startTime: '2026-03-08T01:55:10', endTime: '2026-03-08T03:05:20',
      totalAmount: 100, unitAbbr: 'ML', pumpAction: 'UNKNOWN', notes: source.notes,
      source: { providerId: 'baby-buddy', entityType: 'pumping', recordId: 'pump-1', childId: '7' } });
    expect(mapped.duration).toBeUndefined();
  });

  it.each(['UTC', 'America/Los_Angeles', 'Asia/Tokyo'])('uses the selected source timezone, independently of host TZ=%s', hostTimezone => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = hostTimezone;
      expect(resolveExternalImportPumpTiming(record(), 'America/Chicago')).toEqual({
        startTime: new Date('2026-03-08T07:55:10Z'), endTime: new Date('2026-03-08T08:05:20Z'), duration: 10,
      });
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it.each([
    ['2026-01-01 12:00:00.000Z', 0],
    ['2026-01-01 12:00:29.999Z', 0],
    ['2026-01-01 12:00:30.000Z', 1],
    ['2026-01-01 12:01:29.999Z', 1],
  ])('retains exact endpoint %s while rounding elapsed minutes to %s', (end, duration) => {
    const timing = resolveExternalImportPumpTiming(record({ start: '2026-01-01 12:00:00Z', end }), 'UTC');
    expect(timing.endTime.toISOString()).toBe(end.replace(' ', 'T'));
    expect(timing.duration).toBe(duration);
  });

  it.each([
    ['2026-02-30 12:00:00', 'calendar date'],
    ['2026-10-20 24:00:00', 'timestamp'],
    ['2026-10-20 12:00:00+24:00', 'timestamp'],
    ['not-a-date', 'timestamp'],
  ])('rejects malformed pumping timestamp %s with a pumping-specific error', (start, error) => {
    expect(() => record({ start })).toThrow(`Invalid pumping ${error}`);
  });

  it.each(['start', 'end'])('requires a source %s instead of inventing a timed session', field => {
    expect(() => record({ [field]: '' })).toThrow(`Required field is missing: ${field}`);
  });

  it('retains explicit compact offsets and rejects reversed instants before minute rounding', () => {
    const mapped = record({ start: '2026-11-01 01:55:10-0500', end: '2026-11-01 01:05:20-0600' });
    expect(mapped.startTime).toBe('2026-11-01T01:55:10-05:00');
    expect(resolveExternalImportPumpTiming(mapped, 'Asia/Tokyo').duration).toBe(10);
    expect(() => resolveExternalImportPumpTiming(record({ start: '2026-01-01 12:00:00Z', end: '2026-01-01 11:59:59.999Z' }), 'UTC'))
      .toThrow('before start');
  });

  it('checks declared duration against resolved endpoints and bounds the stored integer', () => {
    expect(resolveExternalImportPumpTiming({ ...record(), duration: 10 }, 'America/Chicago').duration).toBe(10);
    expect(() => resolveExternalImportPumpTiming({ ...record(), duration: 70 }, 'America/Chicago')).toThrow('conflicts');
    expect(() => resolveExternalImportPumpTiming(record({ start: '0001-01-01 00:00:00Z', end: '9999-01-01 00:00:00Z' }), 'UTC'))
      .toThrow('supported range');
  });

  it.each(['', 'Not/A-Timezone'])('rejects invalid selected timezone %s even for explicit-offset endpoints', sourceTimezone => {
    expect(() => resolveExternalImportPumpTiming(record({ start: '2026-01-01 12:00:00Z', end: '2026-01-01 12:10:00Z' }), sourceTimezone))
      .toThrow(/timezone/i);
  });
});
