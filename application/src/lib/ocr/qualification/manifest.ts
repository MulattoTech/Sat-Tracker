import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { parseOcrCrop } from '../intake';
import { isOcrDate } from '../validation';
import { CORPUS_ORIGINS, QUALIFICATION_FIELDS, type QualificationManifest } from './types';
import { transcriptTokens } from './score';

export class QualificationError extends Error {
  constructor(readonly code: string) { super(code); }
}
const invalid = (): never => { throw new QualificationError('INVALID_PRIVATE_MANIFEST'); };
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
const oneOf = (value: unknown, choices: readonly string[]): value is string =>
  typeof value === 'string' && choices.includes(value);

export function parseQualificationManifest(value: unknown): QualificationManifest {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.documents)
    || value.documents.length < 1 || value.documents.length > 100) invalid();
  const documents = (value as Record<string, unknown>).documents as unknown[];
  documents.forEach((document, index) => {
    if (!object(document) || typeof document.input !== 'string' || document.input.length > 4096
      || /[\x00-\x1f]/.test(document.input) || path.isAbsolute(document.input)
      || !/\.(?:png|jpe?g|pdf)$/i.test(document.input)) invalid();
    const doc = document as Record<string, unknown>;
    const provenance = doc.provenance;
    if (!object(provenance) || !CORPUS_ORIGINS.includes(provenance.origin as typeof CORPUS_ORIGINS[number])
      || typeof provenance.humanHandwritten !== 'boolean'
      || typeof provenance.representativeOfFamilyWorkflow !== 'boolean'
      || typeof provenance.groundTruthDoubleChecked !== 'boolean'
      || provenance.consentForLocalEvaluation !== true) invalid();
    const source = provenance as Record<string, unknown>;
    const synthetic = String(source.origin).startsWith('synthetic-');
    if ((synthetic && (source.humanHandwritten || source.representativeOfFamilyWorkflow))
      || (source.representativeOfFamilyWorkflow && !source.humanHandwritten)) invalid();
    if (doc.repeatOf !== undefined && (!integer(doc.repeatOf, 0, index - 1)
      || !oneOf(doc.repeatKind, ['same-bytes', 'transformed-scan']))) invalid();
    if (doc.repeatOf === undefined && doc.repeatKind !== undefined) invalid();
    if (doc.intake !== undefined) {
      if (!object(doc.intake)) invalid();
      const intake = doc.intake as Record<string, unknown>;
      if (Object.keys(intake).some(key => !['rotation', 'selectedPage', 'crop'].includes(key))) invalid();
      if (intake.rotation !== undefined && ![0, 90, 180, 270].includes(Number(intake.rotation))) invalid();
      if (intake.rotation !== undefined && typeof intake.rotation !== 'number') invalid();
      if (intake.selectedPage !== undefined && !integer(intake.selectedPage, 1, 100)) invalid();
      if (intake.crop !== undefined) {
        if (!object(intake.crop) || ['left', 'top', 'width', 'height'].some(key =>
          typeof (intake.crop as Record<string, unknown>)[key] !== 'number')
          || (intake.crop.unit !== undefined && !oneOf(intake.crop.unit, ['pixel', 'percent']))) invalid();
        try { parseOcrCrop(intake.crop); } catch { invalid(); }
      }
    }
    if (doc.parse !== undefined) {
      if (!object(doc.parse)) invalid();
      const parse = doc.parse as Record<string, unknown>;
      if (Object.keys(parse).some(key => !['defaultDate', 'timeFormat'].includes(key))) invalid();
      if (parse.defaultDate !== undefined && (typeof parse.defaultDate !== 'string' || !isOcrDate(parse.defaultDate))) invalid();
      if (parse.timeFormat !== undefined && !oneOf(parse.timeFormat, ['24h', '12h', 'unknown'])) invalid();
    }
    if (!Array.isArray(doc.expectedRows) || doc.expectedRows.length > 200) invalid();
    for (const row of doc.expectedRows as unknown[]) {
      if (!object(row) || !integer(row.page, 1, 100) || typeof row.transcription !== 'string'
        || row.transcription.length > 4096 || !transcriptTokens(row.transcription).length
        || transcriptTokens(row.transcription).length > 64 || !object(row.fields)) invalid();
      const fields = (row as Record<string, unknown>).fields as Record<string, unknown>;
      if (Object.keys(fields).some(key => !QUALIFICATION_FIELDS.includes(key as typeof QUALIFICATION_FIELDS[number]))) invalid();
      for (const required of ['eventType', 'localDate', 'localTime']) if (!Object.hasOwn(fields, required)) invalid();
      if (fields.eventType !== null && !oneOf(fields.eventType, ['feed', 'diaper', 'sleep'])) invalid();
      if (fields.localDate !== null && (typeof fields.localDate !== 'string' || !isOcrDate(fields.localDate))) invalid();
      if (fields.localTime !== null && (typeof fields.localTime !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(fields.localTime))) invalid();
      if (Object.hasOwn(fields, 'unit') && fields.unit !== null && !oneOf(fields.unit, ['ML', 'OZ'])) invalid();
      for (const field of ['amount', 'feedDuration']) {
        if (Object.hasOwn(fields, field) && fields[field] !== null
          && (typeof fields[field] !== 'number' || !Number.isFinite(fields[field]) || Number(fields[field]) < 0)) invalid();
      }
      if (fields.feedDuration !== undefined && fields.feedDuration !== null && !integer(fields.feedDuration, 0, 86_400)) invalid();
      if (object(doc.intake) && doc.intake.selectedPage !== undefined
        && (row as Record<string, unknown>).page !== doc.intake.selectedPage) invalid();
    }
  });
  return value as unknown as QualificationManifest;
}

/** Resolve symlinks before reading; the private directory cannot be escaped via ../ or a link. */
export async function privatePath(privateRoot: string, requested: string): Promise<string> {
  const root = await realpath(privateRoot), resolved = await realpath(requested);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    throw new QualificationError('PATH_OUTSIDE_PRIVATE_CORPUS');
  }
  return resolved;
}
