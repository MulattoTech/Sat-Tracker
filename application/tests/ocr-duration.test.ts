import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { OcrDocument } from '@prisma/client';
import { parseOcrPages } from '@/src/lib/ocr/parser';
import { validateOcrCandidate } from '@/src/lib/ocr/validation';
import { readReviewRequest, reviewHash, toSproutRecords } from '@/src/lib/ocr/review';
import { sealOcrState } from '@/src/lib/ocr/crypto';
import { editOcrRow, manualOcrRow, mergeOcrRows } from '@/src/components/OcrImport/review-helpers';

const parse = (text: string) => parseOcrPages([{ page: 1, text }], { defaultDate: '2026-10-20', timeFormat: '24h' });
const previousKey = process.env.ENC_HASH;
afterAll(() => { if (previousKey === undefined) delete process.env.ENC_HASH; else process.env.ENC_HASH = previousKey; });
beforeAll(() => { process.env.ENC_HASH = '66'.repeat(32); });

describe('structured OCR feeding duration', () => {
  it.each([
    ['duration: 20 minutes', 1200], ['duration=15min30sec', 930],
    ['feeding duration: 1 h 5 min', 3900], ['duration: 1.25 minutes', 75],
    ['duration: 1200 s', 1200], ['duration: 0.5h', 1800],
    ['duration: 1 minute and 1 second', 61], ['duration: 24h', 86400],
  ])('normalizes %s to whole seconds without changing the feeding clock', (value, seconds) => {
    const rows = parse('08:15 bottle formula 90 mL; ' + value);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ feedDuration: seconds, localTime: '08:15', amount: 90, approved: false });
    expect(rows[0].fieldSources.feedDuration).toBe('source');
  });

  it('extracts explicit nursing duration without requiring bottle volume', () => {
    const row = parse('08:15 nursed for 15 minutes')[0];
    expect(row).toMatchObject({ feedType: 'BREAST', amount: null, feedDuration: 900 });
    expect(validateOcrCandidate(row).valid).toBe(true);
  });

  it.each([
    'duration: 15-20 min', 'duration: 20 min?', 'duration: 15 or 20 minutes',
    'duration: 1,5 minutes', 'duration: -20 minutes', 'duration: +20 minutes',
    'duration: 0 seconds', 'duration: 25 hours', 'duration: 0.001 minute',
    'duration: 20', 'duration: 20:30', 'duration: illegible',
    'duration: 15 min 20 min', 'duration: 20 min; duration: 20 min',
    'not duration: 20 minutes', 'duration: about 20 minutes',
  ])('abstains from %s and preserves the source for correction', text => {
    const row = parse('08:15 bottle formula 90 mL; ' + text)[0];
    expect(row.feedDuration).toBeNull();
    expect(row.fieldSources.feedDuration).toBe('ambiguous');
    expect(row.source.rawText).toContain(text);
    expect(row.approved).toBe(false);
  });

  it('never infers absent duration from clocks, volumes or named metadata', () => {
    for (const text of [
      '08:15 bottle formula 90 mL', '08:15-08:35 bottle formula 90 mL',
      '08:15 bottle formula 90 mL; caregiver: Duration 20 min',
      '08:15 bottle formula 90 mL; burped after 20 min',
      '08:15 wet diaper; duration: 20 min',
    ]) expect(parse(text)[0].feedDuration).toBeNull();
  });

  it.each([-1, 0, 1.5, 86401, Infinity, NaN, '1200', true, {}])('rejects invalid reviewer duration %s before persistence', feedDuration => {
    const row = { ...parse('08:15 bottle formula 90 mL')[0], feedDuration };
    expect(validateOcrCandidate(row, { allowIncomplete: true }).valid).toBe(false);
  });

  it('warns on unusually long durations and supports missing/cleared durations', () => {
    const row = parse('08:15 bottle formula 90 mL')[0];
    expect(validateOcrCandidate({ ...row, feedDuration: 7201 }).warnings).toContain('Feeding duration exceeds two hours; compare it with the source before approving.');
    expect(validateOcrCandidate({ ...row, feedDuration: null }).candidate?.feedDuration).toBeNull();
    expect(validateOcrCandidate({ ...row, feedDuration: undefined }).candidate).not.toHaveProperty('feedDuration');
  });

  it('preserves reviewed seconds and server-owned field provenance in the canonical adapter', () => {
    const row = parse('08:15 bottle formula 90 mL; duration: 20 minutes')[0];
    const id = randomUUID();
    const document = { id, familyId: 'duration-family', babyId: 'duration-child', sourceHash: 'synthetic',
      originalState: sealOcrState({ rows: [row], pages: [{ page: 1, text: row.source.rawText }] }, `duration-family:${id}:original`),
    } as OcrDocument;
    const input = { revision: 0, timeZone: 'UTC', rows: [{ ...row, feedDuration: 1350, approved: true, fieldSources: { feedDuration: 'source' } }] };
    const review = readReviewRequest(input, document);
    expect(review.rows[0].fieldSources.feedDuration).toBe('corrected');
    expect(toSproutRecords(document, review)[0]).toMatchObject({ targetType: 'feed', feedDuration: 1350 });
    expect(reviewHash(review)).not.toBe(reviewHash({ ...review, rows: [{ ...review.rows[0], feedDuration: 1200 }] }));
  });

  it('keeps older saved reviews byte-equivalent for lost-response receipt replay', () => {
    const row = { ...parse('08:15 bottle formula 90 mL')[0], rejected: false };
    delete row.feedDuration; delete row.fieldSources.feedDuration;
    const id = randomUUID();
    const document = { id, familyId: 'duration-family',
      originalState: sealOcrState({ rows: [row], pages: [{ page: 1, text: row.source.rawText }] }, `duration-family:${id}:original`),
    } as OcrDocument;
    const input = { revision: 0, timeZone: 'UTC', rows: [row] };
    const review = readReviewRequest(input, document);
    expect(review.rows[0]).not.toHaveProperty('feedDuration');
    expect(review.rows[0].fieldSources).not.toHaveProperty('feedDuration');
    expect(reviewHash(review)).toBe(reviewHash(input));
  });

  it('supports manual entry and merging, with renewed approval after every duration edit', () => {
    expect(manualOcrRow(1, randomUUID()).feedDuration).toBeNull();
    const row = parse('08:15 bottle formula 90 mL')[0];
    const edited = editOcrRow({ ...row, approved: true }, { feedDuration: 600 });
    expect(edited).toMatchObject({ approved: false, feedDuration: 600, fieldSources: { feedDuration: 'corrected' } });
    const source = parse('08:15 bottle formula 90 mL; duration: 15min')[0];
    expect(mergeOcrRows(row, source)).toMatchObject({ approved: false, feedDuration: 900 });
    expect(mergeOcrRows(edited, source).feedDuration).toBe(600);
  });
});
