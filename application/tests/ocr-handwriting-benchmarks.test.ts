import { describe, expect, it } from 'vitest';
import { parseOcrPages } from '../src/lib/ocr/parser';
import { validateOcrCandidate } from '../src/lib/ocr/validation';

describe('OCR handwritten care sheet benchmarks & edge cases', () => {
  const parse = (text: string, options = {}) =>
    parseOcrPages([{ page: 1, text, engine: 'synthetic-handwriting-benchmark', confidence: 68 }], {
      defaultDate: '2026-10-20',
      ...options,
    });

  it('handles mixed feeding and diaper table rows separated by pipes or tabs', () => {
    const tableText = [
      'Date: 2026-10-20',
      'Time | Feeding | Diaper | Sleep | Notes',
      '08:30 AM | 4 oz bottle formula | wet | | calm morning',
      '11:45 AM | 120 mL breast milk | bm dirty | nap 12:00 PM - 1:00 PM | easy burp',
    ].join('\n');

    const rows = parse(tableText);
    expect(rows.length).toBeGreaterThanOrEqual(4);

    const feedRows = rows.filter(r => r.eventType === 'feed');
    const diaperRows = rows.filter(r => r.eventType === 'diaper');

    expect(feedRows).toHaveLength(2);
    expect(diaperRows).toHaveLength(2);

    expect(feedRows[0]).toMatchObject({
      amount: 4,
      unit: 'OZ',
      feedType: 'BOTTLE',
      bottleType: 'Formula',
      localDate: '2026-10-20',
      localTime: '08:30',
    });

    expect(diaperRows[0]).toMatchObject({
      diaperType: 'WET',
      localDate: '2026-10-20',
      localTime: '08:30',
    });

    expect(feedRows[1]).toMatchObject({
      amount: 120,
      unit: 'ML',
      bottleType: 'Breast Milk',
      localTime: '11:45',
    });

    expect(diaperRows[1]).toMatchObject({
      diaperType: 'DIRTY',
      localTime: '11:45',
    });
  });

  it('recognizes clinical cubic centimeter (cc) units and maps to ML', () => {
    const rows = parse('07:00 AM bottle formula 90 cc');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: 'feed',
      amount: 90,
      unit: 'ML',
      localTime: '07:00',
    });
  });

  it('recognizes bm and soiled as dirty diapers', () => {
    const bmRow = parse('09:15 AM bm diaper')[0];
    expect(bmRow).toMatchObject({
      eventType: 'diaper',
      diaperType: 'DIRTY',
      localTime: '09:15',
    });

    const soiledRow = parse('01:30 PM soiled diaper')[0];
    expect(soiledRow).toMatchObject({
      eventType: 'diaper',
      diaperType: 'DIRTY',
      localTime: '13:30',
    });

    const bothRow = parse('04:00 PM wet and soiled diaper')[0];
    expect(bothRow).toMatchObject({
      eventType: 'diaper',
      diaperType: 'BOTH',
      localTime: '16:00',
    });
  });

  it('abstains from guessing exact amount when range is written (e.g. 2-3 oz or 60-90 mL)', () => {
    const rangeOz = parse('08:00 AM bottle formula 2-3 oz')[0];
    expect(rangeOz.amount).toBeNull();
    expect(rangeOz.unit).toBe('OZ');
    expect(rangeOz.fieldSources.amount).toBe('ambiguous');
    expect(rangeOz.warnings.some(w => w.includes('ambiguous'))).toBe(true);

    const rangeMl = parse('12:00 PM bottle 60 to 90 ml')[0];
    expect(rangeMl.amount).toBeNull();
    expect(rangeMl.unit).toBe('ML');
    expect(rangeMl.fieldSources.amount).toBe('ambiguous');
  });

  it('supports dot-separated time notations (8.30 am, 14.15)', () => {
    const morning = parse('8.30 am wet diaper')[0];
    expect(morning.localTime).toBe('08:30');

    const afternoon = parse('2.45 pm bottle formula 4 oz')[0];
    expect(afternoon.localTime).toBe('14:45');

    const military = parse('1415 wet diaper', { timeFormat: '24h' })[0];
    expect(military.localTime).toBe('14:15');
  });

  it('flags crossed out, voided, or mistake rows and clears inferred values', () => {
    const crossedFeed = parse('10:00 AM bottle 120 ml formula ~~mistake~~')[0];
    expect(crossedFeed.amount).toBeNull();
    expect(crossedFeed.feedType).toBeNull();
    expect(crossedFeed.warnings.some(w => w.includes('crossed-out') || w.includes('Negated'))).toBe(true);

    const voidDiaper = parse('11:00 AM wet diaper void error')[0];
    expect(voidDiaper.diaperType).toBeNull();
    expect(voidDiaper.warnings.some(w => w.includes('Negated') || w.includes('crossed-out'))).toBe(true);
  });

  it('requires explicit review for overnight sleep crossing midnight', () => {
    const sleepRow = parse('23:00 - 01:30 sleep', { timeFormat: '24h' })[0];
    expect(sleepRow.localTime).toBe('23:00');
    expect(sleepRow.endLocalTime).toBe('01:30');
    expect(sleepRow.endLocalDate).toBeNull();
    expect(sleepRow.warnings.some(w => w.includes('midnight'))).toBe(true);
  });

  it('preserves unreadable scribbles as manual candidates without inventing records', () => {
    const scribble = parse('scribble wavy lines illegible')[0];
    expect(scribble.eventType).toBe('unknown');
    expect(scribble.amount).toBeNull();
    expect(scribble.diaperType).toBeNull();
    expect(scribble.approved).toBe(false);
    expect(validateOcrCandidate(scribble).valid).toBe(false);
  });
});
