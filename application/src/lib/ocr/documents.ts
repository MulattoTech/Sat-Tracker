import { createHash, randomUUID } from 'node:crypto';
import type { OcrDocument, PrismaClient, Prisma } from '@prisma/client';
import { encryptAndStore, decryptFile, deleteEncryptedFile, generateStoredName } from '@/src/lib/file-encryption';
import { executeExternalImport } from '@/src/lib/importers/execute';
import { parseOcrPages } from './parser';
import { isOcrDate } from './validation';
import { OCR_LIMITS, acquireOcrSlot, identifyOcrUpload, recognizeOcrDocument } from './intake';
import { OCR_PARSER_VERSION, type OcrCrop } from './types';
import { openOcrState, sealOcrState } from './crypto';
import { OcrError } from './errors';
import { findOcrDuplicates, ocrScope, OriginalOcrState, readReviewRequest, reviewHash, reviewIssues, toSproutRecords } from './review';
import type { OcrDocumentView, OcrReviewRequest, OcrReviewPreview } from './contracts';
import { readOcrRedactionOptions, redactOcrText, type OcrRedactionOptions } from './redaction';

export interface OcrActor { familyId: string; actorId: string | null }
const storageDir = 'ocr';
const scope = (document: Pick<OcrDocument, 'id' | 'familyId'>, kind: string) => `${ocrScope(document)}:${kind}`;

function sourceFiles(document: OcrDocument): string[] {
  let previews: unknown;
  try { previews = JSON.parse(document.previewFiles || '[]'); }
  catch { throw new OcrError('Invalid stored source references.', 500); }
  if (!Array.isArray(previews)) throw new OcrError('Invalid stored source references.', 500);
  const files: unknown[] = previews.map(page => page?.file);
  if (document.sourceFile) files.push(document.sourceFile);
  if (files.some(file => typeof file !== 'string' || !/^[a-f\d-]{36}\.enc$/i.test(file))) {
    throw new OcrError('Invalid stored source reference.', 500);
  }
  return [...new Set(files as string[])];
}

// Call only AFTER the transaction has revoked access and detached the file refs.
// Failed unlinks are encrypted orphans, retried by the existing retention sweeper.
// purgedAt records access revocation; it is not a promise of physical secure erasure.
function unlinkPurgedSources(files: string[]) {
  let pending = false;
  for (const file of files) {
    try { deleteEncryptedFile(file, storageDir); }
    catch { pending = true; }
  }
  if (pending) console.error('OCR source access revoked; encrypted file cleanup is pending retention maintenance.');
}

export function ocrDocumentView(document: OcrDocument): OcrDocumentView {
  const original = openOcrState<OriginalOcrState>(document.originalState, scope(document, 'original'));
  const review = openOcrState<OcrReviewRequest>(document.reviewState, scope(document, 'review'));
  let pages: number[] = [];
  try {
    pages = (JSON.parse(document.previewFiles || '[]') as { page: number }[]).map(p => p.page);
  } catch {
    pages = [];
  }
  return {
    id: document.id, babyId: document.babyId, originalName: document.originalName,
    mimeType: document.mimeType, pageCount: document.pageCount, parserVersion: document.parserVersion,
    sourceTimezone: review.timeZone, revision: document.revision, rows: review.rows, originalRows: original.rows,
    committedAt: document.committedAt?.toISOString() || null,
    result: document.resultJson ? JSON.parse(document.resultJson) : null,
    sourceExpiresAt: document.sourceExpiresAt.toISOString(),
    purgedAt: document.purgedAt?.toISOString() || null,
    hasSource: Boolean(document.sourceFile && !document.purgedAt && document.sourceExpiresAt > new Date()),
    createdAt: document.createdAt.toISOString(),
    utcOffsets: review.utcOffsets, duplicateDecisions: review.duplicateDecisions,
    pages,
  };
}

export async function requireOcrDocument(db: Prisma.TransactionClient, actor: OcrActor, id: string): Promise<OcrDocument> {
  const document = await db.ocrDocument.findFirst({ where: { id, familyId: actor.familyId } });
  if (!document) throw new OcrError('Document not found.', 404);
  const baby = await db.baby.findFirst({ where: { id: document.babyId, familyId: actor.familyId, deletedAt: null }, select: { id: true } });
  if (!baby) throw new OcrError('Document not found.', 404);
  return document;
}

export async function createOcrDocument(db: PrismaClient, actor: OcrActor, input: {
  bytes: Buffer; name: string; babyId: string; timeZone: string; defaultDate?: string;
  timeFormat: '24h' | '12h' | 'unknown'; rotation: number; retentionDays: number;
  selectedPage?: number; crop?: OcrCrop;
  signal?: AbortSignal;
}): Promise<OcrDocumentView> {
  const baby = await db.baby.findFirst({ where: { id: input.babyId, familyId: actor.familyId, deletedAt: null, inactive: false }, select: { id: true } });
  if (!baby) throw new OcrError('Select a baby in this family.', 404);
  if (input.defaultDate && !isOcrDate(input.defaultDate)) throw new OcrError('Enter a complete source date or leave it blank.');
  try { new Intl.DateTimeFormat('en', { timeZone: input.timeZone }); } catch { throw new OcrError('Choose a valid time zone.'); }
  if (!input.timeZone || !['24h', '12h', 'unknown'].includes(input.timeFormat)) throw new OcrError('Choose the document time zone and clock format.');
  if (!Number.isInteger(input.retentionDays) || input.retentionDays < 0 || input.retentionDays > 365) throw new OcrError('Source retention must be between 0 and 365 days.');
  const mimeType = identifyOcrUpload(input.bytes);
  const sourceHash = createHash('sha256').update(input.bytes).digest('hex');
  const unique = { familyId: actor.familyId, babyId: baby.id, sourceHash };
  const existing = await db.ocrDocument.findUnique({ where: { familyId_babyId_sourceHash: unique } });
  if (existing) return ocrDocumentView(existing);
  // Check encryption configuration before spending OCR resources.
  sealOcrState({}, 'configuration-check');
  const release = acquireOcrSlot(actor.familyId);
  const stored: string[] = [];
  try {
    const pages = await recognizeOcrDocument(input.bytes, {
      rotation: input.rotation,
      selectedPage: input.selectedPage,
      crop: input.crop,
      signal: input.signal,
    });
    const rows = parseOcrPages(pages, { defaultDate: input.defaultDate, timeFormat: input.timeFormat });
    if (rows.length > OCR_LIMITS.rows) throw new OcrError('More than 200 events were found. Upload a smaller section.');
    if (input.signal?.aborted) throw new OcrError('Recognition cancelled. No care records were created.', 499);
    const id = randomUUID();
    const reference = { id, familyId: actor.familyId };
    const store = (bytes: Buffer) => {
      const name = generateStoredName();
      encryptAndStore(bytes, name, storageDir); stored.push(name); return name;
    };
    const sourceFile = store(input.bytes);
    const previews = pages.map(page => ({ page: page.page, file: store(page.image) }));
    const originalState = sealOcrState({
      rows, pages: pages.map(({ image: _image, ...page }) => page),
      options: { rotation: input.rotation, defaultDate: input.defaultDate, timeFormat: input.timeFormat, selectedPage: input.selectedPage, crop: input.crop },
    }, scope(reference, 'original'));
    const review: OcrReviewRequest = { rows, revision: 0, timeZone: input.timeZone, utcOffsets: {}, duplicateDecisions: {} };
    const document = await db.ocrDocument.create({ data: {
      id, ...unique, originalName: input.name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 180) || 'document',
      mimeType, byteSize: input.bytes.length, sourceFile, previewFiles: JSON.stringify(previews), pageCount: pages.length,
      parserVersion: OCR_PARSER_VERSION, sourceTimezone: input.timeZone, originalState,
      reviewState: sealOcrState(review, scope(reference, 'review')),
      sourceExpiresAt: input.retentionDays === 0 ? new Date(Date.now() + 3_600_000) : new Date(Date.now() + input.retentionDays * 86_400_000),
      audits: { create: { action: 'upload', actorId: actor.actorId, snapshot: sealOcrState({
        sourceHash,
        parserVersion: OCR_PARSER_VERSION,
        originalName: input.name,
        pageCount: pages.length,
        rotation: input.rotation,
        crop: input.crop || null,
        selectedPage: input.selectedPage || null,
        rows: rows.length,
      }, scope(reference, 'audit')) } },
    } });
    stored.length = 0; // Ownership transferred to persisted document.
    return ocrDocumentView(document);
  } catch (error) {
    for (const file of stored) deleteEncryptedFile(file, storageDir);
    if ((error as { code?: string }).code === 'P2002') {
      const document = await db.ocrDocument.findUnique({ where: { familyId_babyId_sourceHash: unique } });
      if (document) return ocrDocumentView(document);
    }
    throw error;
  } finally { release(); }
}

async function audit(tx: Prisma.TransactionClient, document: OcrDocument, actor: OcrActor, action: string, state: unknown) {
  await tx.ocrAudit.create({ data: { documentId: document.id, actorId: actor.actorId, action, snapshot: sealOcrState(state, scope(document, 'audit')) } });
}

export async function saveOcrReview(db: PrismaClient, actor: OcrActor, id: string, input: unknown): Promise<OcrDocumentView> {
  return db.$transaction(async tx => {
    const document = await requireOcrDocument(tx, actor, id);
    if (document.committedAt) throw new OcrError('This document has already been imported. Its review is read-only.', 409);
    const review = readReviewRequest(input, document);
    const changed = await tx.ocrDocument.updateMany({
      where: { id, familyId: actor.familyId, revision: review.revision, committedAt: null },
      data: { reviewState: sealOcrState(review, scope(document, 'review')), sourceTimezone: review.timeZone, revision: { increment: 1 } },
    });
    if (changed.count !== 1) throw new OcrError('A newer review exists. Reload it before saving.', 409);
    await audit(tx, document, actor, 'review', review);
    return ocrDocumentView((await tx.ocrDocument.findUnique({ where: { id } }))!);
  });
}

export async function previewOcrReview(db: PrismaClient, actor: OcrActor, id: string, input: unknown): Promise<OcrReviewPreview> {
  const document = await requireOcrDocument(db, actor, id);
  const review = readReviewRequest(input, document);
  return { issues: reviewIssues(review), duplicates: await findOcrDuplicates(db, document, review, { includeDetails: true }) };
}

export async function commitOcrReview(db: PrismaClient, actor: OcrActor, id: string, input: unknown): Promise<OcrDocumentView> {
  // A single transaction owns the revision claim, canonical events, provenance and review audit.
  const commit = async () => db.$transaction(async tx => {
    const document = await requireOcrDocument(tx, actor, id);
    const review = readReviewRequest(input, document);
    const hash = reviewHash(review);
    if (document.committedAt) {
      if (hash !== document.commitHash) throw new OcrError('This document was already imported with a different review. No records were changed.', 409);
      return { view: ocrDocumentView(document), files: [] as string[] };
    }
    if (!review.acknowledgeWarnings) throw new OcrError('Confirm that every approved event was checked against the source.');
    const approved = new Set(review.rows.filter(row => row.approved).map(row => row.id));
    if (!approved.size) throw new OcrError('Approve at least one event before importing.');
    const issues = reviewIssues(review).filter(issue => approved.has(issue.rowId) && issue.errors.length);
    if (issues.length) throw new OcrError('Some approved events have unresolved fields or times. Correct them before importing.');
    const changed = await tx.ocrDocument.updateMany({
      where: { id, familyId: actor.familyId, revision: review.revision, committedAt: null },
      data: { committedAt: new Date(), commitHash: hash, revision: { increment: 1 } },
    });
    if (changed.count !== 1) throw new OcrError('A newer review exists. Reload before importing.', 409);
    const duplicates = await findOcrDuplicates(tx, document, review, { includeDetails: true });
    if (duplicates.some(duplicate => !review.duplicateDecisions?.[duplicate.rowId])) {
      throw new OcrError('Potential duplicate events need a keep or skip decision. Check duplicates again.', 409);
    }
    const duplicateIds = new Set(duplicates.map(duplicate => duplicate.rowId));
    const skipped = review.rows.filter(row => row.approved && review.duplicateDecisions?.[row.id] === 'skip');
    if (skipped.some(row => !duplicateIds.has(row.id))) throw new OcrError('A skipped event no longer matches a duplicate. Check duplicates again.', 409);
    const records = toSproutRecords(document, review);
    // Account owners can authenticate before linking a caretaker; audit their actor ID
    // without putting an Account ID into the Caretaker foreign key.
    const caretaker = actor.actorId ? await tx.caretaker.findFirst({
      where: { id: actor.actorId, familyId: actor.familyId, deletedAt: null }, select: { id: true },
    }) : null;
    const execution = records.length ? await executeExternalImport(tx, {
      familyId: actor.familyId, caretakerId: caretaker?.id || null, records,
      configuration: { sourceTimezone: 'UTC', childDestinations: { [document.babyId]: { mode: 'existing', targetBabyId: document.babyId } } },
    }) : { created: 0, duplicates: 0, records: [], babyMappings: { [document.babyId]: document.babyId } };
    const result = { ...execution, skipped: skipped.length };

    const original = openOcrState<OriginalOcrState & { options?: { rotation?: number; crop?: OcrCrop; selectedPage?: number } }>(
      document.originalState,
      scope(document, 'original'),
    );

    const auditPayload = {
      parserVersion: document.parserVersion,
      documentId: document.id,
      sourceHash: document.sourceHash,
      sourceDocument: {
        id: document.id,
        originalName: document.originalName,
        sourceHash: document.sourceHash,
        pageCount: document.pageCount,
        rotation: original.options?.rotation ?? 0,
        crop: original.options?.crop ?? null,
        selectedPage: original.options?.selectedPage ?? null,
      },
      review,
      reviewerDecisions: {
        timeZone: review.timeZone,
        acknowledgeWarnings: review.acknowledgeWarnings,
        duplicateDecisions: review.duplicateDecisions || {},
        utcOffsets: review.utcOffsets || {},
        approvedRowIds: review.rows.filter(row => row.approved).map(row => row.id),
        skippedRowIds: skipped.map(row => row.id),
      },
      rawFields: review.rows.map(row => {
        const orig = original.rows?.find(r => r.id === row.id);
        return {
          rowId: row.id,
          page: row.source?.page ?? orig?.source?.page ?? 1,
          line: row.source?.line ?? orig?.source?.line ?? 1,
          slot: row.source?.slot ?? orig?.source?.slot ?? 0,
          rawText: row.source?.rawText || orig?.source?.rawText || '',
          engine: row.source?.engine || orig?.source?.engine || document.parserVersion,
          confidence: row.source?.confidence ?? orig?.source?.confidence ?? null,
          fieldSources: row.fieldSources,
        };
      }),
      duplicates,
      result,
      skipped: skipped.map(row => row.id),
    };

    await audit(tx, document, actor, 'commit', auditPayload);
    const files = review.purgeSourceAfterCommit ? sourceFiles(document) : [];
    if (review.purgeSourceAfterCommit) await audit(tx, document, actor, 'purge-source', {
      sourceHash: document.sourceHash, reason: 'auto-purge-on-commit', cleanup: 'scheduled-after-commit',
    });

    const saved = await tx.ocrDocument.update({ where: { id }, data: {
      reviewState: sealOcrState(review, scope(document, 'review')),
      resultJson: JSON.stringify(result),
      sourceTimezone: review.timeZone,
      ...(review.purgeSourceAfterCommit ? { sourceFile: null, previewFiles: '[]', purgedAt: new Date() } : {}),
    } });
    return { view: ocrDocumentView(saved), files };
  }, { maxWait: 10_000, timeout: 30_000 });
  try {
    const result = await commit();
    unlinkPurgedSources(result.files);
    return result.view;
  } catch (error) {
    // A conflicting request can commit while this request waits. Return its durable receipt only for the exact same review.
    if (['P2002', 'P2034', 'P2028'].includes((error as { code?: string }).code || '')) {
      const current = await requireOcrDocument(db, actor, id);
      if (current.committedAt && current.commitHash === reviewHash(readReviewRequest(input, current))) return ocrDocumentView(current);
      throw new OcrError('Another import is in progress. Reload this document and retry.', 409);
    }
    throw error;
  }
}

export async function purgeOcrSource(db: PrismaClient, actor: OcrActor, id: string): Promise<OcrDocumentView> {
  const result = await db.$transaction(async tx => {
    const document = await requireOcrDocument(tx, actor, id);
    const files = sourceFiles(document);
    await audit(tx, document, actor, 'purge-source', { sourceHash: document.sourceHash, cleanup: 'scheduled-after-commit' });
    const saved = await tx.ocrDocument.update({ where: { id }, data: { sourceFile: null, previewFiles: '[]', purgedAt: new Date() } });
    return { view: ocrDocumentView(saved), files };
  });
  unlinkPurgedSources(result.files);
  return result.view;
}

export async function readOcrSource(db: PrismaClient, actor: OcrActor, id: string, page?: number): Promise<{ bytes: Buffer; mimeType: string }> {
  const document = await requireOcrDocument(db, actor, id);
  if (document.sourceExpiresAt <= new Date() || document.purgedAt !== null || !document.sourceFile) {
    if (document.sourceFile) await purgeOcrSource(db, actor, id);
    throw new OcrError('The source file was not found or was purged under the retention policy. Import history is still available.', 410);
  }
  const previews = JSON.parse(document.previewFiles || '[]') as { page: number; file: string }[];
  let file: string | null = null;
  if (page === undefined) {
    file = document.sourceFile;
  } else {
    file = previews.find(value => value.page === page)?.file ?? null;
    if (!file && previews.length === 1 && page === 1) {
      file = previews[0].file;
    }
  }
  if (!file) throw new OcrError('Source file not found.', 404);
  if (!/^[a-f\d-]{36}\.enc$/i.test(file)) throw new OcrError('Invalid stored source reference.', 500);
  return { bytes: decryptFile(file, storageDir), mimeType: page === undefined ? document.mimeType : 'image/png' };
}

export async function redactOcrDocument(
  db: PrismaClient,
  actor: OcrActor,
  id: string,
  input: Partial<OcrRedactionOptions> = { redactNotes: true, purgeSource: true }
): Promise<OcrDocumentView> {
  const options = readOcrRedactionOptions(input);
  const result = await db.$transaction(async tx => {
    const document = await requireOcrDocument(tx, actor, id);
    const files = options.purgeSource ? sourceFiles(document) : [];
    let originalState = document.originalState;
    let reviewState = document.reviewState;
    if (options.redactNotes) {
      // Unlike ordinary review edits, explicit redaction removes all OCR text copies.
      // Decryption errors abort the transaction; never report partial redaction as success.
      originalState = sealOcrState(redactOcrText(openOcrState<OriginalOcrState>(
        document.originalState, scope(document, 'original'),
      )), scope(document, 'original'));
      const review = redactOcrText(openOcrState<OcrReviewRequest>(document.reviewState, scope(document, 'review')));
      review.revision = document.revision + 1;
      if (!document.committedAt) {
        review.rows = review.rows.map(row => ({ ...row, approved: false }));
        review.acknowledgeWarnings = false;
      }
      reviewState = sealOcrState(review, scope(document, 'review'));
    }
    // Claim the revision before changing snapshots, preventing stale drafts from
    // restoring text after a concurrent redaction. Care records are never changed.
    const changed = await tx.ocrDocument.updateMany({
      where: { id, familyId: actor.familyId, revision: document.revision },
      data: {
        originalState, reviewState, revision: { increment: 1 },
        ...(options.redactNotes ? {
          originalName: 'redacted-document',
          resultJson: document.resultJson ? JSON.stringify(redactOcrText(JSON.parse(document.resultJson))) : null,
        } : {}),
        ...(options.purgeSource ? { sourceFile: null, previewFiles: '[]', purgedAt: new Date() } : {}),
      },
    });
    if (changed.count !== 1) throw new OcrError('A newer review exists. Reload it before redacting.', 409);
    if (options.redactNotes) {
      const snapshots = await tx.ocrAudit.findMany({ where: { documentId: id } });
      for (const snapshot of snapshots) {
        const state = openOcrState<unknown>(snapshot.snapshot, scope(document, 'audit'));
        await tx.ocrAudit.update({ where: { id: snapshot.id }, data: {
          snapshot: sealOcrState(redactOcrText(state), scope(document, 'audit')),
        } });
      }
    }
    await audit(tx, document, actor, 'redact', {
      sourceHash: document.sourceHash,
      redactedAt: new Date().toISOString(),
      purgedSource: options.purgeSource,
      redactedNotes: options.redactNotes,
      cleanup: options.purgeSource ? 'scheduled-after-commit' : 'not-requested',
      canonicalCareRecordsChanged: false,
    });
    const saved = await tx.ocrDocument.findUniqueOrThrow({ where: { id } });
    return { view: ocrDocumentView(saved), files };
  }, { maxWait: 10_000, timeout: 30_000 });
  unlinkPurgedSources(result.files);
  return result.view;
}
