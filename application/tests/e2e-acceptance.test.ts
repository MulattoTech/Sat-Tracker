import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';
import {
  commitOcrReview,
  previewOcrReview,
  saveOcrReview,
  purgeOcrSource,
  readOcrSource,
  requireOcrDocument,
} from '@/src/lib/ocr/documents';
import { sealOcrState, openOcrState } from '@/src/lib/ocr/crypto';
import { parseOcrPages } from '@/src/lib/ocr/parser';
import {
  validateOcrCrop,
  parseOcrCrop,
  applyImageTransform,
  identifyOcrUpload,
  OCR_LIMITS,
} from '@/src/lib/ocr/intake';
import { validateOcrCandidate } from '@/src/lib/ocr/validation';
import type { OcrCandidate, OcrCrop } from '@/src/lib/ocr/types';
import type { OcrReviewRequest } from '@/src/lib/ocr/contracts';
import sharp from 'sharp';
import { jsPDF } from 'jspdf';

// Isolated synthetic actors
const familyA = { familyId: 'acceptance-family-a', actorId: null };
const familyB = { familyId: 'acceptance-family-b', actorId: null };
const childA = 'acceptance-child-a';
const childA2 = 'acceptance-child-a2';
const childB = 'acceptance-child-b';

let db: PrismaClient;
let testDir: string;
const registeredSources: string[] = [];

// Synthetic mixed care sheet text containing feed & diaper entries
const SYNTHETIC_CARE_SHEET = [
  '2026-10-20',
  '08:15 bottle formula 90 mL',
  '09:30 wet diaper',
  '14:00 bottle breast milk 3 oz',
  '16:45 dirty diaper',
].join('\n');

async function createSyntheticCareSvg(): Promise<Buffer> {
  const svg = `
    <svg width="1800" height="900" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="white"/>
      <g fill="black" font-family="DejaVu Sans" font-size="48">
        <text x="70" y="120">2026-10-20</text>
        <text x="70" y="240">08:15 bottle formula 90 mL</text>
        <text x="70" y="360">09:30 wet diaper</text>
        <text x="70" y="480">14:00 bottle breast milk 3 oz</text>
        <text x="70" y="600">16:45 dirty diaper</text>
      </g>
    </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function createSyntheticCarePdf(): Buffer {
  const doc = new jsPDF();
  doc.setFontSize(16);
  doc.text(['2026-10-20', '08:15 bottle formula 90 mL', '09:30 wet diaper'], 20, 30);
  doc.addPage();
  doc.text(['2026-10-20', '14:00 bottle breast milk 3 oz', '16:45 dirty diaper'], 20, 30);
  return Buffer.from(doc.output('arraybuffer'));
}

async function createSyntheticDraft(options: {
  text?: string;
  sourceHash?: string;
  babyId?: string;
  familyId?: string;
  timeZone?: string;
  defaultDate?: string;
  crop?: OcrCrop;
  rotation?: number;
  page?: number;
} = {}) {
  const text = options.text ?? SYNTHETIC_CARE_SHEET;
  const hash = options.sourceHash ?? randomUUID();
  const babyId = options.babyId ?? childA;
  const targetFamilyId = options.familyId ?? familyA.familyId;
  const timeZone = options.timeZone ?? 'America/Chicago';
  const defaultDate = options.defaultDate ?? '2026-10-20';
  const rotation = options.rotation ?? 0;
  const crop = options.crop;
  const page = options.page ?? 1;

  const pageItem = {
    page,
    text,
    engine: 'synthetic-acceptance-engine',
    confidence: 96,
    rotation,
    crop,
  };

  const rows = parseOcrPages([pageItem], { defaultDate, timeFormat: '24h' });
  const id = randomUUID();

  const originalPayload = {
    rows,
    pages: [pageItem],
    options: { rotation, selectedPage: page, crop },
  };

  const reviewPayload = {
    rows,
    timeZone,
  };

  const sourceFile = `${randomUUID()}.enc`;
  const previewFiles = JSON.stringify([{ page, file: `${randomUUID()}.enc` }]);

  const doc = await db.ocrDocument.create({
    data: {
      id,
      familyId: targetFamilyId,
      babyId,
      sourceHash: hash,
      originalName: 'synthetic-care-log.png',
      mimeType: 'image/png',
      byteSize: 1024,
      sourceFile,
      previewFiles,
      pageCount: 1,
      parserVersion: 'babytracker-acceptance-v1',
      sourceTimezone: timeZone,
      sourceExpiresAt: new Date(Date.now() + 86_400_000),
      originalState: sealOcrState(originalPayload, `${targetFamilyId}:${id}:original`),
      reviewState: sealOcrState(reviewPayload, `${targetFamilyId}:${id}:review`),
    },
  });

  const dummyBytes = Buffer.from('Synthetic encrypted test payload');
  writeFileSync(path.join(process.env.BABYTRACKER_OCR_FILES_DIR!, sourceFile), dummyBytes);

  return { doc, rows };
}

beforeAll(() => {
  testDir = mkdtempSync(path.join(tmpdir(), 'babytracker-e2e-acceptance-'));
  const databaseUrl = `file:${path.join(testDir, 'synthetic-acceptance.db')}`;
  process.env.ENC_HASH = '44'.repeat(32);
  process.env.BABYTRACKER_OCR_FILES_DIR = path.join(testDir, 'sources');
  mkdirSync(process.env.BABYTRACKER_OCR_FILES_DIR, { recursive: true });

  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
    timeout: 60_000,
  });

  db = new PrismaClient({ adapter: createPrismaAdapter(databaseUrl) });
}, 90_000);

beforeAll(async () => {
  // Seed synthetic families
  await db.family.create({ data: { id: familyA.familyId, slug: 'synthetic-acceptance-a', name: 'Synthetic Family A', setupStage: 3 } });
  await db.family.create({ data: { id: familyB.familyId, slug: 'synthetic-acceptance-b', name: 'Synthetic Family B', setupStage: 3 } });

  // Seed synthetic children
  await db.baby.create({ data: { id: childA, familyId: familyA.familyId, firstName: 'Child', lastName: 'A', birthDate: new Date('2026-01-01T00:00:00Z') } });
  await db.baby.create({ data: { id: childA2, familyId: familyA.familyId, firstName: 'Child', lastName: 'A-Two', birthDate: new Date('2026-02-01T00:00:00Z') } });
  await db.baby.create({ data: { id: childB, familyId: familyB.familyId, firstName: 'Child', lastName: 'B', birthDate: new Date('2026-03-01T00:00:00Z') } });

  // Seed measurement units
  for (const unitAbbr of ['ML', 'OZ']) {
    await db.unit.create({ data: { unitAbbr, unitName: unitAbbr } });
  }
});

// Each case starts with its own empty care history inside this disposable DB.
// The duplicate test creates its own canonical event; test order is irrelevant.
beforeEach(async () => {
  await db.ocrAudit.deleteMany();
  await db.externalImportRecord.deleteMany();
  await db.ocrDocument.deleteMany();
  await db.feedLog.deleteMany();
  await db.diaperLog.deleteMany();
  for (const unitAbbr of ['ML', 'OZ']) {
    await db.unit.upsert({ where: { unitAbbr }, create: { unitAbbr, unitName: unitAbbr }, update: {} });
  }
});

afterAll(async () => {
  for (const id of registeredSources) {
    await purgeOcrSource(db, familyA, id).catch(() => {});
  }
  await db?.$disconnect();
  if (testDir) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

describe('BabyTracker End-to-End Acceptance Suite & Release Gate (#29)', () => {
  // =========================================================================
  // REQUIREMENT 1: End-to-end flow with synthetic mixed feeding/diaper fixtures
  // =========================================================================
  describe('Parity Requirement 1: Synthetic mixed feeding & diaper end-to-end flow', () => {
    it('validates upload -> preview/crop -> parse candidate rows -> review UX adjustments -> explicit confirmation -> reconciliation ledger -> Sprout events', async () => {
      // 1. Synthetic mixed fixture generation & intake validation
      const pngBytes = await createSyntheticCareSvg();
      expect(identifyOcrUpload(pngBytes)).toBe('image/png');

      const pdfBytes = createSyntheticCarePdf();
      expect(identifyOcrUpload(pdfBytes)).toBe('application/pdf');

      // 2. Crop intake validation (pixel & percent coordinates)
      const cropSpec = parseOcrCrop('10%, 15%, 80%, 70%');
      expect(cropSpec).toEqual({ left: 10, top: 15, width: 80, height: 70, unit: 'percent' });
      const validatedCrop = validateOcrCrop(cropSpec);
      expect(validatedCrop.width).toBe(80);

      // Verify image transform bounds
      const transformed = await applyImageTransform(pngBytes, { rotation: 0, crop: cropSpec });
      const meta = await sharp(transformed).metadata();
      expect(meta.width).toBeLessThanOrEqual(2400);

      // 3. Create synthetic draft representing intake of mixed care sheet
      const { doc, rows } = await createSyntheticDraft({
        text: SYNTHETIC_CARE_SHEET,
        crop: cropSpec,
        rotation: 0,
      });
      registeredSources.push(doc.id);

      // Verify parsed candidate rows contain both feed and diaper events
      const feeds = rows.filter(r => r.eventType === 'feed');
      const diapers = rows.filter(r => r.eventType === 'diaper');
      expect(feeds).toHaveLength(2);
      expect(diapers).toHaveLength(2);

      expect(feeds[0].bottleType).toBe('Formula');
      expect(feeds[0].amount).toBe(90);
      expect(feeds[0].unit).toBe('ML');
      expect(feeds[0].localTime).toBe('08:15');

      expect(feeds[1].bottleType).toBe('Breast Milk');
      expect(feeds[1].amount).toBe(3);
      expect(feeds[1].unit).toBe('OZ');
      expect(feeds[1].localTime).toBe('14:00');

      expect(diapers[0].diaperType).toBe('WET');
      expect(diapers[0].localTime).toBe('09:30');
      expect(diapers[1].diaperType).toBe('DIRTY');
      expect(diapers[1].localTime).toBe('16:45');

      // Ensure zero Sprout records exist before confirmation
      expect(await db.feedLog.count({ where: { babyId: childA } })).toBe(0);
      expect(await db.diaperLog.count({ where: { babyId: childA } })).toBe(0);
      expect(await db.externalImportRecord.count()).toBe(0);

      // 4. Review UX adjustments:
      // Reviewer corrects feed 1 amount from 90 mL to 95 mL, approves valid feed/diaper rows
      const adjustedRows: OcrCandidate[] = rows.map(row => {
        if (row.eventType === 'feed' && row.amount === 90) {
          return {
            ...row,
            amount: 95,
            notes: 'Adjusted by reviewer after care review',
            approved: true,
            fieldSources: { ...row.fieldSources, amount: 'corrected' },
          };
        }
        if (row.eventType === 'feed' || row.eventType === 'diaper') {
          return { ...row, approved: true };
        }
        return { ...row, approved: false };
      });

      const reviewRequest: OcrReviewRequest = {
        revision: doc.revision,
        rows: adjustedRows,
        timeZone: 'America/Chicago',
        acknowledgeWarnings: true,
        duplicateDecisions: {},
        utcOffsets: {},
      };

      // Save review draft
      const saved = await saveOcrReview(db, familyA, doc.id, reviewRequest);
      expect(saved.revision).toBe(doc.revision + 1);
      const savedFeed = saved.rows.find(r => r.eventType === 'feed' && r.localTime === '08:15');
      expect(savedFeed?.amount).toBe(95);
      expect(savedFeed?.fieldSources.amount).toBe('corrected');

      // Check preview
      reviewRequest.revision = saved.revision;
      const preview = await previewOcrReview(db, familyA, doc.id, reviewRequest);
      expect(preview.duplicates).toHaveLength(0);
      const approvedIssues = preview.issues.filter(i => adjustedRows.some(r => r.id === i.rowId && r.approved) && i.errors.length > 0);
      expect(approvedIssues).toHaveLength(0);

      // 5. Explicit human confirmation & commit
      const committed = await commitOcrReview(db, familyA, doc.id, reviewRequest);
      expect(committed.committedAt).not.toBeNull();
      expect(committed.result?.created).toBe(4);
      expect(committed.result?.skipped).toBe(0);

      // 6. Reconciliation ledger verification
      const ledgerRecords = await db.externalImportRecord.findMany({
        where: { sourceRecordId: { contains: doc.sourceHash } },
      });
      expect(ledgerRecords).toHaveLength(4);
      expect(ledgerRecords.filter(r => r.targetEntityType === 'FeedLog')).toHaveLength(2);
      expect(ledgerRecords.filter(r => r.targetEntityType === 'DiaperLog')).toHaveLength(2);

      // Verify audit trail
      const auditTrail = await db.ocrAudit.findFirst({
        where: { documentId: doc.id, action: 'commit' },
      });
      expect(auditTrail).toBeDefined();
      expect(auditTrail?.documentId).toBe(doc.id);
      expect(auditTrail?.action).toBe('commit');

      // 7. Sprout care events verification
      const savedFeeds = await db.feedLog.findMany({
        where: { babyId: childA },
        orderBy: { time: 'asc' },
      });
      expect(savedFeeds).toHaveLength(2);
      // First feed: corrected 95 mL formula at 08:15 Chicago time (UTC 13:15)
      expect(savedFeeds[0].amount).toBe(95);
      expect(savedFeeds[0].unitAbbr).toBe('ML');
      expect(savedFeeds[0].bottleType).toBe('Formula');
      expect(savedFeeds[0].time.toISOString()).toBe('2026-10-20T13:15:00.000Z');

      // Second feed: 3 oz breast milk at 14:00 Chicago time (UTC 19:00)
      expect(savedFeeds[1].amount).toBe(3);
      expect(savedFeeds[1].unitAbbr).toBe('OZ');
      expect(savedFeeds[1].bottleType).toBe('Breast Milk');
      expect(savedFeeds[1].time.toISOString()).toBe('2026-10-20T19:00:00.000Z');

      const savedDiapers = await db.diaperLog.findMany({
        where: { babyId: childA },
        orderBy: { time: 'asc' },
      });
      expect(savedDiapers).toHaveLength(2);
      expect(savedDiapers[0].type).toBe('WET');
      expect(savedDiapers[0].time.toISOString()).toBe('2026-10-20T14:30:00.000Z');
      expect(savedDiapers[1].type).toBe('DIRTY');
      expect(savedDiapers[1].time.toISOString()).toBe('2026-10-20T21:45:00.000Z');
    });
  });

  // =========================================================================
  // REQUIREMENT 2: Verify Safety Invariants
  // =========================================================================
  describe('Parity Requirement 2: Safety Invariants', () => {
    it('Invariant A: cancellation leaves zero artifacts and no uncommitted care writes', async () => {
      const feedCountBefore = await db.feedLog.count();
      const diaperCountBefore = await db.diaperLog.count();
      const ledgerCountBefore = await db.externalImportRecord.count();

      // Create a draft that gets abandoned/cancelled
      const { doc } = await createSyntheticDraft({ text: '11:00 wet diaper\n11:30 bottle formula 60 mL' });
      registeredSources.push(doc.id);

      // Verify uncommitted draft created zero care logs
      expect(await db.feedLog.count()).toBe(feedCountBefore);
      expect(await db.diaperLog.count()).toBe(diaperCountBefore);
      expect(await db.externalImportRecord.count()).toBe(ledgerCountBefore);

      // Purge the source (simulating user cancellation/cleanup)
      const purgedView = await purgeOcrSource(db, familyA, doc.id);
      expect(purgedView.hasSource).toBe(false);
      expect(await db.feedLog.count()).toBe(feedCountBefore);
      expect(await db.diaperLog.count()).toBe(diaperCountBefore);
    });

    it('Invariant B: malformed rows, unapproved rows, and unacknowledged warnings block save', async () => {
      const { doc, rows } = await createSyntheticDraft({ text: '12:00 bottle formula 100 mL' });
      registeredSources.push(doc.id);

      // 1. Unapproved row blocks commit
      const unapprovedReview: OcrReviewRequest = {
        revision: 0,
        rows: rows.map(r => ({ ...r, approved: false })),
        timeZone: 'America/Chicago',
        acknowledgeWarnings: true,
      };
      await expect(commitOcrReview(db, familyA, doc.id, unapprovedReview)).rejects.toThrow('Approve at least one event');

      // 2. Unacknowledged warnings block commit
      const unconfirmedReview: OcrReviewRequest = {
        revision: 0,
        rows: rows.map(r => ({ ...r, approved: true })),
        timeZone: 'America/Chicago',
        acknowledgeWarnings: false,
      };
      await expect(commitOcrReview(db, familyA, doc.id, unconfirmedReview)).rejects.toThrow('Confirm that every approved event');

      // 3. Unresolved/missing date blocks commit
      const missingDateReview: OcrReviewRequest = {
        revision: 0,
        rows: rows.map(r => ({ ...r, approved: true, localDate: null })),
        timeZone: 'America/Chicago',
        acknowledgeWarnings: true,
      };
      await expect(commitOcrReview(db, familyA, doc.id, missingDateReview)).rejects.toThrow('unresolved fields');

      // 4. Missing local time blocks commit
      const missingTimeReview: OcrReviewRequest = {
        revision: 0,
        rows: rows.map(r => ({ ...r, approved: true, localTime: null })),
        timeZone: 'America/Chicago',
        acknowledgeWarnings: true,
      };
      await expect(commitOcrReview(db, familyA, doc.id, missingTimeReview)).rejects.toThrow('unresolved fields');

      // 5. Forged / unknown row ID blocks commit
      const forgedReview: OcrReviewRequest = {
        revision: 0,
        rows: rows.map(r => ({ ...r, id: 'forged-nonexistent-id', approved: true })),
        timeZone: 'America/Chicago',
        acknowledgeWarnings: true,
      };
      await expect(commitOcrReview(db, familyA, doc.id, forgedReview)).rejects.toThrow('unknown source');

      // Verify document committedAt is still null
      const docState = await db.ocrDocument.findUniqueOrThrow({ where: { id: doc.id } });
      expect(docState.committedAt).toBeNull();
    });

    it('Invariant C: atomic transaction rollback preserves clean state when later write fails', async () => {
      const { doc, rows } = await createSyntheticDraft({
        text: '17:00 wet diaper\n17:30 bottle formula 90 mL',
      });
      registeredSources.push(doc.id);

      const approvedRows = rows.map(r => ({ ...r, approved: true }));
      const diaperCountBefore = await db.diaperLog.count();
      const feedCountBefore = await db.feedLog.count();

      // Temporarily remove ML unit to trigger a foreign key / validation failure during the feed write
      await db.unit.delete({ where: { unitAbbr: 'ML' } });

      const review: OcrReviewRequest = {
        revision: 0,
        rows: approvedRows,
        timeZone: 'America/Chicago',
        acknowledgeWarnings: true,
      };

      await expect(commitOcrReview(db, familyA, doc.id, review)).rejects.toThrow();

      // Restore ML unit
      await db.unit.create({ data: { unitAbbr: 'ML', unitName: 'milliliters' } });

      // Invariant: Entire transaction rolled back - diaper was NOT committed partially
      expect(await db.diaperLog.count()).toBe(diaperCountBefore);
      expect(await db.feedLog.count()).toBe(feedCountBefore);

      const docCheck = await db.ocrDocument.findUniqueOrThrow({ where: { id: doc.id } });
      expect(docCheck.committedAt).toBeNull();
      expect(await db.externalImportRecord.count({ where: { sourceRecordId: { contains: doc.sourceHash } } })).toBe(0);
    });

    it('Invariant D: idempotency & duplicate re-import detection', async () => {
      // Create this case's duplicate explicitly instead of relying on a prior test.
      await db.feedLog.create({ data: {
        id: randomUUID(), familyId: familyA.familyId, babyId: childA,
        time: new Date('2026-10-20T13:15:00.000Z'), type: 'BOTTLE',
        bottleType: 'Formula', amount: 95, unitAbbr: 'ML',
      } });
      const feedCountBefore = await db.feedLog.count();

      // Draft an event that matches the previously imported feed at 08:15 (2026-10-20)
      const { doc, rows } = await createSyntheticDraft({
        text: '08:15 bottle formula 95 mL',
      });
      registeredSources.push(doc.id);

      const approvedRows = rows.map(r => ({ ...r, approved: true }));
      const review: OcrReviewRequest = {
        revision: 0,
        rows: approvedRows,
        timeZone: 'America/Chicago',
        acknowledgeWarnings: true,
      };

      // Preview flags the matching event as a duplicate
      const preview = await previewOcrReview(db, familyA, doc.id, review);
      expect(preview.duplicates.length).toBeGreaterThanOrEqual(1);

      // Attempting to commit without duplicate decision must throw
      await expect(commitOcrReview(db, familyA, doc.id, review)).rejects.toThrow('duplicate');

      // Explicit 'skip' skips without creating any duplicate care logs
      const skipCommit = await commitOcrReview(db, familyA, doc.id, {
        ...review,
        duplicateDecisions: { [approvedRows[0].id]: 'skip' },
      });
      expect(skipCommit.result?.created).toBe(0);
      expect(skipCommit.result?.skipped).toBe(1);
      expect(await db.feedLog.count()).toBe(feedCountBefore);

      // 2. Double-tap / network retry idempotency:
      // Re-submitting the exact same review returns the same durable receipt
      const retryResult = await commitOcrReview(db, familyA, doc.id, {
        ...review,
        duplicateDecisions: { [approvedRows[0].id]: 'skip' },
      });
      expect(retryResult.result).toEqual(skipCommit.result);
      expect(await db.feedLog.count()).toBe(feedCountBefore);
    });

    it('Invariant E: cross-family isolation is strictly enforced', async () => {
      const { doc } = await createSyntheticDraft({
        text: '18:00 wet diaper',
        familyId: familyA.familyId,
        babyId: childA,
      });
      registeredSources.push(doc.id);

      // Family B cannot read or access Family A's document
      await expect(requireOcrDocument(db, familyB, doc.id)).rejects.toThrow('not found');
      await expect(readOcrSource(db, familyB, doc.id)).rejects.toThrow('not found');
      await expect(saveOcrReview(db, familyB, doc.id, { revision: 0, rows: [] })).rejects.toThrow('not found');
      await expect(previewOcrReview(db, familyB, doc.id, { revision: 0, rows: [] })).rejects.toThrow('not found');
      await expect(commitOcrReview(db, familyB, doc.id, { revision: 0, rows: [] })).rejects.toThrow('not found');

      // Keyed cryptographic state isolation: state sealed for Family A cannot be opened with Family B context
      const sealed = sealOcrState({ test: 'secret-a' }, `${familyA.familyId}:${doc.id}:review`);
      expect(() => openOcrState(sealed, `${familyB.familyId}:${doc.id}:review`)).toThrow();
    });
  });

  // =========================================================================
  // REQUIREMENT 3: Bounded Crop & Provenance Validation
  // =========================================================================
  describe('Parity Requirement 3: Bounded crop, orientation, and provenance invariants', () => {
    it('validates crop specifications, bounds, and provenance across transformations', () => {
      // Valid percentage crop
      const percentCrop = parseOcrCrop('5%, 10%, 75%, 60%');
      expect(percentCrop).toEqual({ left: 5, top: 10, width: 75, height: 60, unit: 'percent' });

      // Valid pixel crop
      const pixelCrop = parseOcrCrop('50, 60, 400, 300');
      expect(pixelCrop).toEqual({ left: 50, top: 60, width: 400, height: 300, unit: 'pixel' });

      // Boundary violations
      expect(() => parseOcrCrop({ left: -5, top: 0, width: 100, height: 100 })).toThrow('cannot be negative');
      expect(() => parseOcrCrop({ left: 0, top: 0, width: 0, height: 100 })).toThrow('greater than zero');
      expect(() => parseOcrCrop({ left: 60, top: 0, width: 50, height: 50, unit: 'percent' })).toThrow('boundary');

      // Provenance validation on candidates
      const validCandidate: OcrCandidate = {
        id: 'candidate-provenance-test',
        eventType: 'feed',
        localDate: '2026-10-20',
        localTime: '08:15',
        endLocalDate: null,
        endLocalTime: null,
        feedType: 'BOTTLE',
        bottleType: 'Formula',
        amount: 90,
        unit: 'ML',
        diaperType: null,
        sleepType: null,
        notes: '',
        approved: false,
        source: {
          page: 1,
          line: 1,
          slot: 0,
          rawText: '08:15 bottle formula 90 mL',
          engine: 'synthetic',
          confidence: 95,
          rotation: 90,
          crop: percentCrop,
        },
        fieldSources: { eventType: 'source', localDate: 'source', localTime: 'source' },
        warnings: [],
      };

      const checked = validateOcrCandidate(validCandidate, { allowIncomplete: true });
      expect(checked.valid).toBe(true);
      expect(checked.candidate?.source.rotation).toBe(90);
      expect(checked.candidate?.source.crop).toEqual(percentCrop);
    });
  });
});
