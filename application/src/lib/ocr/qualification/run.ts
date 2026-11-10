import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { identifyOcrUpload, OCR_LIMITS, OCR_MODEL_SHA256, recognizeOcrDocument } from '../intake';
import { parseOcrPages } from '../parser';
import { OCR_PARSER_VERSION } from '../types';
import { parseQualificationManifest, privatePath, QualificationError } from './manifest';
import { addScores, ALIGNMENT_METHOD, emptyScores, hasResolvedRecognition, MINIMUM_ROW_SIMILARITY,
  recognitionSignature, scoreRows, summarizeScores } from './score';

/** Extraction only: deliberately imports no database, HTTP/auth or canonical commit service. */
export async function runOcrQualification(options: {
  readonly privateRoot: string;
  readonly manifestPath: string;
  readonly revision?: string;
}) {
  const manifestPath = await privatePath(options.privateRoot, options.manifestPath);
  if ((await stat(manifestPath)).size > 1_048_576) throw new QualificationError('MANIFEST_TOO_LARGE');
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch { throw new QualificationError('INVALID_PRIVATE_MANIFEST'); }
  const manifest = parseQualificationManifest(parsed);
  const all = emptyScores(), representative = emptyScores();
  const results: object[] = [];
  const privateSignatures = new Map<number, { bytes: string; rows: string; count: number; resolved: boolean }>();
  let failedDocuments = 0, representativeDocuments = 0, representativePages = 0;
  const repeats = { declaredPairs: 0, comparedPairs: 0, consistentPairs: 0,
    inconsistentPairs: 0, emptyPairs: 0, unresolvedPairs: 0, unavailablePairs: 0, invalidExactPairs: 0 };
  for (let index = 0; index < manifest.documents.length; index++) {
    const document = manifest.documents[index];
    if (document.repeatOf !== undefined) repeats.declaredPairs++;
    try {
      const sourcePath = await privatePath(options.privateRoot, path.resolve(path.dirname(manifestPath), document.input));
      const info = await stat(sourcePath);
      if (!info.isFile() || info.size > OCR_LIMITS.bytes) throw new QualificationError('INPUT_TOO_LARGE_OR_NOT_FILE');
      const bytes = await readFile(sourcePath);
      const inputKind = identifyOcrUpload(bytes);
      // No recognition stub, parser-string fixture or injected engine is supported here.
      const pages = await recognizeOcrDocument(bytes, document.intake);
      const rows = parseOcrPages(pages, document.parse);
      if (rows.some(row => row.approved)) throw new QualificationError('EXTRACTION_APPROVED_A_ROW');
      const scores = scoreRows(document.expectedRows, rows);
      addScores(all, scores);
      const source = document.provenance;
      const rasterPages = new Set(pages.filter(page => page.engine.includes('tesseract')).map(page => page.page));
      const eligible = source.humanHandwritten && source.representativeOfFamilyWorkflow
        && source.groundTruthDoubleChecked && !source.origin.startsWith('synthetic-')
        && document.expectedRows.some(row => rasterPages.has(row.page));
      if (eligible) {
        representativeDocuments++; representativePages += rasterPages.size;
        addScores(representative, scoreRows(document.expectedRows.filter(row => rasterPages.has(row.page)),
          rows.filter(row => rasterPages.has(row.source.page))));
      }
      const signature = { bytes: createHash('sha256').update(bytes).digest('hex'),
        rows: recognitionSignature(rows), count: rows.length, resolved: hasResolvedRecognition(rows) };
      privateSignatures.set(index, signature);
      if (document.repeatOf !== undefined) {
        const original = privateSignatures.get(document.repeatOf);
        if (!original) repeats.unavailablePairs++;
        else if (document.repeatKind === 'same-bytes' && original.bytes !== signature.bytes) repeats.invalidExactPairs++;
        else {
          repeats.comparedPairs++;
          if (!original.count || !signature.count) repeats.emptyPairs++;
          else if (!original.resolved && !signature.resolved) repeats.unresolvedPairs++;
          else if (original.rows === signature.rows) repeats.consistentPairs++;
          else repeats.inconsistentPairs++;
        }
      }
      results.push({ index, executionStatus: 'MEASURED', origin: source.origin, inputKind,
        pageCount: pages.length, representativeEligible: eligible,
        userSuppliedDateContext: !!document.parse?.defaultDate,
        engines: [...new Set(pages.map(page => page.engine.includes('tesseract') ? 'tesseract' : 'native-pdf-text'))],
        scores: summarizeScores(scores) });
    } catch {
      failedDocuments++;
      if (document.repeatOf !== undefined) repeats.unavailablePairs++;
      // Native errors and filesystem exceptions can contain private paths or OCR text.
      results.push({ index, executionStatus: 'ERROR', code: 'PRIVATE_INPUT_OR_LOCAL_ENGINE_FAILED' });
    }
  }
  const incomplete = failedDocuments > 0 || repeats.invalidExactPairs > 0;
  return {
    version: 1, harness: 'sat-tracker-image-qualification-v1', completedAt: new Date().toISOString(),
    revision: /^[a-f0-9]{40}$/.test(options.revision ?? '') ? options.revision : 'unknown',
    parserVersion: OCR_PARSER_VERSION, pinnedModelSHA256: OCR_MODEL_SHA256,
    executionStatus: incomplete ? 'ERROR' : 'COMPLETE',
    documents: manifest.documents.length, measuredDocuments: manifest.documents.length - failedDocuments,
    failedDocuments, alignment: { method: ALIGNMENT_METHOD, minimumSimilarity: MINIMUM_ROW_SIMILARITY,
      status: 'AUTOMATIC_ESTIMATE_REQUIRES_PRIVATE_REVIEW' },
    allDocuments: summarizeScores(all),
    representativeHandwriting: {
      status: !representativeDocuments || incomplete ? 'BLOCKED' : 'MEASURED_NOT_ACCEPTED',
      reason: !representativeDocuments ? 'NO_REPRESENTATIVE_REVIEWED_HUMAN_IMAGE_CORPUS'
        : incomplete ? 'CORPUS_RUN_INCOMPLETE' : 'ALIGNMENT_REVIEW_AND_ACCEPTANCE_THRESHOLDS_REQUIRED',
      documents: representativeDocuments, pages: representativePages,
      provenance: 'MANIFEST_ATTESTATION_NOT_INDEPENDENTLY_VERIFIED',
      scores: summarizeScores(representative),
    },
    repeatedUploadRecognition: { ...repeats, scope: 'EXTRACTION_CONSISTENCY_ONLY' },
    canonicalDuplicateDetection: 'NOT_RUN', reviewedImportCorrectness: 'NOT_RUN',
    productionOrDeviceAcceptance: 'NOT_RUN', careRecordsWritten: 0, results,
  };
}
