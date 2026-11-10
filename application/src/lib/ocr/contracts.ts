import type { OcrCandidate } from './types';
import type { ExternalImportExecutionResult } from '@/src/types/external-import';

export interface OcrDocumentView {
  id: string;
  babyId: string;
  originalName: string;
  mimeType: string;
  pageCount: number;
  pages?: number[];
  parserVersion: string;
  sourceTimezone: string;
  revision: number;
  rows: OcrCandidate[];
  originalRows: OcrCandidate[];
  committedAt: string | null;
  result: (ExternalImportExecutionResult & { skipped?: number }) | null;
  sourceExpiresAt: string;
  purgedAt?: string | null;
  hasSource: boolean;
  createdAt: string;
  utcOffsets?: OcrReviewRequest['utcOffsets'];
  duplicateDecisions?: OcrReviewRequest['duplicateDecisions'];
}

/** History listings deliberately omit extracted/review text and import-result payloads. */
export type OcrDocumentSummary = Pick<OcrDocumentView,
  'id' | 'babyId' | 'originalName' | 'mimeType' | 'pageCount' | 'parserVersion'
  | 'sourceTimezone' | 'revision' | 'committedAt' | 'sourceExpiresAt' | 'purgedAt' | 'hasSource' | 'createdAt'>;

export interface OcrReviewRequest {
  revision: number;
  rows: OcrCandidate[];
  timeZone: string;
  acknowledgeWarnings?: boolean;
  duplicateDecisions?: Record<string, 'skip' | 'keep'>;
  utcOffsets?: Record<string, { start?: number; end?: number }>;
  purgeSourceAfterCommit?: boolean;
}

export interface OcrDuplicate {
  rowId: string;
  recordId: string;
  eventType: string;
  occurredAt: string;
  matchType?: 'exact' | 'fuzzy';
  matchedFields?: string[];
}

export interface OcrReviewPreview {
  duplicates: OcrDuplicate[];
  issues: { rowId: string; errors: string[]; warnings: string[] }[];
}
