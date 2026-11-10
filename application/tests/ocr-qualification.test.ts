import { describe, expect, it } from 'vitest';
import { parseOcrPages } from '@/src/lib/ocr/parser';
import { parseQualificationManifest } from '@/src/lib/ocr/qualification/manifest';
import { alignRows, emptyScores, hasResolvedRecognition, recognitionSignature, scoreRows, summarizeScores } from '@/src/lib/ocr/qualification/score';
import type { ExpectedRow, QualificationDocument, RecognizedCandidate } from '@/src/lib/ocr/qualification/types';

const text = '08:15 bottle formula 90 mL';
const expected = (overrides: Partial<ExpectedRow> = {}): ExpectedRow => ({
  page: 1, transcription: text,
  fields: { eventType: 'feed', localDate: '2026-10-20', localTime: '08:15', amount: 90, unit: 'ML' },
  ...overrides,
});
const recognized = (overrides: Partial<RecognizedCandidate> = {}): RecognizedCandidate => ({
  ...parseOcrPages([{ page: 1, text }], { defaultDate: '2026-10-20', timeFormat: '24h' })[0],
  ...overrides,
});
const document = (): QualificationDocument => ({
  input: 'private.png', provenance: { origin: 'synthetic-print', humanHandwritten: false,
    representativeOfFamilyWorkflow: false, groundTruthDoubleChecked: true, consentForLocalEvaluation: true },
  expectedRows: [expected()],
});

describe('OCR image qualification scoring (not image-recognition benchmarks)', () => {
  it('counts missed and extra candidates without matching unrelated text', () => {
    const diaper = parseOcrPages([{ page: 1, text: '21:45 wet diaper' }], { timeFormat: '24h' })[0];
    const rows = [expected(), expected({ transcription: '04:30 sleep until 07:00',
      fields: { eventType: 'sleep', localDate: '2026-10-20', localTime: '04:30' } })];
    const scores = summarizeScores(scoreRows(rows, [recognized(), diaper]));
    expect(scores).toMatchObject({ expectedRows: 2, predictedRows: 2, matchedRows: 1,
      missingRows: 1, extraRows: 1, rowRecall: 0.5, rowPrecision: 0.5, falseDiscoveryRate: 0.5 });
    expect(scores.fields.localTime).toMatchObject({ known: 2, correct: 1, missedRow: 1, accuracy: 0.5 });
  });

  it('never aligns a candidate from the wrong page, even when every field is identical', () => {
    const scores = scoreRows([expected({ page: 2 })], [recognized()]);
    expect(scores).toMatchObject({ matchedRows: 0, missingRows: 1, extraRows: 1 });
  });

  it('aligns transcription independently of expected values and penalizes wrong dates, volumes and duration', () => {
    const truth = expected({ transcription: '2026-10-20 08:15 bottle formula 90 mL duration 20 min',
      fields: { ...expected().fields, feedDuration: 1200 } });
    const wrong = recognized({ localDate: '2026-10-21', amount: 190, feedDuration: 20,
      fieldSources: { ...recognized().fieldSources, feedDuration: 'source' },
      source: { ...recognized().source, rawText: '2026-10-21 08:15 bottle formula 190 mL duration 20 min' } });
    const scores = summarizeScores(scoreRows([truth], [wrong]));
    expect(scores.matchedRows).toBe(1);
    expect(scores.fields.localDate).toMatchObject({ wrong: 1, accuracy: 0 });
    expect(scores.fields.amount).toMatchObject({ wrong: 1, accuracy: 0 });
    expect(scores.fields.feedDuration).toMatchObject({ wrong: 1, accuracy: 0 });
    expect(scores.fields.unit.accuracy).toBe(1);
  });

  it('scores unknown-field abstention separately from invented answers and missing rows', () => {
    const unknown = expected({ fields: { ...expected().fields, amount: null } });
    const abstained = recognized({ amount: null, fieldSources: { ...recognized().fieldSources, amount: 'ambiguous' } });
    expect(scoreRows([unknown], [abstained]).fields.amount).toMatchObject({
      expectedUnresolved: 1, safeAbstentions: 1, unsafeGuesses: 0 });
    expect(scoreRows([unknown], [recognized()]).fields.amount).toMatchObject({
      expectedUnresolved: 1, safeAbstentions: 0, unsafeGuesses: 1 });
    expect(scoreRows([unknown], []).fields.amount).toMatchObject({
      safeAbstentions: 0, unresolvedMissedRow: 1 });
    expect(scoreRows([expected()], [abstained]).fields.amount).toMatchObject({ known: 1, abstained: 1, correct: 0 });
    expect(scoreRows([expected()], [recognized({ amount: 90,
      fieldSources: { ...recognized().fieldSources, amount: 'ambiguous' } })]).fields.amount.abstained).toBe(1);
    for (const origin of ['ambiguous', 'missing'] as const) {
      expect(scoreRows([unknown], [recognized({ amount: 90,
        fieldSources: { ...recognized().fieldSources, amount: origin } })]).fields.amount).toMatchObject({
        expectedUnresolved: 1, safeAbstentions: 0, unsafeGuesses: 0, unresolvedSuggestions: 1,
      });
    }
  });

  it('does not reuse one detected row for duplicated expected rows or turn no observations into 100%', () => {
    const scores = summarizeScores(scoreRows([expected(), expected()], [recognized()]));
    expect(scores.rowRecall).toBe(0.5);
    expect(scores.missingRows).toBe(1);
    expect(summarizeScores(emptyScores()).rowRecall).toBeNull();
    expect(summarizeScores(emptyScores()).fields.feedDuration.accuracy).toBeNull();
  });

  it('exposes user-supplied date context and retains per-field denominators', () => {
    const scores = summarizeScores(scoreRows([expected()], [recognized()]));
    expect(scores.fields.localDate.userContextAnswers).toBe(1);
    expect(scores.fields.feedDuration.known).toBe(0);
    expect(scores.fields.amount.known).toBe(1);
  });

  it('uses deterministic monotonic page alignment and a multiset for recognition repeats', () => {
    const later = recognized({ localTime: '14:00', source: { ...recognized().source,
      rawText: '14:00 bottle breast milk 3 oz', line: 2 }, amount: 3, unit: 'OZ' });
    const truth = [expected(), expected({ transcription: later.source.rawText })];
    expect([...alignRows(truth, [recognized(), later])].sort()).toEqual([[0, 0], [1, 1]]);
    expect(recognitionSignature([recognized(), later])).toBe(recognitionSignature([later, recognized()]));
    expect(recognitionSignature([recognized(), recognized()])).not.toBe(recognitionSignature([recognized()]));
    const unresolved = parseOcrPages([{ page: 1, text: 'unreadable scribble' }]);
    expect(unresolved).toHaveLength(1);
    expect(hasResolvedRecognition(unresolved)).toBe(false);
    expect(hasResolvedRecognition([recognized()])).toBe(true);
  });

  it('never includes transcripts, field values, names or engine text in aggregate scores', () => {
    const row = recognized({ notes: 'PRIVATE-CHILD', formulaName: 'PRIVATE-FORMULA',
      source: { ...recognized().source, engine: 'PRIVATE-ENGINE-PATH', rawText: text } });
    const report = JSON.stringify(summarizeScores(scoreRows([expected()], [row])));
    for (const secret of ['PRIVATE-CHILD', 'PRIVATE-FORMULA', 'PRIVATE-ENGINE-PATH', '2026-10-20', text]) {
      expect(report).not.toContain(secret);
    }
  });
});

describe('private image corpus contract', () => {
  it('requires actual input files and explicit local-evaluation consent', () => {
    expect(parseQualificationManifest({ version: 1, documents: [document()] }).documents).toHaveLength(1);
    expect(() => parseQualificationManifest({ version: 1, documents: [{ ...document(), input: 'strings.txt' }] })).toThrow('INVALID_PRIVATE_MANIFEST');
    expect(() => parseQualificationManifest({ version: 1, documents: [{ ...document(),
      provenance: { ...document().provenance, consentForLocalEvaluation: false } }] })).toThrow('INVALID_PRIVATE_MANIFEST');
  });

  it.each(['synthetic-print', 'synthetic-cursive-font'])('rejects %s mislabelled as representative human handwriting', origin => {
    expect(() => parseQualificationManifest({ version: 1, documents: [{ ...document(), provenance: {
      ...document().provenance, origin, humanHandwritten: true, representativeOfFamilyWorkflow: true,
    } }] })).toThrow('INVALID_PRIVATE_MANIFEST');
  });

  it('rejects invalid annotation units, omitted date/time, dates, duration and selected-page mismatch', () => {
    for (const fields of [
      { ...expected().fields, unit: 'unknown' }, { eventType: 'feed' },
      { ...expected().fields, unit: ['ML'] }, { ...expected().fields, eventType: ['feed'] },
      { ...expected().fields, localDate: '2026-02-30' }, { ...expected().fields, localTime: '25:00' },
      { ...expected().fields, feedDuration: 20.5 }, { ...expected().fields, amount: Infinity },
    ]) {
      expect(() => parseQualificationManifest({ version: 1, documents: [{ ...document(),
        expectedRows: [{ ...expected(), fields }] }] })).toThrow('INVALID_PRIVATE_MANIFEST');
    }
    expect(() => parseQualificationManifest({ version: 1, documents: [{ ...document(),
      intake: { selectedPage: 2 } }] })).toThrow('INVALID_PRIVATE_MANIFEST');
  });

  it('rejects empty/oversized corpora, forward/self repeat references and inference hooks', () => {
    expect(() => parseQualificationManifest({ version: 1, documents: [] })).toThrow();
    expect(() => parseQualificationManifest({ version: 1, documents: Array(101).fill(document()) })).toThrow();
    expect(() => parseQualificationManifest({ version: 1, documents: [{ ...document(),
      repeatOf: 0, repeatKind: 'same-bytes' }] })).toThrow();
    expect(() => parseQualificationManifest({ version: 1, documents: [{ ...document(),
      intake: { recognize: 'pretend-engine' } }] })).toThrow();
    expect(() => parseQualificationManifest({ version: 1, documents: [document(), { ...document(),
      repeatOf: 0, repeatKind: ['same-bytes'] }] })).toThrow();
    expect(() => parseQualificationManifest({ version: 1, documents: [{ ...document(),
      intake: { crop: { left: '0', top: 0, width: 100, height: 100 } } }] })).toThrow();
  });
});
