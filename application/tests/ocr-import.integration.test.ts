import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';
import { createOcrDocument, commitOcrReview, previewOcrReview, saveOcrReview, purgeOcrSource, readOcrSource, requireOcrDocument } from '@/src/lib/ocr/documents';
import { sealOcrState, openOcrState } from '@/src/lib/ocr/crypto';
import { parseOcrPages } from '@/src/lib/ocr/parser';
import type { OcrDocumentView, OcrReviewRequest } from '@/src/lib/ocr/contracts';
import sharp from 'sharp';
import { sweepOcrRetention } from '@/src/lib/ocr/retention';
import { reviewHash } from '@/src/lib/ocr/review';
import { vi } from 'vitest';

vi.mock('@/src/lib/ocr/intake', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/ocr/intake')>();
  if (process.platform === 'linux') return actual;
  return {
    ...actual,
    recognizeOcrDocument: async (bytes: Buffer, optionsOrRotation: any = 0) => {
      const options = typeof optionsOrRotation === 'number' ? { rotation: optionsOrRotation } : (optionsOrRotation || {});
      const image = await actual.applyImageTransform(bytes, { rotation: options.rotation, crop: options.crop });
      return [{
        page: 1,
        text: '08:15 bottle formula 90 mL; duration: 20 min\n09:30 wet diaper',
        confidence: 95,
        engine: 'synthetic-windows-test-engine',
        image,
        ...(options.rotation ? { rotation: options.rotation } : {}),
        ...(options.crop ? { crop: options.crop } : {}),
      }];
    },
  };
});

const actor = { familyId: 'ocr-family-a', actorId: null };
const other = { familyId: 'ocr-family-b', actorId: null };
let db: PrismaClient;
let directory: string;
const sources: string[] = [];
const reviewOf = (document: OcrDocumentView): OcrReviewRequest => ({
  revision: document.revision, timeZone: 'America/Chicago', rows: document.rows,
  acknowledgeWarnings: true, duplicateDecisions: {}, utcOffsets: {},
});

async function draft(text: string, hash: string = randomUUID(), babyId = 'ocr-child-a') {
  const id = randomUUID();
  const rows = parseOcrPages([{ page: 1, text, engine: 'synthetic-fixture', confidence: null }], { defaultDate: '2026-10-20', timeFormat: '24h' });
  return db.ocrDocument.create({ data: {
    id, familyId: actor.familyId, babyId, sourceHash: hash, originalName: 'synthetic.txt', mimeType: 'image/png', byteSize: 1,
    previewFiles: '[]', pageCount: 1, parserVersion: 'test', sourceTimezone: 'America/Chicago', sourceExpiresAt: new Date(Date.now() + 86400000),
    originalState: sealOcrState({ rows, pages: [] }, `${actor.familyId}:${id}:original`),
    reviewState: sealOcrState({ rows, timeZone: 'America/Chicago' }, `${actor.familyId}:${id}:review`),
  } });
}

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'babytracker-ocr-integration-'));
  const url = `file:${path.join(directory, 'synthetic.db')}`;
  process.env.ENC_HASH = '11'.repeat(32);
  process.env.BABYTRACKER_OCR_FILES_DIR = path.join(directory, 'sources');
  mkdirSync(process.env.BABYTRACKER_OCR_FILES_DIR, { recursive: true });
  // Real versioned SQLite migrations, in a fresh disposable database only.
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
  });
  db = new PrismaClient({ adapter: createPrismaAdapter(url) });
}, 90_000);

beforeAll(async () => {
  for (const [id, slug] of [['ocr-family-a', 'synthetic-a'], ['ocr-family-b', 'synthetic-b']]) await db.family.create({ data: { id, slug, name: 'Synthetic test family' } });
  for (const [id, familyId] of [['ocr-child-a', actor.familyId], ['ocr-child-a2', actor.familyId], ['ocr-child-b', other.familyId]]) {
    await db.baby.create({ data: { id, familyId, firstName: 'Synthetic', lastName: 'Fixture', birthDate: new Date('2026-01-01T00:00:00Z') } });
  }
  for (const unitAbbr of ['ML', 'OZ']) await db.unit.create({ data: { unitAbbr, unitName: unitAbbr } });
});

afterAll(async () => {
  for (const id of sources) await purgeOcrSource(db, actor, id);
  await db?.$disconnect();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('OCR → review → canonical Sprout import on a real SQLite database', () => {
  it('recognizes a transformed real image, binds row provenance and saves exact approved events', async () => {
    const image = await sharp(Buffer.from('<svg width="1700" height="700" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><g font-family="DejaVu Sans" font-size="48"><text x="60" y="130">08:15 bottle formula 90 mL; duration: 20 min</text><text x="60" y="280">09:30 wet diaper</text></g></svg>')).rotate(270).png().toBuffer();
    // Crop coordinates belong to the upright page AFTER the requested rotation.
    const crop = { left: 30, top: 50, width: 1640, height: 400, unit: 'pixel' as const };
    const document = await createOcrDocument(db, actor, { bytes: image, name: 'synthetic-sheet.png', babyId: 'ocr-child-a', timeZone: 'America/Chicago', defaultDate: '2026-10-20', timeFormat: '24h', rotation: 90, crop, retentionDays: 30 });
    sources.push(document.id);
    expect(document.rows.filter(row => ['feed', 'diaper'].includes(row.eventType))).toHaveLength(2);
    expect(await db.feedLog.count()).toBe(0);
    expect(await db.diaperLog.count()).toBe(0);
    expect((await readOcrSource(db, actor, document.id)).bytes.equals(image)).toBe(true);
    const preview = await readOcrSource(db, actor, document.id, 1);
    expect(await sharp(preview.bytes).metadata()).toMatchObject({ width: crop.width, height: crop.height });
    for (const row of [...document.rows, ...document.originalRows]) {
      expect(row.source).toMatchObject({ page: 1, rotation: 90, crop });
      expect(row.approved).toBe(false);
    }
    const stored = await requireOcrDocument(db, actor, document.id);
    expect(readFileSync(path.join(process.env.BABYTRACKER_OCR_FILES_DIR!, stored.sourceFile!)).equals(image)).toBe(false);
    const review = reviewOf(document);
    review.rows = review.rows.map(row => ({
      ...row, amount: row.eventType === 'feed' ? 95 : row.amount, approved: true,
      // A review client cannot replace the transform bound by server recognition.
      source: { ...row.source, rotation: 0, crop: { left: 0, top: 0, width: 1, height: 1 } },
    }));
    const saved = await saveOcrReview(db, actor, document.id, review);
    expect(saved.originalRows.find(row => row.eventType === 'feed')?.amount).toBe(90);
    expect(saved.rows.find(row => row.eventType === 'feed')?.fieldSources.amount).toBe('corrected');
    expect(saved.rows.every(row => row.source.rotation === 90)).toBe(true);
    expect(saved.rows.map(row => row.source.crop)).toEqual(saved.rows.map(() => crop));
    review.revision = saved.revision;
    const committed = await commitOcrReview(db, actor, document.id, review);
    expect(committed.result?.created).toBe(2);
    const feed = await db.feedLog.findFirstOrThrow();
    expect({ amount: feed.amount, unit: feed.unitAbbr, bottle: feed.bottleType, time: feed.time.toISOString() }).toEqual({ amount: 95, unit: 'ML', bottle: 'Formula', time: '2026-10-20T13:15:00.000Z' });
    expect(feed.feedDuration).toBe(1200);
    expect(await db.diaperLog.count()).toBe(1);
    expect(await db.externalImportRecord.count()).toBe(2);
    expect(await db.ocrAudit.count({ where: { documentId: document.id, action: 'commit' } })).toBe(1);
    const commitAudit = await db.ocrAudit.findFirstOrThrow({ where: { documentId: document.id, action: 'commit' } });
    const audit = openOcrState<{ review: OcrReviewRequest }>(commitAudit.snapshot, `${actor.familyId}:${document.id}:audit`);
    expect(audit.review.rows.map(row => row.source.crop)).toEqual(document.rows.map(() => crop));
    expect(audit.review.rows.every(row => row.source.rotation === 90)).toBe(true);
    // Network-loss retry and exact duplicate file return the same durable receipt.
    expect((await commitOcrReview(db, actor, document.id, review)).result).toEqual(committed.result);
    const duplicateUpload = await createOcrDocument(db, actor, { bytes: image, name: 'renamed.png', babyId: 'ocr-child-a', timeZone: 'UTC', timeFormat: 'unknown', rotation: 0, retentionDays: 30 });
    expect(duplicateUpload.id).toBe(document.id);
    expect(await db.feedLog.count()).toBe(1);
    await expect(commitOcrReview(db, actor, document.id, { ...review, rows: review.rows.map(row => ({ ...row, notes: 'changed after commit' })) })).rejects.toThrow('different review');
  }, 60_000);

  it('denies cross-family sources, drafts, previews and commits', async () => {
    const document = await draft('11:00 wet diaper');
    await expect(requireOcrDocument(db, other, document.id)).rejects.toThrow('not found');
    await expect(readOcrSource(db, other, document.id)).rejects.toThrow('not found');
    await expect(saveOcrReview(db, other, document.id, {})).rejects.toThrow('not found');
    await expect(previewOcrReview(db, other, document.id, {})).rejects.toThrow('not found');
    await expect(commitOcrReview(db, other, document.id, {})).rejects.toThrow('not found');
    await expect(createOcrDocument(db, actor, { bytes: Buffer.from('invalid'), name: 'x', babyId: 'ocr-child-b', timeZone: 'UTC', timeFormat: '24h', rotation: 0, retentionDays: 30 })).rejects.toThrow('Select a baby');
  });

  it('requires approval, explicit final confirmation, resolved fields and trustworthy source IDs', async () => {
    const document = await draft('12:00 bottle formula 80 mL\n13:00 wet diaper');
    const rows = openOcrState<{ rows: OcrReviewRequest['rows'] }>(document.originalState, `${actor.familyId}:${document.id}:original`).rows;
    const review = { revision: 0, rows, timeZone: 'America/Chicago', acknowledgeWarnings: true };
    await expect(commitOcrReview(db, actor, document.id, review)).rejects.toThrow('Approve');
    const approved = { ...review, rows: rows.map(row => ({ ...row, approved: true })) };
    await expect(commitOcrReview(db, actor, document.id, { ...approved, acknowledgeWarnings: false })).rejects.toThrow('Confirm');
    await expect(commitOcrReview(db, actor, document.id, { ...approved, rows: approved.rows.map(row => ({ ...row, localDate: null })) })).rejects.toThrow('unresolved');
    await expect(commitOcrReview(db, actor, document.id, { ...approved, rows: approved.rows.map(row => ({ ...row, id: 'forged-row' })) })).rejects.toThrow('unknown source');
    expect((await db.ocrDocument.findUniqueOrThrow({ where: { id: document.id } })).committedAt).toBeNull();
  });

  it('flags transformed rescans and preserves a deliberate same-time event after explicit keep', async () => {
    const document = await draft('09:30 wet diaper');
    const rows = openOcrState<{ rows: OcrReviewRequest['rows'] }>(document.originalState, `${actor.familyId}:${document.id}:original`).rows.map(row => ({ ...row, approved: true }));
    const review = { revision: 0, rows, timeZone: 'America/Chicago', acknowledgeWarnings: true };
    const preview = await previewOcrReview(db, actor, document.id, review);
    expect(preview.duplicates).toHaveLength(1);
    await expect(commitOcrReview(db, actor, document.id, review)).rejects.toThrow('duplicate');
    const kept = await commitOcrReview(db, actor, document.id, { ...review, duplicateDecisions: { [rows[0].id]: 'keep' } });
    expect(kept.result?.created).toBe(1);
  });

  it('keeps source identity separate for different children', async () => {
    const document = await draft('09:30 wet diaper', 'same-source-hash', 'ocr-child-a2');
    const rows = openOcrState<{ rows: OcrReviewRequest['rows'] }>(document.originalState, `${actor.familyId}:${document.id}:original`).rows.map(row => ({ ...row, approved: true }));
    const review = { revision: 0, rows, timeZone: 'America/Chicago', acknowledgeWarnings: true };
    expect((await previewOcrReview(db, actor, document.id, review)).duplicates).toHaveLength(0);
    await commitOcrReview(db, actor, document.id, review);
    expect(await db.diaperLog.count({ where: { babyId: 'ocr-child-a2' } })).toBe(1);
  });

  it('records an explicit all-duplicate skip without creating an event or requiring another import', async () => {
    const document = await draft('09:30 wet diaper');
    const rows = openOcrState<{ rows: OcrReviewRequest['rows'] }>(document.originalState, `${actor.familyId}:${document.id}:original`).rows.map(row => ({ ...row, approved: true }));
    const before = await db.diaperLog.count();
    const result = await commitOcrReview(db, actor, document.id, { revision: 0, rows, timeZone: 'America/Chicago', acknowledgeWarnings: true, duplicateDecisions: { [rows[0].id]: 'skip' } });
    expect(result.result?.created).toBe(0);
    expect(result.result?.skipped).toBe(1);
    expect(result.committedAt).not.toBeNull();
    expect(await db.diaperLog.count()).toBe(before);
  });

  it('rolls back every row, the claimed document and provenance when a later canonical write fails', async () => {
    const document = await draft('16:00 wet diaper\n17:00 bottle formula 4 oz');
    const rows = openOcrState<{ rows: OcrReviewRequest['rows'] }>(document.originalState, `${actor.familyId}:${document.id}:original`).rows.map(row => ({ ...row, approved: true }));
    await db.unit.delete({ where: { unitAbbr: 'OZ' } });
    const before = await db.diaperLog.count();
    await expect(commitOcrReview(db, actor, document.id, { revision: 0, rows, timeZone: 'America/Chicago', acknowledgeWarnings: true })).rejects.toThrow();
    expect(await db.diaperLog.count()).toBe(before);
    expect((await db.ocrDocument.findUniqueOrThrow({ where: { id: document.id } })).committedAt).toBeNull();
    expect(await db.externalImportRecord.count({ where: { sourceRecordId: { contains: document.sourceHash } } })).toBe(0);
    await db.unit.create({ data: { unitAbbr: 'OZ', unitName: 'ounces' } });
  });

  it('rejects stale drafts and makes concurrent double submissions at most once', async () => {
    const document = await draft('18:00 wet diaper');
    const rows = openOcrState<{ rows: OcrReviewRequest['rows'] }>(document.originalState, `${actor.familyId}:${document.id}:original`).rows.map(row => ({ ...row, approved: true }));
    const review = { revision: 0, rows, timeZone: 'America/Chicago', acknowledgeWarnings: true };
    const saved = await saveOcrReview(db, actor, document.id, review);
    await expect(saveOcrReview(db, actor, document.id, review)).rejects.toThrow('newer review');
    review.revision = saved.revision;
    const results = await Promise.allSettled([commitOcrReview(db, actor, document.id, review), commitOcrReview(db, actor, document.id, review)]);
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    expect(await db.diaperLog.count({ where: { time: new Date('2026-10-20T23:00:00Z'), babyId: 'ocr-child-a' } })).toBe(1);
    expect(await db.ocrAudit.count({ where: { documentId: document.id, action: 'commit' } })).toBe(1);
  }, 60_000);

  it('purges source bytes without deleting saved records or audit', async () => {
    const id = sources[0];
    const before = await db.feedLog.count();
    const view = await purgeOcrSource(db, actor, id);
    expect(view.hasSource).toBe(false);
    await expect(readOcrSource(db, actor, id)).rejects.toThrow('not found');
    expect(await db.feedLog.count()).toBe(before);
    expect(await db.ocrAudit.count({ where: { documentId: id, action: 'commit' } })).toBe(1);
  });

  it('enforces source expiry without a visit and safely cleans old orphan encrypted files', async () => {
    const document = await draft('10:00 wet diaper');
    const expiredFile = `${randomUUID()}.enc`;
    const orphan = `${randomUUID()}.enc`;
    const recent = `${randomUUID()}.enc`;
    const nonOcr = `retention-unrelated-${randomUUID()}.txt`;
    const filePath = (name: string) => path.join(process.env.BABYTRACKER_OCR_FILES_DIR!, name);
    for (const file of [expiredFile, orphan, recent, nonOcr]) writeFileSync(filePath(file), 'Synthetic fixture');
    const old = new Date(Date.now() - 7_200_000);
    utimesSync(filePath(orphan), old, old);
    await db.ocrDocument.update({ where: { id: document.id }, data: { sourceFile: expiredFile, sourceExpiresAt: old } });
    const before = await db.diaperLog.count();
    const swept = await sweepOcrRetention(db);
    expect(swept.expired).toBe(1);
    expect(swept.orphaned).toBeGreaterThanOrEqual(1);
    expect(existsSync(filePath(expiredFile))).toBe(false);
    expect(existsSync(filePath(orphan))).toBe(false);
    expect(existsSync(filePath(recent))).toBe(true);
    expect(existsSync(filePath(nonOcr))).toBe(true);
    expect(await db.diaperLog.count()).toBe(before);
    expect(await db.ocrAudit.count({ where: { documentId: document.id, action: 'retention-purge' } })).toBe(1);
    for (const file of [recent, nonOcr]) rmSync(filePath(file), { force: true });
  });

  it('canonicalizes duplicate/clock map ordering for network-loss retries', () => {
    const a: OcrReviewRequest = { revision: 1, rows: [], timeZone: 'UTC', utcOffsets: { a: { start: 0, end: 0 }, b: { start: 0 } }, duplicateDecisions: { a: 'keep', b: 'skip' } };
    const b: OcrReviewRequest = { ...a, utcOffsets: { b: { start: 0 }, a: { end: 0, start: 0 } }, duplicateDecisions: { b: 'skip', a: 'keep' } };
    expect(reviewHash(a)).toBe(reviewHash(b));
  });
});
