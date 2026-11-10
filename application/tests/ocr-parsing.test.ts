import { describe, expect, it } from 'vitest';
import { parseOcrPages } from '../src/lib/ocr/parser';
import { OcrCandidate } from '../src/lib/ocr/types';
import { isOcrDate, normalizeAmountMl, resolveOcrLocalDateTime, validateOcrCandidate } from '../src/lib/ocr/validation';

const parse = (text: string) => parseOcrPages([{ page: 1, text, engine: 'synthetic-text', confidence: 90 }], { defaultDate: '2026-04-14' });
const readyBottle = (): OcrCandidate => ({ ...parse('8:30 AM bottle formula 60 mL')[0], approved: true });

describe('OCR care-event drafts', () => {
  it('separates mixed feeding/diaper events and keeps immutable page/row evidence', () => {
    const rows = parseOcrPages([
      { page: 1, text: '2026-04-14\nTime | Feed | Amount | Diaper | Notes\n8:30 AM bottle formula 60 mL; wet diaper\n10:00 AM dirty diaper, yellow soft stool', confidence: 72, engine: 'local-baseline' },
      { page: 2, text: '2026-04-15\n12:00 AM bottle breast milk 2 oz' },
    ]);
    expect(rows).toHaveLength(4);
    expect(rows.map(row => row.eventType)).toEqual(['feed', 'diaper', 'diaper', 'feed']);
    expect(rows[0]).toMatchObject({ amount: 60, unit: 'ML', feedType: 'BOTTLE', bottleType: 'Formula', localDate: '2026-04-14', localTime: '08:30' });
    expect(rows[1]).toMatchObject({ diaperType: 'WET', localTime: '08:30', source: { page: 1, line: 3, slot: 1 }, fieldSources: { localTime: 'context' } });
    expect(rows[2].notes).toContain('yellow soft stool');
    expect(rows[3]).toMatchObject({ localDate: '2026-04-15', localTime: '00:00', bottleType: 'Breast Milk', source: { page: 2, line: 2 } });
    expect(rows.every(row => row.approved === false)).toBe(true);
    expect(rows[0].source.rawText).toBe(rows[1].source.rawText);
    expect(rows[0].fieldSources.localDate).toBe('context');
  });

  it('preserves two legitimate same-time events as distinct rows with stable IDs', () => {
    const pages = [{ page: 3, text: '8 AM wet diaper\n8 AM wet diaper' }];
    const first = parseOcrPages(pages);
    const second = parseOcrPages(pages);
    expect(first.map(row => row.id)).toEqual(second.map(row => row.id));
    expect(new Set(first.map(row => row.id)).size).toBe(2);
    expect(first.every(row => row.localDate === null)).toBe(true);
  });

  it.each([0, 90, 180, 270])('binds page transforms to every parsed row without changing row identity (%s degrees)', rotation => {
    const pixelCrop = { left: 10, top: 20, width: 500, height: 400, unit: 'pixel' as const };
    const percentCrop = { left: 5, top: 10, width: 80, height: 75, unit: 'percent' as const };
    const pages = [
      { page: 3, text: '8 AM bottle formula 60 mL; wet diaper', rotation, crop: pixelCrop },
      { page: 7, text: '9 AM unclear handwriting', rotation: 180, crop: percentCrop },
      { page: 8, text: '10 AM wet diaper' },
    ];
    const rows = parseOcrPages(pages);
    expect(rows).toHaveLength(4);
    expect(rows[0].source).toMatchObject({ page: 3, line: 1, slot: 0, rotation, crop: pixelCrop });
    expect(rows[1].source).toMatchObject({ page: 3, line: 1, slot: 1, rotation, crop: pixelCrop });
    expect(rows[2]).toMatchObject({ eventType: 'unknown', source: { page: 7, rotation: 180, crop: percentCrop } });
    expect(rows[3].source).not.toHaveProperty('rotation');
    expect(rows[3].source).not.toHaveProperty('crop');
    expect(rows.map(row => row.id)).toEqual(parseOcrPages(pages.map(({ page, text }) => ({ page, text }))).map(row => row.id));
    expect(rows.every(row => !row.approved)).toBe(true);
    expect(rows[0].source.crop).not.toBe(pixelCrop);
    expect(rows[1].source.crop).not.toBe(rows[0].source.crop);
    pixelCrop.left = 100;
    percentCrop.width = 10;
    expect(rows[0].source.crop?.left).toBe(10);
    expect(rows[1].source.crop?.left).toBe(10);
    expect(rows[2].source.crop?.width).toBe(80);
  });

  it('uses explicit supplied date as context and never invents a date from the clock', () => {
    const withoutDate = parseOcrPages([{ page: 1, text: '8 AM bottle 60 ml' }])[0];
    const supplied = parse('8 AM bottle 60 ml')[0];
    expect(withoutDate.localDate).toBeNull();
    expect(withoutDate.fieldSources.localDate).toBe('missing');
    expect(supplied.localDate).toBe('2026-04-14');
    expect(supplied.source.contextDateOrigin).toBe('user');
  });

  it('does not carry an inferred date from one page to another', () => {
    const rows = parseOcrPages([{ page: 1, text: '2026-04-14\n8 AM wet diaper' }, { page: 2, text: '9 AM wet diaper' }]);
    expect(rows[0].localDate).toBe('2026-04-14');
    expect(rows[1].localDate).toBeNull();
  });

  it('uses a dated form heading while retaining source row whitespace', () => {
    const rows = parseOcrPages([{ page: 1, text: 'Feeding and Diaper Log — Date: 2026-04-14\n  8 AM bottle 60 ml  ' }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].localDate).toBe('2026-04-14');
    expect(rows[0].source.rawText).toBe('  8 AM bottle 60 ml  ');
  });

  it.each(['04/05/2026', '4/5', '2026-02-30', '2026-4-5'])(
    'leaves the ambiguous or invalid date %s unresolved even with a default', date => {
      const row = parse(`${date} 8 AM bottle 60 ml`)[0];
      expect(row.localDate).toBeNull();
      expect(row.fieldSources.localDate).toBe('ambiguous');
    },
  );

  it.each([
    ['12:00 AM', '00:00'], ['12:00 PM', '12:00'], ['9 pm', '21:00'],
    ['13:40', '13:40'], ['00:00', '00:00'], ['noon', '12:00'], ['midnight', '00:00'],
  ])('normalizes explicit time %s without guessing', (source, expected) => {
    expect(parse(`${source} wet diaper`)[0].localTime).toBe(expected);
  });

  it.each(['8:30', '12:00', '24:00', '13 PM', '9:99 AM', '8:30 AM?'])(
    'leaves ambiguous or invalid clock %s unresolved', source => {
      expect(parse(`${source} wet diaper`)[0].localTime).toBeNull();
    },
  );

  it('accepts a bare morning clock only when the reviewer explicitly chooses 24-hour time', () => {
    expect(parseOcrPages([{ page: 1, text: '08:30 bottle 60 ml' }], { timeFormat: '24h' })[0].localTime).toBe('08:30');
    expect(parseOcrPages([{ page: 1, text: '13:30 bottle 60 ml' }], { timeFormat: '12h' })[0].localTime).toBeNull();
  });

  it.each([
    ['2.5 oz', 2.5, 'OZ'], ['1/2 oz', 0.5, 'OZ'], ['1 1/2 ounces', 1.5, 'OZ'],
    ['1½ oz', 1.5, 'OZ'], ['¾ fl. oz', 0.75, 'OZ'], ['60 mL', 60, 'ML'],
  ])('preserves quantity and unit for %s', (source, amount, unit) => {
    const row = parse(`8 AM bottle ${source}`)[0];
    expect(row).toMatchObject({ amount, unit, localDate: '2026-04-14' });
  });

  it('does not choose one of several quantities or treat a decimal comma as a different number', () => {
    expect(parse('8 AM bottle 60 ml + 30 ml')[0].amount).toBeNull();
    expect(parse('8 AM bottle 2 oz (60 ml)')[0].amount).toBeNull();
    expect(parse('8 AM bottle 2,5 oz')[0].amount).toBeNull();
    expect(parse('8 AM bottle 1/0 oz')[0].amount).toBeNull();
  });

  it('does not derive a bottle method solely from formula or breast-milk designation', () => {
    expect(parse('8 AM formula 60 ml')[0]).toMatchObject({ feedType: null, bottleType: 'Formula' });
    expect(parse('8 AM breast milk 60 ml')[0]).toMatchObject({ feedType: null, bottleType: 'Breast Milk' });
    expect(parse('8 AM nursing')[0]).toMatchObject({ feedType: 'BREAST', amount: null, unit: null });
  });

  it('keeps unknown and missing-time rows available for manual correction', () => {
    const rows = parse('wet\n8 AM ? illegible\n8 AM <script>alert(1)</script>');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ diaperType: 'WET', localTime: null });
    expect(rows[1].eventType).toBe('unknown');
    expect(rows[2].source.rawText).toContain('<script>');
    expect(rows[2].approved).toBe(false);
  });

  it('flags ambiguous and conflicting diaper descriptions without losing stool notes', () => {
    expect(parse('8 AM wet and dirty diaper, green pellets')[0]).toMatchObject({ diaperType: 'BOTH' });
    expect(parse('8 AM dry and wet diaper')[0].diaperType).toBeNull();
    expect(parse('8 AM dirty diaper, soft brown pellets')[0].notes).toContain('soft brown pellets');
    expect(parse('8 AM wet diaper, no stool')[0].diaperType).toBeNull();
    expect(parse('8 AM wet? diaper')[0].diaperType).toBeNull();
    expect(parse('8 AM dry')[0].diaperType).toBe('DRY');
  });

  it('abstains from crossed-out or negated feeding fields', () => {
    expect(parse('8 AM bottle ~~60 ml~~ 90 ml')[0].amount).toBeNull();
    expect(parse('8 AM no bottle 60 ml')[0].feedType).toBeNull();
  });

  it('extracts explicit same-day sleep and leaves a crossing-midnight end date unresolved', () => {
    const day = parse('9 AM - 10 AM nap')[0];
    expect(day).toMatchObject({ sleepType: 'NAP', localTime: '09:00', endLocalTime: '10:00', endLocalDate: '2026-04-14' });
    const night = parse('9 PM - 1 AM night sleep')[0];
    expect(night).toMatchObject({ sleepType: 'NIGHT_SLEEP', localTime: '21:00', endLocalTime: '01:00', endLocalDate: null });
    expect(parse('8 AM woke')[0]).toMatchObject({ localTime: null, endLocalTime: '08:00' });
  });

  it('retains engine score as evidence and never upgrades it into approval', () => {
    const rows = parseOcrPages([{ page: 1, text: '8 AM bottle 60 ml', confidence: 99 }, { page: 2, text: '8 AM bottle 60? ml', confidence: 12 }]);
    expect(rows[0].source.confidence).toBe(99);
    expect(rows[0].approved).toBe(false);
    expect(rows[1].warnings.some(message => message.includes('Low engine'))).toBe(true);
    expect(rows[1].amount).toBeNull();
  });

  it('bounds document parsing and rejects duplicate page IDs instead of colliding row identity', () => {
    expect(() => parseOcrPages([{ page: 1, text: '' }, { page: 1, text: '' }])).toThrow('Invalid');
    expect(() => parseOcrPages([{ page: 1, text: 'a'.repeat(4097) }])).toThrow('too long');
    expect(() => parseOcrPages([{ page: 1, text: '8 AM wet diaper\n'.repeat(501) }])).toThrow('500');
    expect(() => parseOcrPages([{ page: 1, text: '8 AM wet diaper' }], { defaultDate: 'today' })).toThrow('YYYY-MM-DD');
  });
});

describe('OCR reviewed-event validation', () => {
  it('permits incomplete draft persistence while retaining strict structural validation', () => {
    const incomplete = parseOcrPages([{ page: 1, text: 'unknown handwriting' }])[0];
    expect(validateOcrCandidate(incomplete, { allowIncomplete: true })).toMatchObject({ valid: true, candidate: { approved: false, eventType: 'unknown' } });
    expect(validateOcrCandidate(incomplete).valid).toBe(false);
    expect(validateOcrCandidate({ ...incomplete, localDate: '2026-02-30' }, { allowIncomplete: true }).valid).toBe(false);
    expect(validateOcrCandidate({ ...incomplete, localTime: '25:00' }, { allowIncomplete: true }).valid).toBe(false);
    expect(validateOcrCandidate({ ...incomplete, amount: Infinity }, { allowIncomplete: true }).valid).toBe(false);
  });
  it('requires explicit approval at commit and accepts a fully reviewed resolved record', () => {
    expect(validateOcrCandidate({ ...readyBottle(), approved: false }, { requireApproval: true }).valid).toBe(false);
    expect(validateOcrCandidate(readyBottle(), { requireApproval: true })).toMatchObject({ valid: true, errors: [], candidate: { amount: 60 } });
  });

  it('does not allow a forged approval to fill missing or ambiguous required fields', () => {
    const row = { ...parse('8:00 formula 60 ml')[0], approved: true };
    const result = validateOcrCandidate(row, { requireApproval: true });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Choose a feeding method.');
    expect(result.errors.some(error => error.includes('time'))).toBe(true);
  });

  it.each([NaN, Infinity, -1, 0, '60', 100001])('rejects unsafe quantity %s', amount => {
    expect(validateOcrCandidate({ ...readyBottle(), amount }).valid).toBe(false);
  });

  it('accepts resolved manual corrections while retaining original text and field origins', () => {
    const original = parse('8 AM bottle 6O ml')[0];
    const corrected = { ...original, amount: 60, unit: 'ML', approved: true, fieldSources: { ...original.fieldSources, amount: 'corrected' } };
    const result = validateOcrCandidate(corrected, { requireApproval: true });
    expect(result.valid).toBe(true);
    expect(result.candidate?.source.rawText).toContain('6O ml');
    expect(result.candidate?.fieldSources.amount).toBe('corrected');
  });

  it('reports unusually large quantities and future dates without claiming medical certainty', () => {
    const result = validateOcrCandidate({ ...readyBottle(), amount: 700, localDate: '2026-06-01' }, { now: new Date('2026-04-14T12:00:00Z') });
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(2);
  });

  it('rejects malformed identity, provenance, enum, notes, dates and sleep duration', () => {
    expect(validateOcrCandidate({ ...readyBottle(), id: '../row' }).valid).toBe(false);
    expect(validateOcrCandidate({ ...readyBottle(), source: { ...readyBottle().source, confidence: 110 } }).valid).toBe(false);
    expect(validateOcrCandidate({ ...readyBottle(), feedType: 'TUBE' }).valid).toBe(false);
    expect(validateOcrCandidate({ ...readyBottle(), notes: 'x'.repeat(2001) }).valid).toBe(false);
    expect(validateOcrCandidate({ ...readyBottle(), localDate: '2026-02-29' }).valid).toBe(false);
    expect(validateOcrCandidate({ ...parse('9 AM - 10 AM nap')[0], endLocalTime: '08:00', approved: true }).valid).toBe(false);
    expect(validateOcrCandidate({ ...readyBottle(), approved: 'true' }).valid).toBe(false);
  });

  it('normalizes ounces precisely without discarding the source unit', () => {
    expect(normalizeAmountMl(2, 'OZ')).toBe(59.147);
    expect(normalizeAmountMl(65, 'ML')).toBe(65);
    expect(() => normalizeAmountMl(Infinity, 'ML')).toThrow();
    expect(isOcrDate('2024-02-29')).toBe(true);
    expect(isOcrDate('2026-02-29')).toBe(false);
  });
});

describe('OCR time-zone resolution', () => {
  it('resolves ordinary wall times independent of the server time zone', () => {
    expect(resolveOcrLocalDateTime('2026-04-14', '08:30', 'America/Chicago')).toMatchObject({ status: 'valid', utc: '2026-04-14T13:30:00.000Z' });
    expect(resolveOcrLocalDateTime('2026-04-14', '00:00', 'UTC')).toMatchObject({ status: 'valid', utc: '2026-04-14T00:00:00.000Z' });
    expect(resolveOcrLocalDateTime('2026-04-14', '08:30', 'Asia/Kolkata')).toMatchObject({ status: 'valid', utc: '2026-04-14T03:00:00.000Z' });
  });

  it('blocks nonexistent spring-forward times rather than shifting them', () => {
    expect(resolveOcrLocalDateTime('2026-03-08', '02:30', 'America/Chicago')).toMatchObject({ status: 'nonexistent', utc: null, candidates: [] });
  });

  it('requires an explicit occurrence during the fall-back hour', () => {
    const unresolved = resolveOcrLocalDateTime('2026-11-01', '01:30', 'America/Chicago');
    expect(unresolved).toMatchObject({ status: 'ambiguous', utc: null, candidates: ['2026-11-01T06:30:00.000Z', '2026-11-01T07:30:00.000Z'] });
    expect(resolveOcrLocalDateTime('2026-11-01', '01:30', 'America/Chicago', { utcOffsetMinutes: -360 })).toMatchObject({ status: 'valid', utc: '2026-11-01T07:30:00.000Z' });
    expect(resolveOcrLocalDateTime('2026-11-01', '01:30', 'America/Chicago', { utcOffsetMinutes: -300 })).toMatchObject({ status: 'valid', utc: '2026-11-01T06:30:00.000Z' });
    expect(resolveOcrLocalDateTime('2026-11-01', '01:30', 'America/Chicago', { utcOffsetMinutes: 60 }).status).toBe('invalid');
  });

  it('rejects impossible dates, malformed clocks and invalid zones', () => {
    expect(resolveOcrLocalDateTime('2026-02-30', '08:30', 'UTC').status).toBe('invalid');
    expect(resolveOcrLocalDateTime('2026-04-14', '25:30', 'UTC').status).toBe('invalid');
    expect(resolveOcrLocalDateTime('2026-04-14', '08:30', 'invalid/zone').status).toBe('invalid');
  });
});
