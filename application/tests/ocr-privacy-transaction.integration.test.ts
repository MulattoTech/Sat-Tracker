import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import sharp from 'sharp';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';
import { commitOcrReview, purgeOcrSource, readOcrSource, redactOcrDocument, saveOcrReview } from '@/src/lib/ocr/documents';
import { sealOcrState, openOcrState } from '@/src/lib/ocr/crypto';
import { parseOcrPages } from '@/src/lib/ocr/parser';
import { redactOcrText } from '@/src/lib/ocr/redaction';
import { validateOcrCandidate } from '@/src/lib/ocr/validation';
import { recognizeOcrDocument } from '@/src/lib/ocr/intake';
import { sweepOcrRetention } from '@/src/lib/ocr/retention';
import * as encryption from '@/src/lib/file-encryption';
import type { OcrReviewRequest } from '@/src/lib/ocr/contracts';

let db: PrismaClient;
let directory: string;
const actor = { familyId: 'privacy-regression-family', actorId: null };
const babyId = 'privacy-regression-child';
const sensitive = 'Synthetic confidential clinical observation';

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-privacy-regression-'));
  const databaseUrl = `file:${path.join(directory, 'isolated.db')}`;
  process.env.ENC_HASH = 'bb'.repeat(32);
  process.env.BABYTRACKER_OCR_FILES_DIR = path.join(directory, 'sources');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe', timeout: 60_000,
  });
  db = new PrismaClient({ adapter: createPrismaAdapter(databaseUrl) });
  await db.family.create({ data: { id: actor.familyId, slug: actor.familyId, name: 'Synthetic privacy family' } });
  await db.baby.create({ data: { id: babyId, familyId: actor.familyId, firstName: 'Synthetic', lastName: 'Fixture', birthDate: new Date('2026-01-01') } });
}, 90_000);

afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  await db?.$disconnect();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function fixture(text = `12:00 wet diaper ${sensitive}`) {
  const id = randomUUID();
  const sourceFile = encryption.generateStoredName();
  const source = Buffer.from(`%PDF-1.4\n${sensitive}\n%%EOF`);
  encryption.encryptAndStore(source, sourceFile, 'ocr');
  const rows = parseOcrPages([{ page: 1, text, engine: 'synthetic-fixture', confidence: 90 }], {
    defaultDate: '2026-10-20', timeFormat: '24h',
  }).map(row => ({ ...row, approved: true }));
  const review: OcrReviewRequest = { revision: 0, rows, timeZone: 'UTC', acknowledgeWarnings: true };
  const original = { rows, pages: [{ page: 1, text: sensitive, engine: 'synthetic-fixture', confidence: 90 }] };
  const document = await db.ocrDocument.create({ data: {
    id, familyId: actor.familyId, babyId, sourceHash: randomUUID(), originalName: `${sensitive}.pdf`,
    mimeType: 'application/pdf', byteSize: source.length, sourceFile, previewFiles: '[]', pageCount: 1,
    parserVersion: 'synthetic-fixture', sourceTimezone: 'UTC', sourceExpiresAt: new Date(Date.now() + 86_400_000),
    originalState: sealOcrState(original, `${actor.familyId}:${id}:original`),
    reviewState: sealOcrState(review, `${actor.familyId}:${id}:review`),
    audits: { create: { action: 'review', actorId: null, snapshot: sealOcrState({
      review, rawFields: [{ rawText: sensitive }], sourceDocument: { originalName: sensitive },
    }, `${actor.familyId}:${id}:audit`) } },
  } });
  return { document, review, source, file: path.join(process.env.BABYTRACKER_OCR_FILES_DIR!, sourceFile) };
}

// The real SQLite transaction runs every statement, then fails at the commit boundary.
// The old implementation unlinked sources inside it, which cannot be rolled back.
function abortAfterStatements(): PrismaClient {
  return { $transaction: async <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => db.$transaction(async tx => {
    await work(tx);
    throw new Error('Synthetic late transaction failure');
  }) } as unknown as PrismaClient;
}

describe('OCR privacy integrity', () => {
  it.each(['source', 'context', 'missing', 'ambiguous', 'corrected'])('preserves origin %s only within fieldSources and scrubs unexpected provenance text', origin => {
    const input = {
      formulaName: origin, bottleLabel: origin, sourceCaregiverName: origin,
      fieldSources: {
        formulaName: origin, bottleLabel: origin, sourceCaregiverName: origin, notes: origin,
        amount: sensitive, unit: { nestedPrivateText: sensitive },
      },
    };
    expect(redactOcrText(input)).toEqual({
      formulaName: '[REDACTED]', bottleLabel: '[REDACTED]', sourceCaregiverName: '[REDACTED]',
      fieldSources: {
        formulaName: origin, bottleLabel: origin, sourceCaregiverName: origin, notes: origin,
        amount: '[REDACTED]', unit: '[REDACTED]',
      },
    });
    expect(input.fieldSources.amount).toBe(sensitive);
  });

  it('redacts original rows, page text, review and historical snapshots; rejects stale text restoration', async () => {
    const { document, review, file } = await fixture();
    const careCount = await db.diaperLog.count();
    const view = await redactOcrDocument(db, actor, document.id);
    expect(JSON.stringify(view)).not.toContain(sensitive);
    expect(view.originalRows[0].source.rawText).toBe('[REDACTED]');
    expect(view.rows[0].notes).toBe('[REDACTED]');
    expect(view.rows[0].formulaName).toBeNull();
    expect(view.rows[0].fieldSources.formulaName).toBe('missing');
    expect(view.rows[0].fieldSources.bottleLabel).toBe('missing');
    expect(view.rows[0].fieldSources.sourceCaregiverName).toBe('missing');
    expect(validateOcrCandidate(view.rows[0]).valid).toBe(true);
    expect(view.rows[0].approved).toBe(false);
    expect(view.revision).toBe(1);
    expect(view.hasSource).toBe(false);
    expect(existsSync(file)).toBe(false);
    const persisted = await db.ocrDocument.findUniqueOrThrow({ where: { id: document.id } });
    for (const kind of ['original', 'review'] as const) {
      const state = openOcrState<unknown>(kind === 'original' ? persisted.originalState : persisted.reviewState, `${actor.familyId}:${document.id}:${kind}`);
      expect(JSON.stringify(state)).not.toContain(sensitive);
    }
    const audits = await db.ocrAudit.findMany({ where: { documentId: document.id } });
    expect(audits.map(item => item.action)).toContain('review');
    expect(audits.map(item => item.action)).toContain('redact');
    for (const item of audits) expect(JSON.stringify(openOcrState(item.snapshot, `${actor.familyId}:${document.id}:audit`))).not.toContain(sensitive);
    await expect(saveOcrReview(db, actor, document.id, review)).rejects.toThrow('newer review');
    expect(await db.diaperLog.count()).toBe(careCount);
  });

  it('redacts rich bottle text in every snapshot while preserving quantities, valid provenance and the stale-review guard', async () => {
    const text = `12:00 bottle formula; offered: 120 mL; consumed: 90 mL; concentration: 22 kcal/oz; formula name: ${sensitive} brand; bottle id: ${sensitive} label; caregiver: ${sensitive} caregiver`;
    const { document, review } = await fixture(text);
    const feedCount = await db.feedLog.count();
    const view = await redactOcrDocument(db, actor, document.id);
    expect(JSON.stringify(view)).not.toContain(sensitive);
    for (const row of [view.rows[0], view.originalRows[0]]) {
      expect(row).toMatchObject({
        amount: 90, offeredAmount: 120, unit: 'ML', formulaKcalOz: 22,
        formulaName: '[REDACTED]', bottleLabel: '[REDACTED]', sourceCaregiverName: '[REDACTED]',
        notes: '[REDACTED]', source: { rawText: '[REDACTED]' },
        fieldSources: { formulaName: 'source', bottleLabel: 'source', sourceCaregiverName: 'source', notes: 'source' },
      });
      expect(validateOcrCandidate(row).valid).toBe(true);
    }
    expect(view.rows[0].approved).toBe(false);
    const persisted = await db.ocrDocument.findUniqueOrThrow({ where: { id: document.id } });
    for (const kind of ['original', 'review'] as const) {
      const state = openOcrState<{ rows: OcrReviewRequest['rows'] }>(kind === 'original' ? persisted.originalState : persisted.reviewState, `${actor.familyId}:${document.id}:${kind}`);
      expect(JSON.stringify(state)).not.toContain(sensitive);
      expect(validateOcrCandidate(state.rows[0]).valid).toBe(true);
    }
    const audits = await db.ocrAudit.findMany({ where: { documentId: document.id } });
    for (const item of audits) {
      const state = openOcrState<{ review?: OcrReviewRequest }>(item.snapshot, `${actor.familyId}:${document.id}:audit`);
      expect(JSON.stringify(state)).not.toContain(sensitive);
      if (state.review) expect(validateOcrCandidate(state.review.rows[0]).valid).toBe(true);
    }
    await expect(saveOcrReview(db, actor, document.id, review)).rejects.toThrow('newer review');
    expect((await db.ocrDocument.findUniqueOrThrow({ where: { id: document.id } })).revision).toBe(1);
    expect(await db.feedLog.count()).toBe(feedCount);
  });

  it.each(['purge', 'redact', 'commit'] as const)('keeps source and database intact if %s transaction fails after its statements', async operation => {
    const { document, review, file, source } = await fixture();
    const before = await db.diaperLog.count();
    const failing = abortAfterStatements();
    const promise = operation === 'purge' ? purgeOcrSource(failing, actor, document.id)
      : operation === 'redact' ? redactOcrDocument(failing, actor, document.id)
      : commitOcrReview(failing, actor, document.id, { ...review, purgeSourceAfterCommit: true });
    await expect(promise).rejects.toThrow('Synthetic late transaction failure');
    expect(existsSync(file)).toBe(true);
    expect((await readOcrSource(db, actor, document.id)).bytes).toEqual(source);
    const after = await db.ocrDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(after.sourceFile).toBe(document.sourceFile);
    expect(after.originalState).toBe(document.originalState);
    expect(after.reviewState).toBe(document.reviewState);
    expect(after.purgedAt).toBeNull();
    expect(after.committedAt).toBeNull();
    expect(await db.diaperLog.count()).toBe(before);
    expect(await db.ocrAudit.count({ where: { documentId: document.id } })).toBe(1);
  });

  it('fails closed on an unreadable audit snapshot without deleting the source or partially redacting', async () => {
    const { document, file } = await fixture();
    await db.ocrAudit.create({ data: { documentId: document.id, action: 'review', snapshot: 'corrupt' } });
    await expect(redactOcrDocument(db, actor, document.id)).rejects.toThrow();
    expect(existsSync(file)).toBe(true);
    const after = await db.ocrDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(after.originalState).toBe(document.originalState);
    expect(after.revision).toBe(0);
    expect(after.purgedAt).toBeNull();
  });

  it('blocks cross-family redaction before changing snapshots or files', async () => {
    const { document, file } = await fixture();
    await expect(redactOcrDocument(db, { familyId: 'another-family', actorId: null }, document.id)).rejects.toThrow('not found');
    expect(existsSync(file)).toBe(true);
    expect((await db.ocrDocument.findUniqueOrThrow({ where: { id: document.id } })).revision).toBe(0);
  });

  it('revokes source access after commit and retries a failed physical unlink through retention maintenance', async () => {
    const { document, file } = await fixture();
    vi.spyOn(encryption, 'deleteEncryptedFile').mockImplementation(() => { throw new Error('Synthetic filesystem error'); });
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = await purgeOcrSource(db, actor, document.id);
    expect(view.hasSource).toBe(false);
    expect(existsSync(file)).toBe(true);
    await expect(readOcrSource(db, actor, document.id)).rejects.toThrow('purged');
    expect(warning.mock.calls.flat().join(' ')).not.toContain(sensitive);
    const old = new Date(Date.now() - 7_200_000);
    utimesSync(file, old, old);
    expect((await sweepOcrRetention(db)).orphaned).toBeGreaterThanOrEqual(1);
    expect(existsSync(file)).toBe(false);
  });

  it('never fabricates recognition output on unsupported platforms even in test mode', async () => {
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      await expect(recognizeOcrDocument(png)).rejects.toThrow('Linux OCR-enabled application container');
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});
