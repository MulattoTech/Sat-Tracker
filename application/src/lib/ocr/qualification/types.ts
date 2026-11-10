import type { OcrCandidate, OcrFieldOrigin, OcrParseOptions } from '../types';
import type { OcrIntakeOptions } from '../intake';

export const QUALIFICATION_FIELDS = [
  'eventType', 'localDate', 'localTime', 'amount', 'unit', 'feedDuration',
] as const;
export type QualificationField = typeof QUALIFICATION_FIELDS[number];
export type FieldValue = string | number | null;
export type RecognizedCandidate = OcrCandidate & {
  readonly feedDuration?: number | null;
  readonly fieldSources: OcrCandidate['fieldSources'] & { readonly feedDuration?: OcrFieldOrigin };
};

/** Missing properties are unscored. Explicit null means a reviewer expects abstention. */
export interface ExpectedRow {
  readonly page: number;
  /** Private verbatim row transcription, used only for automatic row correspondence. */
  readonly transcription: string;
  readonly fields: Partial<Record<QualificationField, FieldValue>> & {
    readonly eventType: 'feed' | 'diaper' | 'sleep' | null;
    readonly localDate: string | null;
    readonly localTime: string | null;
  };
}

export const CORPUS_ORIGINS = [
  'family-paper-log', 'volunteer-paper-log', 'synthetic-print', 'synthetic-cursive-font',
] as const;
export interface QualificationDocument {
  readonly input: string;
  readonly provenance: {
    readonly origin: typeof CORPUS_ORIGINS[number];
    readonly humanHandwritten: boolean;
    readonly representativeOfFamilyWorkflow: boolean;
    readonly groundTruthDoubleChecked: boolean;
    readonly consentForLocalEvaluation: true;
  };
  readonly intake?: Omit<OcrIntakeOptions, 'signal'>;
  readonly parse?: OcrParseOptions;
  readonly expectedRows: readonly ExpectedRow[];
  /** Zero-based earlier document index; recognition reruns even for the same file. */
  readonly repeatOf?: number;
  readonly repeatKind?: 'same-bytes' | 'transformed-scan';
}

export interface QualificationManifest {
  readonly version: 1;
  readonly documents: readonly QualificationDocument[];
}

export interface FieldCounts {
  known: number;
  correct: number;
  wrong: number;
  abstained: number;
  missedRow: number;
  expectedUnresolved: number;
  safeAbstentions: number;
  unsafeGuesses: number;
  unresolvedSuggestions: number;
  unresolvedMissedRow: number;
  userContextAnswers: number;
}

export interface ScoreCounts {
  expectedRows: number;
  predictedRows: number;
  matchedRows: number;
  missingRows: number;
  extraRows: number;
  fields: Record<QualificationField, FieldCounts>;
}
