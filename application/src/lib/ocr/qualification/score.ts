import {
  QUALIFICATION_FIELDS, type ExpectedRow, type FieldValue, type QualificationField,
  type RecognizedCandidate, type ScoreCounts,
} from './types';

export const ALIGNMENT_METHOD = 'page-constrained-monotonic-token-edit-v1';
export const MINIMUM_ROW_SIMILARITY = 0.6;

export function transcriptTokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function similarity(left: string, right: string): number {
  const a = transcriptTokens(left), b = transcriptTokens(right);
  if (!a.length || !b.length || a.length > 64 || b.length > 64) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(next[j - 1] + 1, previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = next;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

/** Ground truth values never drive matching. Field mistakes remain visible after alignment. */
export function alignRows(expected: readonly ExpectedRow[], predicted: readonly RecognizedCandidate[]): Map<number, number> {
  const matches = new Map<number, number>();
  for (const page of new Set(expected.map(row => row.page))) {
    const a = expected.map((row, index) => ({ row, index })).filter(item => item.row.page === page);
    const b = predicted.map((row, index) => ({ row, index })).filter(item => item.row.source.page === page);
    const scores = Array.from({ length: a.length + 1 }, () => new Float64Array(b.length + 1));
    const steps = Array.from({ length: a.length + 1 }, () => new Uint8Array(b.length + 1));
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const same = similarity(a[i - 1].row.transcription, b[j - 1].row.source.rawText);
        // Prefer maximum one-to-one row coverage, then the closest transcript match.
        const pair = same >= MINIMUM_ROW_SIMILARITY ? scores[i - 1][j - 1] + 1_000 + same : -1;
        const dropExpected = scores[i - 1][j], dropPredicted = scores[i][j - 1];
        if (pair >= dropExpected && pair >= dropPredicted) {
          scores[i][j] = pair; steps[i][j] = 1;
        } else if (dropExpected >= dropPredicted) {
          scores[i][j] = dropExpected; steps[i][j] = 2;
        } else {
          scores[i][j] = dropPredicted; steps[i][j] = 3;
        }
      }
    }
    let i = a.length, j = b.length;
    while (i > 0 && j > 0) {
      if (steps[i][j] === 1) { matches.set(a[i - 1].index, b[j - 1].index); i--; j--; }
      else if (steps[i][j] === 2) i--;
      else j--;
    }
  }
  return matches;
}

export function emptyScores(): ScoreCounts {
  return {
    expectedRows: 0, predictedRows: 0, matchedRows: 0, missingRows: 0, extraRows: 0,
    fields: Object.fromEntries(QUALIFICATION_FIELDS.map(field => [field, {
      known: 0, correct: 0, wrong: 0, abstained: 0, missedRow: 0,
      expectedUnresolved: 0, safeAbstentions: 0, unsafeGuesses: 0, unresolvedSuggestions: 0,
      unresolvedMissedRow: 0, userContextAnswers: 0,
    }])) as ScoreCounts['fields'],
  };
}

function resolvedValue(row: RecognizedCandidate, field: QualificationField): FieldValue {
  const origin = (row.fieldSources as Partial<Record<QualificationField, string>>)[field];
  const value = row[field];
  if (origin === 'ambiguous' || origin === 'missing' || value === undefined
    || (field === 'eventType' && value === 'unknown')) return null;
  return value;
}

function hasSuggestion(row: RecognizedCandidate, field: QualificationField): boolean {
  const value = row[field];
  return value !== undefined && value !== null && !(field === 'eventType' && value === 'unknown');
}

export function scoreRows(expected: readonly ExpectedRow[], predicted: readonly RecognizedCandidate[]): ScoreCounts {
  const result = emptyScores(), matches = alignRows(expected, predicted);
  result.expectedRows = expected.length; result.predictedRows = predicted.length;
  result.matchedRows = matches.size; result.missingRows = expected.length - matches.size;
  result.extraRows = predicted.length - matches.size;
  expected.forEach((row, index) => {
    const matchedIndex = matches.get(index);
    const actual = matchedIndex === undefined ? undefined : predicted[matchedIndex];
    for (const field of QUALIFICATION_FIELDS) {
      if (!Object.hasOwn(row.fields, field)) continue;
      const truth = row.fields[field], counts = result.fields[field];
      if (truth === null) {
        counts.expectedUnresolved++;
        if (!actual) counts.unresolvedMissedRow++;
        else if (!hasSuggestion(actual, field)) counts.safeAbstentions++;
        else if (resolvedValue(actual, field) === null) counts.unresolvedSuggestions++;
        else counts.unsafeGuesses++;
      } else {
        counts.known++;
        if (!actual) { counts.missedRow++; continue; }
        const value = resolvedValue(actual, field);
        if (field === 'localDate' && value !== null && actual.source.contextDateOrigin === 'user'
          && actual.fieldSources.localDate === 'context') counts.userContextAnswers++;
        if (value === null) counts.abstained++;
        else if (value === truth) counts.correct++;
        else counts.wrong++;
      }
    }
  });
  return result;
}

export function addScores(total: ScoreCounts, part: ScoreCounts): void {
  for (const key of ['expectedRows', 'predictedRows', 'matchedRows', 'missingRows', 'extraRows'] as const) total[key] += part[key];
  for (const field of QUALIFICATION_FIELDS) {
    for (const key of Object.keys(total.fields[field]) as (keyof ScoreCounts['fields'][QualificationField])[]) {
      total.fields[field][key] += part.fields[field][key];
    }
  }
}

const ratio = (numerator: number, denominator: number): number | null => denominator ? numerator / denominator : null;

/** Only controlled names, counts and ratios leave this module; never transcripts or field values. */
export function summarizeScores(counts: ScoreCounts) {
  return {
    ...counts,
    rowRecall: ratio(counts.matchedRows, counts.expectedRows),
    rowPrecision: ratio(counts.matchedRows, counts.predictedRows),
    falseDiscoveryRate: ratio(counts.extraRows, counts.predictedRows),
    fields: Object.fromEntries(QUALIFICATION_FIELDS.map(field => [field, {
      ...counts.fields[field],
      accuracy: ratio(counts.fields[field].correct, counts.fields[field].known),
      knownAbstentionRate: ratio(counts.fields[field].abstained, counts.fields[field].known),
      safeAbstentionRate: ratio(counts.fields[field].safeAbstentions, counts.fields[field].expectedUnresolved),
    }])),
  };
}

/** Private in-memory comparison only; this is NOT the canonical duplicate detector. */
export function recognitionSignature(rows: readonly RecognizedCandidate[]): string {
  return JSON.stringify(rows.map(row => QUALIFICATION_FIELDS.map(field => resolvedValue(row, field)))
    .map(values => JSON.stringify(values)).sort());
}

export function hasResolvedRecognition(rows: readonly RecognizedCandidate[]): boolean {
  return rows.some(row => QUALIFICATION_FIELDS.some(field => resolvedValue(row, field) !== null));
}
