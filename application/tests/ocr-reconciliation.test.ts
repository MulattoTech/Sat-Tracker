import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';
import { commitOcrReview, previewOcrReview, requireOcrDocument } from '@/src/lib/ocr/documents';
import { sealOcrState, openOcrState } from '@/src/lib/ocr/crypto';
import { parseOcrPages } from '@/src/lib/ocr/parser';
import type { OcrReviewRequest } from '@/src/lib/ocr/contracts';

const actor = { familyId: 'reconcile-family-a', actorId: null };
const otherActor = { familyId: 'reconcile-family-b', actorId: null };
let db: PrismaClient;
let directory: string;

async function draft(text: string, hash: string = randomUUID(), babyId = 'reconcile-child-a') {
  const id = randomUUID();
  const rows = parseOcrPages([{ page: 1, text, engine: 'synthetic-fixture', confidence: 95 }], { defaultDate: '2026-10-20', timeFormat: '24h' });
  return db.ocrDocument.create({ data: {
    id, familyId: actor.familyId, babyId, sourceHash: hash, originalName: 'scan-sample.png', mimeType: 'image/png', byteSize: 1024,
    previewFiles: '[]', pageCount: 1, parserVersion: 'babytracker-conservative-lines-v1', sourceTimezone: 'America/Chicago',
    sourceExpiresAt: new Date(Date.now() + 86400000),
    originalState: sealOcrState({
      rows, pages: [{ page: 1, text, engine: 'synthetic-fixture', confidence: 95 }],
      options: { rotation: 90, crop: { left: 10, top: 20, width: 300, height: 200, unit: 'pixel' }, selectedPage: 1 },
    }, `${actor.familyId}:${id}:original`),
    reviewState: sealOcrState({ rows, timeZone: 'America/Chicago' }, `${actor.familyId}:${id}:review`),
  } });
}

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'babytracker-ocr-reconciliation-'));
  const url = `file:${path.join(directory, 'synthetic.db')}`;
  process.env.ENC_HASH = '33'.repeat(32);
  process.env.BABYTRACKER_OCR_FILES_DIR = path.join(directory, 'sources');
  mkdirSync(process.env.BABYTRACKER_OCR_FILES_DIR, { recursive: true });

  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
  });
  db = new PrismaClient({ adapter: createPrismaAdapter(url) });
}, 90_000);

beforeAll(async () => {
  for (const [id, slug] of [['reconcile-family-a', 'reconcile-slug-a'], ['reconcile-family-b', 'reconcile-slug-b']]) {
    await db.family.create({ data: { id, slug, name: 'Reconciliation Family' } });
  }
  for (const [id, familyId] of [['reconcile-child-a', actor.familyId], ['reconcile-child-b', otherActor.familyId]]) {
    await db.baby.create({ data: { id, familyId, firstName: 'Reconcile', lastName: 'Baby', birthDate: new Date('2026-01-01T00:00:00Z') } });
  }
  for (const unitAbbr of ['ML', 'OZ']) {
    await db.unit.create({ data: { unitAbbr, unitName: unitAbbr } });
  }
});

afterAll(async () => {
  await db?.$disconnect();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('OCR Import Reconciliation, Deduplication, and Provenance Ledger', () => {
  it('rolls back completely on failure without leaving orphan care records, audit, or committed status', async () => {
    // Draft document with 2 events: first event is valid, second references an invalid unit that triggers a failure
    const document = await draft('10:00 wet diaper\n11:00 bottle formula 90 mL');
    const rows = openOcrState<{ rows: OcrReviewRequest['rows'] }>(document.originalState, `${actor.familyId}:${document.id}:original`).rows.map(row => ({ ...row, approved: true }));

    // Delete ML unit temporarily so the feed creation will fail
    await db.unit.delete({ where: { unitAbbr: 'ML' } });

    const diaperBefore = await db.diaperLog.count({ where: { familyId: actor.familyId } });
    const feedBefore = await db.feedLog.count({ where: { familyId: actor.familyId } });
    const provenanceBefore = await db.externalImportRecord.count({ where: { familyId: actor.familyId } });
    const auditBefore = await db.ocrAudit.count({ where: { documentId: document.id } });

    const review: OcrReviewRequest = { revision: 0, rows, timeZone: 'America/Chicago', acknowledgeWarnings: true };

    // Commit must reject
    await expect(commitOcrReview(db, actor, document.id, review)).rejects.toThrow();

    // Verify complete rollback: no partial writes or orphan records
    expect(await db.diaperLog.count({ where: { familyId: actor.familyId } })).toBe(diaperBefore);
    expect(await db.feedLog.count({ where: { familyId: actor.familyId } })).toBe(feedBefore);
    expect(await db.externalImportRecord.count({ where: { familyId: actor.familyId } })).toBe(provenanceBefore);
    expect(await db.ocrAudit.count({ where: { documentId: document.id } })).toBe(auditBefore);

    // Document must remain uncommitted and at revision 0
    const current = await requireOcrDocument(db, actor, document.id);
    expect(current.committedAt).toBeNull();
    expect(current.revision).toBe(0);

    // Restore ML unit for subsequent tests
    await db.unit.create({ data: { unitAbbr: 'ML', unitName: 'ML' } });
  });

  it('provides idempotent commits: retries return durable receipts without creating duplicate records', async () => {
    const document = await draft('08:00 wet diaper');
    const rows = openOcrState<{ rows: OcrReviewRequest['rows'] }>(document.originalState, `${actor.familyId}:${document.id}:original`).rows.map(row => ({ ...row, approved: true }));
    const review: OcrReviewRequest = { revision: 0, rows, timeZone: 'America/Chicago', acknowledgeWarnings: true };

    const firstCommit = await commitOcrReview(db, actor, document.id, review);
    expect(firstCommit.result?.created).toBe(1);
    expect(firstCommit.committedAt).not.toBeNull();

    const diaperCount = await db.diaperLog.count({ where: { familyId: actor.familyId, babyId: 'reconcile-child-a' } });
    const provenanceCount = await db.externalImportRecord.count({ where: { familyId: actor.familyId } });

    // Retry committing the exact same document and review (e.g. browser retry or network reconnection)
    const secondCommit = await commitOcrReview(db, actor, document.id, review);
    expect(secondCommit.committedAt).toBe(firstCommit.committedAt);
    expect(secondCommit.result).toEqual(firstCommit.result);

    // Care records and provenance count must NOT increase
    expect(await db.diaperLog.count({ where: { familyId: actor.familyId, babyId: 'reconcile-child-a' } })).toBe(diaperCount);
    expect(await db.externalImportRecord.count({ where: { familyId: actor.familyId } })).toBe(provenanceCount);
  });

  it('rejects attempt to alter review after document has already been committed', async () => {
    const document = await draft('12:00 wet diaper');
    const rows = openOcrState<{ rows: OcrReviewRequest['rows'] }>(document.originalState, `${actor.familyId}:${document.id}:original`).rows.map(row => ({ ...row, approved: true }));
    const review: OcrReviewRequest = { revision: 0, rows, timeZone: 'America/Chicago', acknowledgeWarnings: true };

    await commitOcrReview(db, actor, document.id, review);

    // Attempting to commit with modified notes or rows must fail with 409
    const alteredReview: OcrReviewRequest = {
      ...review,
      rows: rows.map(r => ({ ...r, notes: 'mutated post-commit' })),
    };
    await expect(commitOcrReview(db, actor, document.id, alteredReview)).rejects.toThrow('different review');
  });

  it('handles concurrent commit requests safely without race conditions or duplicate records', async () => {
    const document = await draft('14:00 wet diaper');
    const rows = openOcrState<{ rows: OcrReviewRequest['rows'] }>(document.originalState, `${actor.familyId}:${document.id}:original`).rows.map(row => ({ ...row, approved: true }));
    const review: OcrReviewRequest = { revision: 0, rows, timeZone: 'America/Chicago', acknowledgeWarnings: true };

    const initialDiaperCount = await db.diaperLog.count({ where: { time: new Date('2026-10-20T19:00:00.000Z') } });

    // Fire two commits simultaneously
    const results = await Promise.allSettled([
      commitOcrReview(db, actor, document.id, review),
      commitOcrReview(db, actor, document.id, review),
    ]);

    // At least one must succeed
    expect(results.some(r => r.status === 'fulfilled')).toBe(true);

    // Exactly one care record was created in the database
    const finalDiaperCount = await db.diaperLog.count({ where: { time: new Date('2026-10-20T19:00:00.000Z') } });
    expect(finalDiaperCount - initialDiaperCount).toBe(1);
  });

  it('preserves full provenance in the audit trail and external import ledger', async () => {
    const document = await draft('15:00 bottle formula 120 mL');
    const originalRows = openOcrState<{ rows: OcrReviewRequest['rows'] }>(document.originalState, `${actor.familyId}:${document.id}:original`).rows;

    // Reviewer approves and corrects amount to 125 mL
    const correctedRows = originalRows.map(row => ({
      ...row,
      amount: 125,
      fieldSources: { ...row.fieldSources, amount: 'corrected' as const },
      approved: true,
    }));
    const review: OcrReviewRequest = {
      revision: 0,
      rows: correctedRows,
      timeZone: 'America/Chicago',
      acknowledgeWarnings: true,
      duplicateDecisions: {},
    };

    const committed = await commitOcrReview(db, actor, document.id, review);
    expect(committed.result?.created).toBe(1);

    // 1. Verify ExternalImportRecord provenance ledger
    const ledger = await db.externalImportRecord.findFirstOrThrow({
      where: {
        familyId: actor.familyId,
        providerId: 'babytracker-ocr-v1',
        sourceRecordId: `${document.babyId}:${document.sourceHash}:${correctedRows[0].id}`,
      },
    });
    expect(ledger.targetEntityType).toBe('FeedLog');
    expect(ledger.sourceChildId).toBe(document.babyId);

    // The feed record was written with the reviewer's corrected value
    const feed = await db.feedLog.findUniqueOrThrow({ where: { id: ledger.targetRecordId } });
    expect(feed.amount).toBe(125);
    expect(feed.unitAbbr).toBe('ML');

    // 2. Verify encrypted OcrAudit trail snapshot
    const auditRecord = await db.ocrAudit.findFirstOrThrow({
      where: { documentId: document.id, action: 'commit' },
    });
    const snapshot = openOcrState<{
      parserVersion: string;
      documentId: string;
      sourceDocument: { rotation: number; crop: unknown; originalName: string };
      rawFields: { rowId: string; rawText: string; page: number }[];
      reviewerDecisions: { approvedRowIds: string[]; timeZone: string };
    }>(auditRecord.snapshot, `${actor.familyId}:${document.id}:audit`);

    expect(snapshot.parserVersion).toBe('babytracker-conservative-lines-v1');
    expect(snapshot.documentId).toBe(document.id);
    expect(snapshot.sourceDocument.originalName).toBe('scan-sample.png');
    expect(snapshot.sourceDocument.rotation).toBe(90);
    expect(snapshot.sourceDocument.crop).toEqual({ left: 10, top: 20, width: 300, height: 200, unit: 'pixel' });
    expect(snapshot.rawFields[0].rawText).toContain('15:00 bottle formula 120 mL');
    expect(snapshot.reviewerDecisions.approvedRowIds).toContain(correctedRows[0].id);
  });

  it('re-importing via a rescan flags existing records as duplicates without creating duplicate records', async () => {
    // 1. Create and commit document A
    const docA = await draft('07:30 wet diaper', 'initial-scan-hash');
    const rowsA = openOcrState<{ rows: OcrReviewRequest['rows'] }>(docA.originalState, `${actor.familyId}:${docA.id}:original`).rows.map(r => ({ ...r, approved: true }));
    const reviewA: OcrReviewRequest = { revision: 0, rows: rowsA, timeZone: 'America/Chicago', acknowledgeWarnings: true };
    await commitOcrReview(db, actor, docA.id, reviewA);

    const diaperCountBefore = await db.diaperLog.count({ where: { familyId: actor.familyId } });

    // 2. Create document B (a rescan with a new hash, but same event at 07:30)
    const docB = await draft('07:30 wet diaper', 'rescan-hash-beta');
    const rowsB = openOcrState<{ rows: OcrReviewRequest['rows'] }>(docB.originalState, `${actor.familyId}:${docB.id}:original`).rows.map(r => ({ ...r, approved: true }));

    // Preview on docB must detect the duplicate timeline event
    const preview = await previewOcrReview(db, actor, docB.id, { revision: 0, rows: rowsB, timeZone: 'America/Chicago' });
    expect(preview.duplicates).toHaveLength(1);

    // Committing with decision 'skip' skips the row
    const reviewB: OcrReviewRequest = {
      revision: 0,
      rows: rowsB,
      timeZone: 'America/Chicago',
      acknowledgeWarnings: true,
      duplicateDecisions: { [rowsB[0].id]: 'skip' },
    };
    const commitB = await commitOcrReview(db, actor, docB.id, reviewB);

    expect(commitB.result?.created).toBe(0);
    expect(commitB.result?.skipped).toBe(1);
    expect(await db.diaperLog.count({ where: { familyId: actor.familyId } })).toBe(diaperCountBefore);
  });
});
