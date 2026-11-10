import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OcrDocument } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { parseOcrPages } from '@/src/lib/ocr/parser';
import { validateOcrCandidate } from '@/src/lib/ocr/validation';
import { readReviewRequest, reviewHash, toSproutRecords } from '@/src/lib/ocr/review';
import { sealOcrState } from '@/src/lib/ocr/crypto';
import { editOcrRow, mergeOcrRows } from '@/src/components/OcrImport/review-helpers';

const metadataFields = ['offeredAmount', 'formulaKcalOz', 'formulaName', 'bottleLabel', 'sourceCaregiverName'] as const;
const parse = (text: string) => parseOcrPages([{ page: 1, text, engine: 'synthetic-text', confidence: null }], {
  defaultDate: '2026-10-20', timeFormat: '24h',
});
const full = '08:15 bottle formula; offered: 120 mL; consumed: 90 mL; concentration: 22 kcal/oz; formula name: Example Brand; bottle id: A-1; caregiver: Test Parent';

describe('explicit bottle details in OCR review', () => {
  beforeEach(() => vi.stubEnv('ENC_HASH', '55'.repeat(32)));
  afterEach(() => vi.unstubAllEnvs());

  it('distinguishes explicitly offered and consumed quantities in a single event', () => {
    const rows = parse('08:15 bottle formula offered 120 mL consumed 90 mL');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: 90, offeredAmount: 120, unit: 'ML', approved: false });
    expect(validateOcrCandidate(rows[0]).valid).toBe(true);
  });

  it('does not turn an offered-only or unlabelled remaining quantity into consumption', () => {
    for (const text of ['08:15 bottle offered 120 mL', '08:15 bottle offered 120 mL remaining 30 mL']) {
      const row = parse(text)[0];
      expect(row.amount).toBeNull();
      expect(row.offeredAmount).toBe(120);
      expect(validateOcrCandidate(row).valid).toBe(false);
    }
  });

  it.each(['remaining 30 mL', '30 mL left', 'leftover 30 mL', 'unused 30 mL', 'discarded 30 mL', 'spilled 30 mL'])('does not count residual quantity %s as consumption', quantity => {
    const row = parse('08:15 bottle formula ' + quantity)[0];
    expect(row.amount).toBeNull();
    expect(row.offeredAmount).toBeNull();
    expect(validateOcrCandidate(row).valid).toBe(false);
  });

  it.each(['consumed 90 mL offered', '90 mL consumed 120 mL offered', 'remaining 30 mL consumed', 'not consumed 90 mL'])('abstains when quantity labels conflict or are negated: %s', quantity => {
    const row = parse('08:15 bottle formula ' + quantity)[0];
    expect(row.amount).toBeNull();
    expect(row.offeredAmount).toBeNull();
    expect(row.fieldSources.amount).toBe('ambiguous');
    expect(validateOcrCandidate(row).valid).toBe(false);
  });

  it('accepts unambiguous suffix labels separated by punctuation', () => {
    expect(parse('08:15 bottle formula 90 mL consumed, 120 mL offered')[0]).toMatchObject({
      amount: 90, offeredAmount: 120, unit: 'ML',
    });
  });

  it('ignores quantity-role words inside explicitly labelled names', () => {
    expect(parse('08:15 bottle formula 90 mL; caregiver: Left; bottle id: Consumed')[0]).toMatchObject({
      amount: 90, unit: 'ML', sourceCaregiverName: 'Left', bottleLabel: 'Consumed',
    });
  });

  it('normalizes explicitly recorded mixed units into the consumed unit', () => {
    expect(parse('08:15 bottle offered 4 oz consumed 90 mL')[0]).toMatchObject({
      amount: 90, offeredAmount: 118.294118, unit: 'ML',
    });
  });

  it('preserves ordinary single-quantity behavior and abstains on ambiguous unlabelled quantities', () => {
    expect(parse('08:15 bottle 90 mL')[0]).toMatchObject({ amount: 90, offeredAmount: null, unit: 'ML' });
    expect(parse('08:15 bottle 120 mL 90 mL')[0].amount).toBeNull();
  });

  it('keeps labelled metadata cells together and never fabricates a caregiver account', () => {
    const rows = parse(full);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amount: 90, offeredAmount: 120, formulaKcalOz: 22,
      formulaName: 'Example Brand', bottleLabel: 'A-1', sourceCaregiverName: 'Test Parent',
    });
    expect(rows[0]).not.toHaveProperty('caretakerId');
  });

  it('does not extract a free-form name, guess a range or fill absent fields', () => {
    const bare = parse('08:15 bottle formula 90 mL Example Brand Test Parent')[0];
    expect(bare.formulaName).toBeNull(); expect(bare.sourceCaregiverName).toBeNull();
    for (const concentration of ['20-22 kcal/oz', '20 to 22 kcal/oz', '22 kcal/oz?', '22 kcal/100mL']) {
      expect(parse('08:15 bottle 90 mL; concentration: ' + concentration)[0].formulaKcalOz).toBeNull();
    }
    const repeated = parse('08:15 bottle 90 mL; caregiver: First; caregiver: Second')[0];
    expect(repeated.sourceCaregiverName).toBeNull();
    expect(repeated.fieldSources.sourceCaregiverName).toBe('ambiguous');
  });

  it('rejects invalid quantities, overlong metadata and consumed-greater-than-offered corrections', () => {
    const row = parse(full)[0];
    expect(validateOcrCandidate({ ...row, offeredAmount: 80 }).valid).toBe(false);
    expect(validateOcrCandidate({ ...row, offeredAmount: -1 }).valid).toBe(false);
    expect(validateOcrCandidate({ ...row, formulaKcalOz: 0 }).valid).toBe(false);
    expect(validateOcrCandidate({ ...row, formulaKcalOz: 61 }).valid).toBe(false);
    expect(validateOcrCandidate({ ...row, formulaName: 'x'.repeat(121) }).valid).toBe(false);
    expect(validateOcrCandidate({ ...row, bottleLabel: 'x'.repeat(81) }).valid).toBe(false);
    expect(validateOcrCandidate({ ...row, sourceCaregiverName: 'Test\u0000Parent' }).valid).toBe(false);
  });

  it('rejects contradictory approval and rejection at the server review boundary', () => {
    const row = { ...parse(full)[0], approved: true, rejected: true }, id = randomUUID();
    const document = {
      id, familyId: 'reject-family', pageCount: 1,
      originalState: sealOcrState({ rows: [row], pages: [{ page: 1, text: full, engine: 'synthetic', confidence: null }] }, 'reject-family:' + id + ':original'),
    } as OcrDocument;
    expect(validateOcrCandidate(row).errors).toContain('A rejected event cannot also be approved.');
    expect(() => readReviewRequest({ revision: 0, timeZone: 'UTC', rows: [row] }, document))
      .toThrow('A rejected event cannot also be approved.');
  });

  it('clears approval on rich-field corrections and retains metadata when merging empty fields', () => {
    const source = { ...parse(full)[0], approved: true };
    const corrected = editOcrRow(source, { offeredAmount: 125, formulaName: 'Corrected Brand' });
    expect(corrected.approved).toBe(false);
    expect(corrected.fieldSources.offeredAmount).toBe('corrected');
    const empty = { ...source, offeredAmount: undefined, formulaName: undefined };
    expect(mergeOcrRows(empty, corrected)).toMatchObject({ offeredAmount: 125, formulaName: 'Corrected Brand', approved: false });
  });

  it('converts copied offered volume into the target consumed unit when merging', () => {
    const target = parse('08:15 bottle consumed 3 oz')[0];
    const source = parse('08:15 bottle offered 120 mL')[0];
    const merged = mergeOcrRows({ ...target, approved: true }, source);
    expect(merged).toMatchObject({ amount: 3, offeredAmount: 4.057683, unit: 'OZ', approved: false });
    expect(merged.fieldSources.offeredAmount).toBe('corrected');
    expect(validateOcrCandidate(merged).valid).toBe(true);
  });

  it('converts copied consumed volume into the target offered unit when merging', () => {
    const merged = mergeOcrRows(parse('08:15 bottle offered 4 oz')[0], parse('08:15 bottle consumed 90 mL')[0]);
    expect(merged).toMatchObject({ amount: 3.043262, offeredAmount: 4, unit: 'OZ', approved: false });
    expect(validateOcrCandidate(merged).valid).toBe(true);
    const milliliters = mergeOcrRows(parse('08:15 bottle offered 120 mL')[0], parse('08:15 bottle consumed 3 oz')[0]);
    expect(milliliters).toMatchObject({ amount: 88.720589, offeredAmount: 120, unit: 'ML' });
  });

  it('does not assign a source unit to an existing quantity whose unit is unknown', () => {
    const target = { ...parse('08:15 bottle consumed 3 oz')[0], unit: null };
    const merged = mergeOcrRows(target, parse('08:15 bottle offered 120 mL')[0]);
    expect(merged).toMatchObject({ amount: 3, offeredAmount: null, unit: null });
    expect(merged.fieldSources.unit).toBe('ambiguous');
    expect(validateOcrCandidate(merged).valid).toBe(false);
  });

  it('leaves copied quantities unresolved when the source quantity has no unit', () => {
    const source = { ...parse('08:15 bottle consumed 90 mL')[0], unit: null };
    const merged = mergeOcrRows(parse('08:15 bottle offered 120 mL')[0], source);
    expect(merged).toMatchObject({ amount: null, offeredAmount: 120, unit: 'ML' });
    expect(merged.fieldSources.amount).toBe('ambiguous');
    expect(validateOcrCandidate(merged).valid).toBe(false);
  });

  it('preserves corrected metadata through server validation and canonical import mapping', () => {
    const row = parse(full)[0], id = randomUUID();
    const document = {
      id, familyId: 'rich-family', babyId: 'rich-child', sourceHash: 'synthetic-hash', pageCount: 1,
      originalState: sealOcrState({ rows: [row], pages: [{ page: 1, text: full, engine: 'synthetic', confidence: null }] }, 'rich-family:' + id + ':original'),
    } as OcrDocument;
    const review = readReviewRequest({
      revision: 0, timeZone: 'America/Chicago', acknowledgeWarnings: true,
      rows: [{ ...row, approved: true, offeredAmount: 125, formulaName: 'Corrected Brand' }],
    }, document);
    expect(review.rows[0].fieldSources.formulaName).toBe('corrected');
    expect(review.rows[0].fieldSources.sourceCaregiverName).toBe('source');
    expect(toSproutRecords(document, review)[0]).toMatchObject({
      targetType: 'feed', amount: 90, offeredAmount: 125, unitAbbr: 'ML', formulaKcalOz: 22,
      formulaName: 'Corrected Brand', bottleLabel: 'A-1', sourceCaregiverName: 'Test Parent',
    });
  });

  it('keeps absent optional fields absent in legacy drafts so prior receipt hashes do not change', () => {
    const row = { ...parse('08:15 bottle formula 90 mL')[0], rejected: false };
    for (const field of metadataFields) { delete row[field]; delete row.fieldSources[field]; }
    const id = randomUUID();
    const document = {
      id, familyId: 'legacy-family', pageCount: 1,
      originalState: sealOcrState({ rows: [row], pages: [{ page: 1, text: 'synthetic', engine: 'synthetic', confidence: null }] }, 'legacy-family:' + id + ':original'),
    } as OcrDocument;
    const input = { revision: 0, timeZone: 'UTC', rows: [row], utcOffsets: {}, duplicateDecisions: {} };
    const review = readReviewRequest(input, document);
    for (const field of metadataFields) {
      expect(review.rows[0]).not.toHaveProperty(field);
      expect(review.rows[0].fieldSources).not.toHaveProperty(field);
    }
    expect(reviewHash(review)).toBe(reviewHash(input));
  });
});
