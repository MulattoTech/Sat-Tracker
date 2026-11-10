/**
 * Tests for GET /api/ocr/documents/[id]/source
 *
 * Verifies that the source-download route correctly enforces family-level
 * authorization, purges expired sources, and never discloses source content
 * in error responses or server logs. Ported from recovery/ocr-wip-babytracker-3-20261028
 * and adapted from preserved checkpoint 0b620dc7 for the current privacy API.
 *
 * Covered gaps (no equivalent test existed in main before this commit):
 *   - Foreign-family 404 does not delete or leak the source file
 *   - Expired source triggers automatic purge (410 + null sourceFile + purgedAt)
 *   - Already-purged source (null sourceFile) returns 410 without disclosure
 *   - Success path carries cache-control and x-content-type-options security headers
 *   - Source bytes and log output never contain the private source text on failure paths
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { encryptAndStore, generateStoredName } from '@/src/lib/file-encryption';
import { sealOcrState } from '@/src/lib/ocr/crypto';

// ---------------------------------------------------------------------------
// Fixtures — hoisted so vi.mock() factories can reference them
// ---------------------------------------------------------------------------

const fixture = vi.hoisted(() => {
  let document: Record<string, any> | null = null;
  const db: Record<string, any> = {
    ocrDocument: {
      findFirst: async ({ where }: { where: { id: string; familyId: string } }) =>
        document?.id === where.id && document.familyId === where.familyId ? document : null,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        if (!document) throw new Error('Synthetic document missing');
        Object.assign(document, data);
        return document;
      },
    },
    ocrAudit: { create: async () => ({}) },
    baby: {
      findFirst: async ({ where }: { where: { id: string; familyId: string } }) =>
        document?.babyId === where.id && document.familyId === where.familyId
          ? { id: where.id }
          : null,
    },
    $transaction: async (work: (tx: Record<string, any>) => unknown) => work(db),
  };
  return {
    db,
    get document() { return document; },
    set document(value: Record<string, any> | null) { document = value; },
  };
});

vi.mock('@/app/api/db', () => ({ default: fixture.db }));

vi.mock('@/app/api/utils/auth', () => ({
  withAuthContext: (handler: (request: NextRequest, auth: Record<string, unknown>) => unknown) =>
    (request: NextRequest) =>
      handler(request, {
        authenticated: true,
        familyId: request.headers.get('x-synthetic-family'),
        isAccountOwner: true,
        caretakerId: null,
        caretakerRole: null,
        isSysAdmin: false,
      }),
}));

vi.mock('@/app/api/utils/writeProtection', () => ({
  checkWritePermission: () => ({ allowed: true }),
}));

// ---------------------------------------------------------------------------
// Import the route under test AFTER the mocks are declared
// ---------------------------------------------------------------------------

import { GET } from '@/app/api/ocr/documents/[id]/source/route';

// ---------------------------------------------------------------------------
// Test helpers and constants
// ---------------------------------------------------------------------------

const AUTHORIZED_FAMILY = 'synthetic-family-authorized';
const AUTHORIZED_CHILD  = 'synthetic-child-authorized';
const SYNTHETIC_SOURCE  = Buffer.from('SYNTHETIC PRIVATE SOURCE TEXT <script>must-not-leak</script>');

let testDir = '';
let savedFilesDir: string | undefined;
let savedEncKey: string | undefined;
let encryptedName = '';
let capturedLogs: unknown[][] = [];

function sourceRequest(id: string, family: string) {
  return new NextRequest(`http://localhost/api/ocr/documents/${id}/source`, {
    headers: { 'x-synthetic-family': family },
  });
}

/**
 * Assert that a pre-read response body string and any console output contain
 * no private source content. Callers must pass the already-read body text so
 * we never consume a response that was already read by the test assertion.
 */
function expectNoSensitiveDisclosure(bodyText: string) {
  expect(bodyText).not.toContain(SYNTHETIC_SOURCE.toString());
  expect(bodyText).not.toContain('must-not-leak');
  const logText = capturedLogs.flat().map(String).join(' ');
  expect(logText).not.toContain(SYNTHETIC_SOURCE.toString());
  expect(logText).not.toContain('must-not-leak');
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  testDir = mkdtempSync(path.join(tmpdir(), 'babytracker-ocr-source-route-'));

  savedFilesDir = process.env.BABYTRACKER_OCR_FILES_DIR;
  savedEncKey   = process.env.ENC_HASH;

  process.env.BABYTRACKER_OCR_FILES_DIR = testDir;
  process.env.ENC_HASH = '11'.repeat(32); // 32-byte hex key for AES-256

  // Ensure OCR is not disabled in this environment
  delete process.env.BABYTRACKER_OCR_ENABLED;

  // Encrypt the synthetic source and store it in the temp directory
  encryptedName = generateStoredName();
  encryptAndStore(SYNTHETIC_SOURCE, encryptedName, 'ocr');

  // Build a minimal synthetic OcrDocument fixture
  const id = randomUUID();
  const scopePrefix = `${AUTHORIZED_FAMILY}:${id}`;
  fixture.document = {
    id,
    familyId: AUTHORIZED_FAMILY,
    babyId: AUTHORIZED_CHILD,
    sourceHash: 'synthetic-hash-abc123',
    sourceFile: encryptedName,
    previewFiles: '[]',
    sourceExpiresAt: new Date(Date.now() + 60_000),
    mimeType: 'image/png',
    byteSize: SYNTHETIC_SOURCE.length,
    pageCount: 1,
    parserVersion: 'synthetic-parser-v1',
    sourceTimezone: 'UTC',
    revision: 0,
    originalName: 'synthetic-care-sheet.png',
    originalState: sealOcrState({ rows: [], pages: [] }, `${scopePrefix}:original`),
    reviewState: sealOcrState(
      { rows: [], timeZone: 'UTC', utcOffsets: {}, duplicateDecisions: {} },
      `${scopePrefix}:review`,
    ),
    committedAt: null,
    commitHash: null,
    resultJson: null,
    purgedAt: null,
    createdAt: new Date(),
  };

  // Capture console output so we can assert no sensitive data leaks to logs
  capturedLogs = [];
  for (const level of ['error', 'warn', 'log', 'info', 'debug', 'trace'] as const) {
    vi.spyOn(console, level).mockImplementation((...args) => {
      capturedLogs.push(args);
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(testDir, { recursive: true, force: true });

  if (savedFilesDir === undefined) delete process.env.BABYTRACKER_OCR_FILES_DIR;
  else process.env.BABYTRACKER_OCR_FILES_DIR = savedFilesDir;

  if (savedEncKey === undefined) delete process.env.ENC_HASH;
  else process.env.ENC_HASH = savedEncKey;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET OCR source — authorization and retention boundary', () => {
  it('returns the unexpired source only to its authorized family', async () => {
    const doc = fixture.document!;
    const response = await GET(sourceRequest(doc.id, AUTHORIZED_FAMILY));

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(SYNTHETIC_SOURCE);
    // Security headers are injected by ocrRoute regardless of handler result
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('returns 404 to a foreign family without leaking or deleting the source file', async () => {
    const doc = fixture.document!;
    const response = await GET(sourceRequest(doc.id, 'synthetic-family-foreign'));

    expect(response.status).toBe(404);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ success: false, error: 'Document not found.' });
    // The file must still be present — a denial must never trigger a purge
    expect(existsSync(path.join(testDir, encryptedName))).toBe(true);
    expectNoSensitiveDisclosure(body);
  });

  it('returns 410 and purges the encrypted source when the retention period has expired', async () => {
    const doc = fixture.document!;
    doc.sourceExpiresAt = new Date(Date.now() - 60_000); // already expired

    const response = await GET(sourceRequest(doc.id, AUTHORIZED_FAMILY));

    expect(response.status).toBe(410);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      success: false,
      error: 'The source file was not found or was purged under the retention policy. Import history is still available.',
    });
    // The encrypted file must be deleted after expiry
    expect(existsSync(path.join(testDir, encryptedName))).toBe(false);
    // The DB record must reflect the purge
    expect(fixture.document?.sourceFile).toBeNull();
    expect(fixture.document?.purgedAt).toBeInstanceOf(Date);
    expectNoSensitiveDisclosure(body);
  });

  it('returns 410 when the source was already purged (sourceFile is null)', async () => {
    const doc = fixture.document!;
    doc.sourceFile = null;
    // Remove the physical file too (simulates a completed purge)
    rmSync(path.join(testDir, encryptedName), { force: true });

    const response = await GET(sourceRequest(doc.id, AUTHORIZED_FAMILY));

    expect(response.status).toBe(410);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ success: false, error: 'The source file was not found or was purged under the retention policy. Import history is still available.' });
    expectNoSensitiveDisclosure(body);
  });
});
