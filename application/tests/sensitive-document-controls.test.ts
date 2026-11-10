import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';

// Mock app/api/db to delegate dynamically to the test database
vi.mock('@/app/api/db', () => ({
  get default() {
    return (global as any)['__sprout_prisma'];
  },
  reconnectPrisma: vi.fn(),
}));

vi.mock('../../../db', () => ({
  get default() {
    return (global as any)['__sprout_prisma'];
  },
  reconnectPrisma: vi.fn(),
}));

import {
  createOcrDocument,
  commitOcrReview,
  purgeOcrSource,
  readOcrSource,
  requireOcrDocument,
  redactOcrDocument,
} from '@/src/lib/ocr/documents';
import { sealOcrState, openOcrState } from '@/src/lib/ocr/crypto';
import { parseOcrPages } from '@/src/lib/ocr/parser';
import { sweepOcrRetention } from '@/src/lib/ocr/retention';
import { encryptAndStore, decryptFile, deleteEncryptedFile, generateStoredName } from '@/src/lib/file-encryption';
import { validateAttachmentUpload, identifyDocumentBytes, sanitizeFilename } from '@/src/utils/documentValidation';
import { getJwtSecret } from '@/app/api/utils/auth';
import type { OcrReviewRequest } from '@/src/lib/ocr/contracts';

// Handlers under test
import { GET as getVaccineFile, DELETE as deleteVaccineFile } from '@/app/api/vaccine-log/file/[id]/route';
import { GET as getPhotoFile } from '@/app/api/photos/file/[id]/route';

let db: PrismaClient;
let directory: string;
let ocrDir: string;
const encKey = 'aa'.repeat(32);

const familyA = {
  id: 'fam-sensitive-a',
  slug: 'family-sensitive-a',
  name: 'Synthetic Household A',
};

const familyB = {
  id: 'fam-sensitive-b',
  slug: 'family-sensitive-b',
  name: 'Synthetic Household B',
};

const actorA = {
  familyId: familyA.id,
  actorId: 'caretaker-a1',
};

const actorB = {
  familyId: familyB.id,
  actorId: 'caretaker-b1',
};

const authA = {
  authenticated: true,
  familyId: familyA.id,
  familySlug: familyA.slug,
  caretakerId: 'caretaker-a1',
  caretakerName: 'Parent A',
  caretakerRole: 'ADMIN',
  caretakerType: 'PRIMARY',
  isAccountAuth: false,
};

const authB = {
  authenticated: true,
  familyId: familyB.id,
  familySlug: familyB.slug,
  caretakerId: 'caretaker-b1',
  caretakerName: 'Parent B',
  caretakerRole: 'ADMIN',
  caretakerType: 'PRIMARY',
  isAccountAuth: false,
};

function makeAuthToken(auth: typeof authA): string {
  return jwt.sign(
    {
      id: auth.caretakerId,
      name: auth.caretakerName,
      type: auth.caretakerType,
      role: auth.caretakerRole,
      familyId: auth.familyId,
      familySlug: auth.familySlug,
      authType: 'CARETAKER',
      isAccountAuth: false,
    },
    getJwtSecret(),
    { expiresIn: '3600s' }
  );
}

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'babytracker-sensitive-tests-'));
  const dbUrl = `file:${path.join(directory, 'synthetic-security.db')}`;
  process.env.DATABASE_URL = dbUrl;
  process.env.ENC_HASH = encKey;
  process.env.JWT_SECRET = 'test-jwt-secret-'.repeat(4);
  ocrDir = path.join(directory, 'Files', 'ocr');
  process.env.BABYTRACKER_OCR_FILES_DIR = ocrDir;

  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    timeout: 60_000,
  });

  db = new PrismaClient({ adapter: createPrismaAdapter(dbUrl) });
  (global as any)['__sprout_prisma'] = db;
}, 90_000);

beforeAll(async () => {
  await db.family.create({ data: familyA });
  await db.family.create({ data: familyB });

  await db.baby.create({
    data: {
      id: 'baby-sensitive-a',
      familyId: familyA.id,
      firstName: 'Child A',
      lastName: 'Security',
      birthDate: new Date('2026-01-01T00:00:00Z'),
    },
  });

  await db.baby.create({
    data: {
      id: 'baby-sensitive-b',
      familyId: familyB.id,
      firstName: 'Child B',
      lastName: 'Security',
      birthDate: new Date('2026-02-01T00:00:00Z'),
    },
  });

  await db.caretaker.create({
    data: {
      id: actorA.actorId!,
      familyId: familyA.id,
      name: 'Parent A',
      role: 'ADMIN',
      loginId: '10',
      securityPin: '123456',
    },
  });

  await db.caretaker.create({
    data: {
      id: actorB.actorId!,
      familyId: familyB.id,
      name: 'Parent B',
      role: 'ADMIN',
      loginId: '20',
      securityPin: '654321',
    },
  });

  await db.unit.createMany({
    data: [
      { unitAbbr: 'ML', unitName: 'milliliters' },
      { unitAbbr: 'OZ', unitName: 'ounces' },
    ],
  });
});

afterAll(async () => {
  await db?.$disconnect();
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createSyntheticPdf(content = 'Synthetic Medical Record'): Buffer {
  return Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n% ${content}\n%%EOF`);
}

function createSyntheticPng(): Buffer {
  return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 144, 119, 83, 222]);
}

describe('Attachment Access Authorization Scoping', () => {
  it('denies cross-family access to vaccine document downloads and deletions', async () => {
    // 1. Create a vaccine log and document for Family A
    const vaccineLogA = await db.vaccineLog.create({
      data: {
        familyId: familyA.id,
        babyId: 'baby-sensitive-a',
        vaccineName: 'Synthetic MMR Vaccine',
        time: new Date('2026-05-01T10:00:00Z'),
      },
    });

    const storedNameA = generateStoredName();
    const pdfBytes = createSyntheticPdf('MMR Record Child A');
    encryptAndStore(pdfBytes, storedNameA);

    const docA = await db.vaccineDocument.create({
      data: {
        vaccineLogId: vaccineLogA.id,
        originalName: 'child_a_vaccine.pdf',
        storedName: storedNameA,
        mimeType: 'application/pdf',
        fileSize: pdfBytes.length,
      },
    });

    // 2. Family A requests its own document -> Success 200 with security headers
    const reqFamilyA = new NextRequest(`http://localhost:3000/api/vaccine-log/file/${docA.id}`, {
      headers: { Authorization: `Bearer ${makeAuthToken(authA)}` },
    });
    const resA = await (getVaccineFile as any)(reqFamilyA);
    expect(resA.status).toBe(200);
    expect(resA.headers.get('Content-Type')).toBe('application/pdf');
    expect(resA.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(resA.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");

    const downloadedA = Buffer.from(await resA.arrayBuffer());
    expect(downloadedA.equals(pdfBytes)).toBe(true);

    // 3. Family B attempts to request Family A's document -> Rejected 404 (Never 200)
    const reqFamilyB = new NextRequest(`http://localhost:3000/api/vaccine-log/file/${docA.id}`, {
      headers: { Authorization: `Bearer ${makeAuthToken(authB)}` },
    });
    const resB = await (getVaccineFile as any)(reqFamilyB);
    expect(resB.status).toBe(404);
    const bodyB = await resB.json();
    expect(bodyB.success).toBe(false);

    // 4. Family B attempts to delete Family A's document -> Rejected 404
    const resDelB = await (deleteVaccineFile as any)(reqFamilyB);
    expect(resDelB.status).toBe(404);
    expect(await db.vaccineDocument.count({ where: { id: docA.id } })).toBe(1);

    // 5. Cleanup doc
    deleteEncryptedFile(storedNameA);
  });

  it('denies cross-family access to photos inline and preview', async () => {
    // Enable photos configuration
    await db.appConfig.create({
      data: {
        adminPass: 'synthetic-pass',
        rootDomain: 'localhost',
        enablePhotos: true,
      },
    });

    const photoBuffer = createSyntheticPng();
    const photoName = generateStoredName();
    const thumbName = generateStoredName();
    const familyASubdir = `photos/${familyA.id}`;
    encryptAndStore(photoBuffer, photoName, familyASubdir);
    encryptAndStore(photoBuffer, thumbName, familyASubdir);

    const photoA = await db.photo.create({
      data: {
        familyId: familyA.id,
        babyId: 'baby-sensitive-a',
        originalName: 'first_steps.png',
        storedName: photoName,
        thumbStoredName: thumbName,
        mimeType: 'image/png',
        fileSize: photoBuffer.length,
        thumbSize: photoBuffer.length,
        takenAt: new Date('2026-06-01T12:00:00Z'),
      },
    });

    // Family A fetches photo -> 200 with security headers
    const reqA = new NextRequest(`http://localhost:3000/api/photos/file/${photoA.id}`, {
      headers: { Authorization: `Bearer ${makeAuthToken(authA)}` },
    });
    const resA = await (getPhotoFile as any)(reqA);
    expect(resA.status).toBe(200);
    expect(resA.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(resA.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");

    // Family B fetches photo -> 404 Not Found
    const reqB = new NextRequest(`http://localhost:3000/api/photos/file/${photoA.id}`, {
      headers: { Authorization: `Bearer ${makeAuthToken(authB)}` },
    });
    const resB = await (getPhotoFile as any)(reqB);
    expect(resB.status).toBe(404);

    deleteEncryptedFile(photoName, familyASubdir);
    deleteEncryptedFile(thumbName, familyASubdir);
  });

  it('enforces strict family isolation on OCR source documents and review workflows', async () => {
    const docId = randomUUID();
    const sourceBytes = createSyntheticPdf('Daily Care Sheet Family A');
    const storedName = generateStoredName();
    encryptAndStore(sourceBytes, storedName, 'ocr');

    const rows = parseOcrPages([
      { page: 1, text: '08:00 bottle formula 120 mL', engine: 'test', confidence: 95 },
    ], { defaultDate: '2026-10-25', timeFormat: '24h' });

    await db.ocrDocument.create({
      data: {
        id: docId,
        familyId: familyA.id,
        babyId: 'baby-sensitive-a',
        sourceHash: 'source-hash-fam-a-1',
        originalName: 'care-sheet.pdf',
        mimeType: 'application/pdf',
        byteSize: sourceBytes.length,
        sourceFile: storedName,
        previewFiles: '[]',
        pageCount: 1,
        parserVersion: 'test',
        sourceTimezone: 'UTC',
        sourceExpiresAt: new Date(Date.now() + 86400000),
        originalState: sealOcrState({ rows, pages: [] }, `${familyA.id}:${docId}:original`),
        reviewState: sealOcrState({ rows, revision: 0, timeZone: 'UTC' }, `${familyA.id}:${docId}:review`),
      },
    });

    // Family A can read source
    const readA = await readOcrSource(db, actorA, docId);
    expect(readA.bytes.equals(sourceBytes)).toBe(true);

    // Family B is rejected on all document operations
    await expect(requireOcrDocument(db, actorB, docId)).rejects.toThrow('Document not found');
    await expect(readOcrSource(db, actorB, docId)).rejects.toThrow('Document not found');
    await expect(purgeOcrSource(db, actorB, docId)).rejects.toThrow('Document not found');

    deleteEncryptedFile(storedName, 'ocr');
  });
});

describe('Upload Validation and Magic-Byte Verification', () => {
  it('correctly identifies authentic document formats and sanitizes filenames', () => {
    const pdf = createSyntheticPdf();
    const png = createSyntheticPng();
    const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]);
    const webp = Buffer.from('RIFF\x20\x00\x00\x00WEBPVP8 ');

    expect(identifyDocumentBytes(pdf)).toBe('application/pdf');
    expect(identifyDocumentBytes(png)).toBe('image/png');
    expect(identifyDocumentBytes(jpeg)).toBe('image/jpeg');
    expect(identifyDocumentBytes(webp)).toBe('image/webp');

    expect(validateAttachmentUpload(pdf, 'application/pdf').valid).toBe(true);
    expect(validateAttachmentUpload(png, 'image/png').valid).toBe(true);
    expect(validateAttachmentUpload(jpeg, 'image/jpeg').valid).toBe(true);
    expect(validateAttachmentUpload(webp, 'image/webp').valid).toBe(true);

    // Filename sanitization prevents directory traversal and null-byte injection
    expect(sanitizeFilename('../../../etc/passwd')).toBe('______etc_passwd');
    expect(sanitizeFilename('report\x00malicious.pdf')).toBe('report_malicious.pdf');
    expect(sanitizeFilename('  normal_chart.png  ')).toBe('normal_chart.png');
  });

  it('rejects spoofed file formats, active scripts, and oversized payloads', () => {
    const fakePdf = Buffer.from('<script>alert("xss")</script>');
    const validationFake = validateAttachmentUpload(fakePdf, 'application/pdf');
    expect(validationFake.valid).toBe(false);
    expect(validationFake.error).toContain('Unsupported file format');

    const mismatched = validateAttachmentUpload(createSyntheticPdf(), 'image/png');
    expect(mismatched.valid).toBe(false);
    expect(mismatched.error).toContain('does not match');

    const oversized = Buffer.alloc(11 * 1024 * 1024);
    const validationOversized = validateAttachmentUpload(oversized, 'application/pdf');
    expect(validationOversized.valid).toBe(false);
    expect(validationOversized.error).toContain('exceeds');
  });
});

describe('Encryption-at-Rest Integrity & Tamper Detection', () => {
  it('guarantees ciphertext confidentiality and detects bit-level tampering on disk', () => {
    const plaintext = Buffer.from('Confidential pediatric patient notes 2026');
    const storedName = generateStoredName();
    encryptAndStore(plaintext, storedName, 'ocr');

    // 1. Verify file on disk is encrypted, not plaintext
    const filePath = path.join(ocrDir, storedName);
    const diskBytes = readFileSync(filePath);
    expect(diskBytes.includes(plaintext)).toBe(false);

    // 2. Format verify: IV (16 bytes) + AuthTag (16 bytes) + Ciphertext (length of plaintext)
    expect(diskBytes.length).toBe(16 + 16 + plaintext.length);

    // 3. Normal decryption succeeds
    const decrypted = decryptFile(storedName, 'ocr');
    expect(decrypted.equals(plaintext)).toBe(true);

    // 4. Bit-tamper in ciphertext fails authenticated decryption
    const tamperedCiphertext = Buffer.from(diskBytes);
    tamperedCiphertext[35] ^= 0x01; // flip bit in ciphertext
    writeFileSync(filePath, tamperedCiphertext);
    expect(() => decryptFile(storedName, 'ocr')).toThrow();

    // 5. Bit-tamper in auth tag fails authenticated decryption
    const tamperedTag = Buffer.from(diskBytes);
    tamperedTag[20] ^= 0x01; // flip bit in authentication tag
    writeFileSync(filePath, tamperedTag);
    expect(() => decryptFile(storedName, 'ocr')).toThrow();

    deleteEncryptedFile(storedName, 'ocr');
  });

  it('binds database sealed states with scope-authenticated additional data (AAD)', () => {
    const sensitiveState = { secretPrescription: 'Amoxicillin 250mg' };
    const sealed = sealOcrState(sensitiveState, 'fam-a:doc-1:review');

    // Correct scope decrypts cleanly
    const opened = openOcrState<typeof sensitiveState>(sealed, 'fam-a:doc-1:review');
    expect(opened.secretPrescription).toBe('Amoxicillin 250mg');

    // Cross-family scope fails authentication
    expect(() => openOcrState(sealed, 'fam-b:doc-1:review')).toThrow();

    // Cross-document scope fails authentication
    expect(() => openOcrState(sealed, 'fam-a:doc-2:review')).toThrow();
  });
});

describe('Retention Policy Pruning and Automatic Sweeper', () => {
  it('purges expired source files and unreferenced orphan files while retaining active ones', async () => {
    const expiredDocId = randomUUID();
    const activeDocId = randomUUID();

    const expiredFileName = generateStoredName();
    const activeFileName = generateStoredName();
    const orphanOldFileName = generateStoredName();
    const orphanRecentFileName = generateStoredName();

    writeFileSync(path.join(ocrDir, expiredFileName), 'expired file content');
    writeFileSync(path.join(ocrDir, activeFileName), 'active file content');
    writeFileSync(path.join(ocrDir, orphanOldFileName), 'orphan old file content');
    writeFileSync(path.join(ocrDir, orphanRecentFileName), 'orphan recent file content');

    const pastDate = new Date(Date.now() - 3600 * 1000);
    const futureDate = new Date(Date.now() + 86400 * 1000);

    // Make old orphan file older than 1 hour grace period
    const twoHoursAgo = new Date(Date.now() - 7200 * 1000);
    utimesSync(path.join(ocrDir, orphanOldFileName), twoHoursAgo, twoHoursAgo);

    await db.ocrDocument.create({
      data: {
        id: expiredDocId,
        familyId: familyA.id,
        babyId: 'baby-sensitive-a',
        sourceHash: 'expired-hash-1',
        originalName: 'expired.pdf',
        mimeType: 'application/pdf',
        byteSize: 100,
        sourceFile: expiredFileName,
        previewFiles: '[]',
        pageCount: 1,
        parserVersion: 'test',
        sourceTimezone: 'UTC',
        sourceExpiresAt: pastDate,
        originalState: sealOcrState({ rows: [] }, `${familyA.id}:${expiredDocId}:original`),
        reviewState: sealOcrState({ rows: [] }, `${familyA.id}:${expiredDocId}:review`),
      },
    });

    await db.ocrDocument.create({
      data: {
        id: activeDocId,
        familyId: familyA.id,
        babyId: 'baby-sensitive-a',
        sourceHash: 'active-hash-1',
        originalName: 'active.pdf',
        mimeType: 'application/pdf',
        byteSize: 100,
        sourceFile: activeFileName,
        previewFiles: '[]',
        pageCount: 1,
        parserVersion: 'test',
        sourceTimezone: 'UTC',
        sourceExpiresAt: futureDate,
        originalState: sealOcrState({ rows: [] }, `${familyA.id}:${activeDocId}:original`),
        reviewState: sealOcrState({ rows: [] }, `${familyA.id}:${activeDocId}:review`),
      },
    });

    const sweepResult = await sweepOcrRetention(db);
    expect(sweepResult.expired).toBe(1);
    expect(sweepResult.orphaned).toBeGreaterThanOrEqual(1);

    // Expired document row has null sourceFile and purgedAt set
    const updatedExpired = await db.ocrDocument.findUniqueOrThrow({ where: { id: expiredDocId } });
    expect(updatedExpired.sourceFile).toBeNull();
    expect(updatedExpired.purgedAt).not.toBeNull();
    expect(existsSync(path.join(ocrDir, expiredFileName))).toBe(false);

    // Old orphan is removed; recent orphan is preserved
    expect(existsSync(path.join(ocrDir, orphanOldFileName))).toBe(false);
    expect(existsSync(path.join(ocrDir, orphanRecentFileName))).toBe(true);

    // Active document remains untouched
    expect(existsSync(path.join(ocrDir, activeFileName))).toBe(true);

    // Audit trail record exists for retention purge
    const auditRecord = await db.ocrAudit.findFirst({
      where: { documentId: expiredDocId, action: 'retention-purge' },
    });
    expect(auditRecord).not.toBeNull();

    // Clean up
    rmSync(path.join(ocrDir, orphanRecentFileName), { force: true });
    rmSync(path.join(ocrDir, activeFileName), { force: true });
  });
});

describe('Automatic Post-Import Purge & Canonical Timeline Retention', () => {
  it('purges raw source documents upon commit when purgeSourceAfterCommit is requested, retaining care timeline events and audit', async () => {
    const docId = randomUUID();
    const sourceBytes = createSyntheticPdf('Pediatric Feed Intake');
    const storedName = generateStoredName();
    encryptAndStore(sourceBytes, storedName, 'ocr');

    const previewName = generateStoredName();
    encryptAndStore(createSyntheticPng(), previewName, 'ocr');

    const parsedRows = parseOcrPages([
      { page: 1, text: '07:30 bottle formula 150 mL', engine: 'test', confidence: 95 },
    ], { defaultDate: '2026-10-28', timeFormat: '24h' });

    const originalRows = [...parsedRows];
    const approvedRows = parsedRows.map(r => ({ ...r, approved: true }));

    await db.ocrDocument.create({
      data: {
        id: docId,
        familyId: familyA.id,
        babyId: 'baby-sensitive-a',
        sourceHash: 'post-import-purge-hash-1',
        originalName: 'morning-feed.pdf',
        mimeType: 'application/pdf',
        byteSize: sourceBytes.length,
        sourceFile: storedName,
        previewFiles: JSON.stringify([{ page: 1, file: previewName }]),
        pageCount: 1,
        parserVersion: 'test',
        sourceTimezone: 'UTC',
        sourceExpiresAt: new Date(Date.now() + 86400000),
        originalState: sealOcrState({ rows: originalRows, pages: [] }, `${familyA.id}:${docId}:original`),
        reviewState: sealOcrState({ rows: approvedRows, revision: 0, timeZone: 'UTC' }, `${familyA.id}:${docId}:review`),
      },
    });

    const initialFeedCount = await db.feedLog.count({ where: { babyId: 'baby-sensitive-a' } });

    // Review commit requesting immediate auto-purge of source files
    const reviewPayload: OcrReviewRequest = {
      revision: 0,
      rows: approvedRows,
      timeZone: 'UTC',
      acknowledgeWarnings: true,
      duplicateDecisions: {},
      purgeSourceAfterCommit: true,
    };

    const committedView = await commitOcrReview(db, actorA, docId, reviewPayload);

    // 1. View indicates source is purged
    expect(committedView.hasSource).toBe(false);
    expect(committedView.purgedAt).not.toBeNull();
    expect(committedView.result?.created).toBe(1);

    // 2. Physical files on disk were permanently unlinked
    expect(existsSync(path.join(ocrDir, storedName))).toBe(false);
    expect(existsSync(path.join(ocrDir, previewName))).toBe(false);

    // 3. Canonical care timeline event exists and is complete!
    const newFeedCount = await db.feedLog.count({ where: { babyId: 'baby-sensitive-a' } });
    expect(newFeedCount).toBe(initialFeedCount + 1);

    const savedFeed = await db.feedLog.findFirstOrThrow({
      where: { babyId: 'baby-sensitive-a', amount: 150 },
    });
    expect(savedFeed.bottleType).toBe('Formula');
    expect(savedFeed.unitAbbr).toBe('ML');

    // 4. Ledger audit trail retains commit and purge-source records
    const audits = await db.ocrAudit.findMany({ where: { documentId: docId } });
    const actions = audits.map(a => a.action);
    expect(actions).toContain('commit');
    expect(actions).toContain('purge-source');

    // 5. Subsequent attempt to fetch purged source returns 410 Gone
    await expect(readOcrSource(db, actorA, docId)).rejects.toThrow('purged');
  });
});

describe('Secure Redaction Workflow', () => {
  it('redacts sensitive clinical remarks and purges raw source while preserving event structure', async () => {
    const docId = randomUUID();
    const sourceBytes = createSyntheticPdf('Sensitive Medical Chart');
    const storedName = generateStoredName();
    encryptAndStore(sourceBytes, storedName, 'ocr');

    const parsedRows = parseOcrPages([
      { page: 1, text: '12:00 wet diaper', engine: 'test', confidence: 90 },
    ], { defaultDate: '2026-10-29', timeFormat: '24h' });

    const rows = parsedRows.map(r => ({
      ...r,
      notes: 'Highly sensitive clinical observation: pediatrician suspecting allergy',
    }));

    const document = await db.ocrDocument.create({
      data: {
        id: docId,
        familyId: familyA.id,
        babyId: 'baby-sensitive-a',
        sourceHash: 'redact-workflow-hash-1',
        originalName: 'allergy-chart.pdf',
        mimeType: 'application/pdf',
        byteSize: sourceBytes.length,
        sourceFile: storedName,
        previewFiles: '[]',
        pageCount: 1,
        parserVersion: 'test',
        sourceTimezone: 'UTC',
        sourceExpiresAt: new Date(Date.now() + 86400000),
        originalState: sealOcrState({ rows, pages: [] }, `${familyA.id}:${docId}:original`),
        reviewState: sealOcrState({ rows, revision: 0, timeZone: 'UTC' }, `${familyA.id}:${docId}:review`),
      },
    });

    expect(existsSync(path.join(ocrDir, storedName))).toBe(true);

    // Execute redaction
    const redactedView = await redactOcrDocument(db, actorA, docId, {
      redactNotes: true,
      purgeSource: true,
    });

    // 1. Source file on disk was unlinked
    expect(existsSync(path.join(ocrDir, storedName))).toBe(false);
    expect(redactedView.hasSource).toBe(false);

    // 2. Sensitive note text is replaced with [REDACTED]
    expect(redactedView.rows[0].notes).toBe('[REDACTED]');
    expect(redactedView.rows[0].source.rawText).toBe('[REDACTED]');
    // Core event type remains intact
    expect(redactedView.rows[0].eventType).toBe('diaper');

    // 3. Audit trail records redaction action
    const auditRecord = await db.ocrAudit.findFirst({
      where: { documentId: docId, action: 'redact' },
    });
    expect(auditRecord).not.toBeNull();
  });
});

describe('Backup and Restore Preserves Encryption Requirements', () => {
  it('requires matching ENC_HASH to decrypt backups; fails fast on key mismatch or loss', () => {
    const originalSecret = Buffer.from('Restore validation payload for infant care database');
    const storedName = generateStoredName();
    encryptAndStore(originalSecret, storedName, 'ocr');

    // Restoration with exact same key succeeds
    const restoredWithSameKey = decryptFile(storedName, 'ocr');
    expect(restoredWithSameKey.equals(originalSecret)).toBe(true);

    // Simulating restore onto host with mismatched or corrupted ENC_HASH
    const wrongKey = 'ff'.repeat(32);
    process.env.ENC_HASH = wrongKey;

    expect(() => decryptFile(storedName, 'ocr')).toThrow();

    // Simulating restore with missing ENC_HASH
    delete process.env.ENC_HASH;
    expect(() => decryptFile(storedName, 'ocr')).toThrow('ENC_HASH environment variable is not set');

    // Restore valid key
    process.env.ENC_HASH = encKey;
    expect(decryptFile(storedName, 'ocr').equals(originalSecret)).toBe(true);

    deleteEncryptedFile(storedName, 'ocr');
  });
});
