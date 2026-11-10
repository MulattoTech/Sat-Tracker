import { describe, expect, it } from 'vitest';
import type { OcrDocument, Prisma } from '@prisma/client';
import type { OcrReviewRequest } from '@/src/lib/ocr/contracts';
import { parseOcrPages } from '@/src/lib/ocr/parser';
import { findOcrDuplicates } from '@/src/lib/ocr/review';

const document = { id: 'doc-1', familyId: 'synthetic-family', babyId: 'synthetic-child', sourceHash: 'hash-1' } as OcrDocument;
const empty = { findMany: async () => [] };
const database = { feedLog: empty, diaperLog: empty, sleepLog: empty } as unknown as Prisma.TransactionClient;
const baseline = parseOcrPages([{ page: 1, text: '08:15 bottle formula 90 mL' }], {
  defaultDate: '2026-10-20', timeFormat: '24h',
})[0];

describe('OCR duplicate comparison', () => {
  it('retains every ordered pair in the maximum 200-row repeated-event review', async () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({ ...baseline, id: `row-${index}`, approved: true }));
    const review: OcrReviewRequest = { revision: 0, rows, timeZone: 'America/Chicago' };
    const matches = await findOcrDuplicates(database, document, review);
    expect(matches).toHaveLength(200 * 199 / 2);
    expect(new Set(matches.map(match => `${match.rowId}/${match.recordId}`)).size).toBe(matches.length);
    const counts = new Map<string, number>();
    for (const match of matches) counts.set(match.rowId, (counts.get(match.rowId) || 0) + 1);
    for (let index = 0; index < rows.length; index++) expect(counts.get(rows[index].id) || 0).toBe(index);
    expect(matches[0]).toEqual({ rowId: 'row-1', recordId: 'draft:row-0', eventType: 'feed', occurredAt: '2026-10-20T13:15:00.000Z' });
    expect(matches.at(-1)).toEqual({ rowId: 'row-199', recordId: 'draft:row-198', eventType: 'feed', occurredAt: '2026-10-20T13:15:00.000Z' });
  });

  it('compares resolved instants, inclusive one-minute boundaries, event types and approval', async () => {
    const row = (id: string, time: string) => ({ ...baseline, id, localDate: '2026-11-01', localTime: time, approved: true });
    const rows = [
      row('first-occurrence', '01:30'), row('second-occurrence', '01:30'), row('one-minute', '01:31'),
      { ...row('unchecked', '01:30'), approved: false },
      { ...row('different-type', '01:30'), eventType: 'diaper' as const, diaperType: 'WET' as const },
      row('outside-window', '01:32'),
    ];
    const review: OcrReviewRequest = { revision: 0, rows, timeZone: 'America/Chicago', utcOffsets: {
      'first-occurrence': { start: -300 }, 'second-occurrence': { start: -360 }, 'one-minute': { start: -300 },
      'unchecked': { start: -300 }, 'different-type': { start: -300 }, 'outside-window': { start: -300 },
    } };
    expect(await findOcrDuplicates(database, document, review)).toEqual([
      { rowId: 'one-minute', recordId: 'draft:first-occurrence', eventType: 'feed', occurredAt: '2026-11-01T06:30:00.000Z' },
      { rowId: 'outside-window', recordId: 'draft:one-minute', eventType: 'feed', occurredAt: '2026-11-01T06:31:00.000Z' },
    ]);
  });

  it('detects exact and fuzzy duplicate feed logs by child, timestamp, and amount/type values', async () => {
    // 08:15 in America/Chicago is 13:15:00.000Z
    const exactRecord = {
      id: 'feed-exact',
      time: new Date('2026-10-20T13:15:00.000Z'),
      type: 'BOTTLE' as const,
      bottleType: 'Formula' as const,
      amount: 90,
      unitAbbr: 'ML',
    };
    const differentAmountRecord = {
      id: 'feed-different-amount',
      time: new Date('2026-10-20T13:15:30.000Z'),
      type: 'BOTTLE' as const,
      bottleType: 'Formula' as const,
      amount: 150,
      unitAbbr: 'ML',
    };
    const fuzzyTimeRecord = {
      id: 'feed-fuzzy-time',
      time: new Date('2026-10-20T13:20:00.000Z'), // 5 minutes later, matching values
      type: 'BOTTLE' as const,
      bottleType: 'Formula' as const,
      amount: 90,
      unitAbbr: 'ML',
    };
    const farAwayRecord = {
      id: 'feed-far-away',
      time: new Date('2026-10-20T14:30:00.000Z'), // 75 minutes later
      type: 'BOTTLE' as const,
      bottleType: 'Formula' as const,
      amount: 90,
      unitAbbr: 'ML',
    };

    let queriedWhere: unknown = null;
    const dbWithFeeds = {
      feedLog: {
        findMany: async (args: { where: unknown }) => {
          queriedWhere = args.where;
          return [exactRecord, differentAmountRecord, fuzzyTimeRecord, farAwayRecord];
        },
      },
      diaperLog: empty,
      sleepLog: empty,
    } as unknown as Prisma.TransactionClient;

    const row = { ...baseline, id: 'row-feed-check', approved: true };
    const review: OcrReviewRequest = { revision: 0, rows: [row], timeZone: 'America/Chicago' };

    // With detailed options
    const matches = await findOcrDuplicates(dbWithFeeds, document, review, { includeDetails: true });

    // Scoped strictly by family, child, and non-deleted
    expect(queriedWhere).toMatchObject({
      familyId: 'synthetic-family',
      babyId: 'synthetic-child',
      deletedAt: null,
    });

    // exactRecord matches exact time and exact amount/type values
    const exact = matches.find(m => m.recordId === 'feed-exact');
    expect(exact).toBeDefined();
    expect(exact?.matchType).toBe('exact');
    expect(exact?.matchedFields).toContain('amount');
    expect(exact?.matchedFields).toContain('feedType');

    // differentAmountRecord matches within 60s but different amount -> fuzzy
    const diffAmount = matches.find(m => m.recordId === 'feed-different-amount');
    expect(diffAmount).toBeDefined();
    expect(diffAmount?.matchType).toBe('fuzzy');

    // fuzzyTimeRecord is 5 minutes away with exact values -> fuzzy
    const fuzzyTime = matches.find(m => m.recordId === 'feed-fuzzy-time');
    expect(fuzzyTime).toBeDefined();
    expect(fuzzyTime?.matchType).toBe('fuzzy');
    expect(fuzzyTime?.matchedFields).toContain('fuzzyTime');

    // farAwayRecord (75m away) is NOT matched
    expect(matches.find(m => m.recordId === 'feed-far-away')).toBeUndefined();
  });

  it('detects exact and fuzzy duplicate diaper logs by type and timestamp', async () => {
    const diaperRow = {
      ...baseline,
      id: 'row-diaper',
      eventType: 'diaper' as const,
      diaperType: 'WET' as const,
      localDate: '2026-10-20',
      localTime: '09:30',
      approved: true,
    };
    // 09:30 America/Chicago is 14:30:00.000Z
    const exactDiaper = { id: 'diaper-exact', time: new Date('2026-10-20T14:30:00.000Z'), type: 'WET' };
    const differentTypeDiaper = { id: 'diaper-diff-type', time: new Date('2026-10-20T14:30:20.000Z'), type: 'DIRTY' };
    const fuzzyTimeDiaper = { id: 'diaper-fuzzy-time', time: new Date('2026-10-20T14:36:00.000Z'), type: 'WET' };
    const farAwayDiaper = { id: 'diaper-far', time: new Date('2026-10-20T16:00:00.000Z'), type: 'WET' };

    const dbWithDiapers = {
      feedLog: empty,
      diaperLog: {
        findMany: async () => [exactDiaper, differentTypeDiaper, fuzzyTimeDiaper, farAwayDiaper],
      },
      sleepLog: empty,
    } as unknown as Prisma.TransactionClient;

    const review: OcrReviewRequest = { revision: 0, rows: [diaperRow], timeZone: 'America/Chicago' };
    const matches = await findOcrDuplicates(dbWithDiapers, document, review, { includeDetails: true });

    expect(matches.find(m => m.recordId === 'diaper-exact')?.matchType).toBe('exact');
    expect(matches.find(m => m.recordId === 'diaper-diff-type')?.matchType).toBe('fuzzy');
    expect(matches.find(m => m.recordId === 'diaper-fuzzy-time')?.matchType).toBe('fuzzy');
    expect(matches.find(m => m.recordId === 'diaper-far')).toBeUndefined();
  });

  it('detects exact and fuzzy duplicate sleep logs by type and start time', async () => {
    const sleepRow = {
      ...baseline,
      id: 'row-sleep',
      eventType: 'sleep' as const,
      sleepType: 'NAP' as const,
      localDate: '2026-10-20',
      localTime: '13:00',
      endLocalDate: '2026-10-20',
      endLocalTime: '14:30',
      approved: true,
    };
    // 13:00 America/Chicago is 18:00:00.000Z
    const exactSleep = { id: 'sleep-exact', startTime: new Date('2026-10-20T18:00:00.000Z'), endTime: new Date('2026-10-20T19:30:00.000Z'), type: 'NAP' };
    const diffTypeSleep = { id: 'sleep-diff-type', startTime: new Date('2026-10-20T18:00:15.000Z'), endTime: new Date('2026-10-20T19:30:00.000Z'), type: 'NIGHT_SLEEP' };
    const fuzzyTimeSleep = { id: 'sleep-fuzzy-time', startTime: new Date('2026-10-20T18:08:00.000Z'), endTime: new Date('2026-10-20T19:30:00.000Z'), type: 'NAP' };

    const dbWithSleep = {
      feedLog: empty,
      diaperLog: empty,
      sleepLog: {
        findMany: async () => [exactSleep, diffTypeSleep, fuzzyTimeSleep],
      },
    } as unknown as Prisma.TransactionClient;

    const review: OcrReviewRequest = { revision: 0, rows: [sleepRow], timeZone: 'America/Chicago' };
    const matches = await findOcrDuplicates(dbWithSleep, document, review, { includeDetails: true });

    expect(matches.find(m => m.recordId === 'sleep-exact')?.matchType).toBe('exact');
    expect(matches.find(m => m.recordId === 'sleep-diff-type')?.matchType).toBe('fuzzy');
    expect(matches.find(m => m.recordId === 'sleep-fuzzy-time')?.matchType).toBe('fuzzy');
  });

  it('detects exact source-record duplicates from provenance ledger', async () => {
    const dbWithProvenance = {
      feedLog: empty,
      diaperLog: empty,
      sleepLog: empty,
      externalImportRecord: {
        findUnique: async (args: { where: { familyId_providerId_sourceEntityType_sourceRecordId: unknown } }) => {
          return { targetRecordId: 'feed-canonical-target-42' };
        },
      },
    } as unknown as Prisma.TransactionClient;

    const row = { ...baseline, id: 'row-provenance-test', approved: true };
    const review: OcrReviewRequest = { revision: 0, rows: [row], timeZone: 'America/Chicago' };
    const matches = await findOcrDuplicates(dbWithProvenance, document, review, { includeDetails: true });

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      rowId: 'row-provenance-test',
      recordId: 'feed-canonical-target-42',
      eventType: 'feed',
      matchType: 'exact',
      matchedFields: ['sourceRecordId'],
    });
  });

  it('keeps source identity separate and does not match across children or families', async () => {
    let capturedWhere: Record<string, unknown> = {};
    const dbSpy = {
      feedLog: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          capturedWhere = args.where;
          return [];
        },
      },
      diaperLog: empty,
      sleepLog: empty,
    } as unknown as Prisma.TransactionClient;

    const otherChildDoc = { ...document, babyId: 'child-beta', familyId: 'family-omega' } as OcrDocument;
    const row = { ...baseline, id: 'row-scoping', approved: true };
    const review: OcrReviewRequest = { revision: 0, rows: [row], timeZone: 'America/Chicago' };

    await findOcrDuplicates(dbSpy, otherChildDoc, review);

    expect(capturedWhere.familyId).toBe('family-omega');
    expect(capturedWhere.babyId).toBe('child-beta');
    expect(capturedWhere.deletedAt).toBeNull();
  });
});
