import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OcrDocument } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { sealOcrState } from '@/src/lib/ocr/crypto';
import { parseOcrPages } from '@/src/lib/ocr/parser';
import { readReviewRequest } from '@/src/lib/ocr/review';

describe('manual review of one selected PDF page', () => {
  beforeEach(() => vi.stubEnv('ENC_HASH', '44'.repeat(32)));
  afterEach(() => vi.unstubAllEnvs());

  function fixture() {
    const id = randomUUID();
    const page = { page: 5, text: '08:15 bottle formula 90 mL', engine: 'synthetic-native', confidence: null };
    const row = parseOcrPages([page], { defaultDate: '2026-10-20', timeFormat: '24h' })[0];
    const document = {
      id, familyId: 'synthetic-family', pageCount: 1,
      originalState: sealOcrState({ rows: [], pages: [page] }, `synthetic-family:${id}:original`),
    } as OcrDocument;
    return {
      document,
      input: { revision: 0, timeZone: 'America/Chicago', rows: [{ ...row, id: `manual-${randomUUID()}` }] },
    };
  }

  it('accepts a manual event on actual source page 5 when the selected-page count is 1', () => {
    const { document, input } = fixture();
    const review = readReviewRequest(input, document);
    expect(review.rows[0].source).toMatchObject({ page: 5, engine: 'manual', rawText: '', confidence: null });
    expect(review.rows[0].fieldSources.amount).toBe('corrected');
    expect(review.rows[0].approved).toBe(false);
  });

  it.each([1, 4, 6, 0, -1, 1.5])('rejects an unselected or invalid page %s', page => {
    const { document, input } = fixture();
    input.rows[0].source = { ...input.rows[0].source, page };
    expect(() => readReviewRequest(input, document)).toThrow('Select the source page');
  });
});
