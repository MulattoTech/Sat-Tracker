import { createHash } from 'node:crypto';
import type { OcrDocument, Prisma } from '@prisma/client';
import type { OcrCandidate, OcrEditableField } from './types';
import type { OcrDuplicate, OcrReviewRequest, OcrReviewPreview } from './contracts';
import type { ExternalImportRecord } from '@/src/types/external-import';
import { openOcrState } from './crypto';
import { resolveOcrLocalDateTime, validateOcrCandidate } from './validation';
import { OCR_LIMITS } from './intake';
import { OcrError } from './errors';

const fields: OcrEditableField[] = ['eventType', 'localDate', 'localTime', 'endLocalDate', 'endLocalTime', 'feedType', 'bottleType', 'amount', 'unit', 'diaperType', 'sleepType', 'notes', 'feedDuration', 'offeredAmount', 'formulaKcalOz', 'formulaName', 'bottleLabel', 'sourceCaregiverName'];
export const ocrScope = (document: Pick<OcrDocument, 'id' | 'familyId'>) => `${document.familyId}:${document.id}`;
export interface OriginalOcrState { rows: OcrCandidate[]; pages: { page: number; text: string; engine: string; confidence: number | null }[] }

export function readReviewRequest(input: unknown, document: OcrDocument): OcrReviewRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OcrError('Invalid review.');
  const value = input as Record<string, unknown>;
  if (!Number.isInteger(value.revision) || Number(value.revision) < 0) throw new OcrError('A review revision is required.');
  if (typeof value.timeZone !== 'string' || value.timeZone.length > 128) throw new OcrError('Choose a valid time zone.');
  try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }); } catch { throw new OcrError('Choose a valid time zone.'); }
  if (!Array.isArray(value.rows) || value.rows.length > OCR_LIMITS.rows) throw new OcrError('A review can contain at most 200 events.');
  const original = openOcrState<OriginalOcrState>(document.originalState, `${ocrScope(document)}:original`);
  const originals = new Map(original.rows.map(row => [row.id, row]));
  const ids = new Set<string>();
  const rows = value.rows.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new OcrError('Invalid event.');
    const row = entry as OcrCandidate;
    if (typeof row.id !== 'string' || ids.has(row.id)) throw new OcrError('Every review event needs a unique source row.');
    ids.add(row.id);
    const baseline = originals.get(row.id);
    const manual = /^manual-[a-f\d-]{36}$/i.test(row.id);
    if (!baseline && !manual) throw new OcrError('An event has an unknown source row.');
    const manualPage = row.source?.page;
    if (!baseline && (!Number.isInteger(manualPage) || !original.pages.some(page => page.page === manualPage))) throw new OcrError('Select the source page for the manual event.');
    const fieldSources: OcrCandidate['fieldSources'] = {};
    for (const field of fields) {
      // Leave absent optional fields absent so receipts for older drafts still replay.
      if (row[field] === undefined && baseline?.[field] === undefined) continue;
      fieldSources[field] = baseline && row[field] === baseline[field] ? baseline.fieldSources[field] || 'source' : 'corrected';
    }
    // Source evidence and extraction warnings come from persisted server data, never review JSON.
    const bound = {
      ...row,
      source: baseline?.source || { page: manualPage, line: 1, slot: 0, rawText: '', engine: 'manual', confidence: null },
      fieldSources,
      warnings: baseline?.warnings || [],
    };
    const checked = validateOcrCandidate(bound, { allowIncomplete: true, deferSleepOrdering: true });
    if (!checked.candidate) throw new OcrError(`Invalid review event: ${checked.errors.join(' ')}`);
    return checked.candidate;
  });
  const duplicateDecisions: Record<string, 'skip' | 'keep'> = {};
  if (value.duplicateDecisions !== undefined) {
    if (!value.duplicateDecisions || typeof value.duplicateDecisions !== 'object' || Array.isArray(value.duplicateDecisions)) throw new OcrError('Invalid duplicate decisions.');
    for (const [id, decision] of Object.entries(value.duplicateDecisions)) {
      if (!ids.has(id) || !['skip', 'keep'].includes(String(decision))) throw new OcrError('Invalid duplicate decision.');
      duplicateDecisions[id] = decision as 'skip' | 'keep';
    }
  }
  const utcOffsets: NonNullable<OcrReviewRequest['utcOffsets']> = {};
  if (value.utcOffsets !== undefined) {
    if (!value.utcOffsets || typeof value.utcOffsets !== 'object' || Array.isArray(value.utcOffsets)) throw new OcrError('Invalid clock occurrence.');
    for (const [id, offset] of Object.entries(value.utcOffsets)) {
      if (!ids.has(id) || !offset || typeof offset !== 'object' || Array.isArray(offset)) throw new OcrError('Invalid clock occurrence.');
      const selection: { start?: number; end?: number } = {};
      for (const key of ['start', 'end'] as const) {
        const number = (offset as Record<string, unknown>)[key];
        if (number !== undefined && (!Number.isInteger(number) || Math.abs(Number(number)) > 840)) throw new OcrError('Invalid UTC offset.');
        if (number !== undefined) selection[key] = number as number;
      }
      utcOffsets[id] = selection;
    }
  }
  return { revision: value.revision as number, rows, timeZone: value.timeZone, acknowledgeWarnings: value.acknowledgeWarnings === true, duplicateDecisions, utcOffsets, purgeSourceAfterCommit: value.purgeSourceAfterCommit === true };
}

export function reviewTimes(row: OcrCandidate, review: OcrReviewRequest) {
  const start = resolveOcrLocalDateTime(row.localDate || '', row.localTime || '', review.timeZone, { utcOffsetMinutes: review.utcOffsets?.[row.id]?.start });
  const end = row.eventType === 'sleep' ? resolveOcrLocalDateTime(row.endLocalDate || '', row.endLocalTime || '', review.timeZone, { utcOffsetMinutes: review.utcOffsets?.[row.id]?.end }) : undefined;
  return { start, end };
}

export function reviewIssues(review: OcrReviewRequest): OcrReviewPreview['issues'] {
  return review.rows.map(row => {
    const checked = validateOcrCandidate(row, { now: new Date(), deferSleepOrdering: true });
    const { start, end } = reviewTimes(row, review);
    const errors = [...checked.errors];
    if (start.status !== 'valid') errors.push(start.message || 'Resolve the event time.');
    if (end && end.status !== 'valid') errors.push(end.message || 'Resolve the sleep end time.');
    if (start.utc && end?.utc && end.utc <= start.utc) errors.push('Sleep end must be after its start.');
    return { rowId: row.id, errors: [...new Set(errors)], warnings: [...new Set([...row.warnings, ...checked.warnings])] };
  });
}

export interface FindOcrDuplicatesOptions {
  fuzzyWindowMs?: number;
  exactWindowMs?: number;
  includeDetails?: boolean;
}

export async function findOcrDuplicates(
  tx: Prisma.TransactionClient,
  document: OcrDocument,
  review: OcrReviewRequest,
  options?: FindOcrDuplicatesOptions,
): Promise<OcrDuplicate[]> {
  const duplicates: OcrDuplicate[] = [];
  const seen = new Set<string>();
  const addDuplicate = (item: OcrDuplicate) => {
    const key = `${item.rowId}:${item.recordId}`;
    if (!seen.has(key)) {
      seen.add(key);
      duplicates.push(item);
    }
  };

  const exactWindowMs = options?.exactWindowMs ?? 60_000;
  const fuzzyWindowMs = options?.fuzzyWindowMs ?? 15 * 60_000;

  // Resolve each wall clock once. Repeating Intl/DST resolution in the pair loop
  // made a bounded 200-row preview spend seconds on synchronous clock work.
  const approved = review.rows.filter(row => row.approved).map(row => {
    const utc = reviewTimes(row, review).start.utc;
    return { row, utc, milliseconds: utc ? Date.parse(utc) : null };
  });

  for (const { row, utc, milliseconds } of approved) {
    if (!utc || milliseconds === null || row.eventType === 'unknown') continue;
    const time = new Date(milliseconds);

    // 1. Exact source-record provenance deduplication if previously imported into ExternalImportRecord
    const txAny = tx as unknown as { externalImportRecord?: { findUnique?: (args: unknown) => Promise<{ targetRecordId: string } | null> } };
    if (txAny.externalImportRecord?.findUnique) {
      try {
        const exactProvenance = await txAny.externalImportRecord.findUnique({
          where: {
            familyId_providerId_sourceEntityType_sourceRecordId: {
              familyId: document.familyId,
              providerId: 'babytracker-ocr-v1',
              sourceEntityType: row.eventType,
              sourceRecordId: `${document.babyId}:${document.sourceHash}:${row.id}`,
            },
          },
        });
        if (exactProvenance) {
          addDuplicate({
            rowId: row.id,
            recordId: exactProvenance.targetRecordId,
            eventType: row.eventType,
            occurredAt: utc,
            ...(options?.includeDetails ? { matchType: 'exact', matchedFields: ['sourceRecordId'] } : {}),
          });
        }
      } catch {
        // Safe fallback if table is not present or mocked
      }
    }

    // 2. Exact and fuzzy duplicate detection against canonical care records
    const queryWindow = { gte: new Date(time.getTime() - fuzzyWindowMs), lte: new Date(time.getTime() + fuzzyWindowMs) };
    const scoped = { familyId: document.familyId, babyId: document.babyId, deletedAt: null };

    if (row.eventType === 'feed') {
      const matches = await tx.feedLog.findMany({
        where: { ...scoped, time: queryWindow },
        select: { id: true, time: true, type: true, bottleType: true, amount: true, unitAbbr: true },
        take: 50,
      });
      for (const match of matches) {
        const timeDiffMs = Math.abs(match.time.getTime() - time.getTime());
        const isExactTime = timeDiffMs <= exactWindowMs;

        const amountMatches = row.amount != null && match.amount != null
          ? Math.abs(row.amount - match.amount) < 0.01
          : (row.amount == null && match.amount == null);
        const unitMatches = (!row.unit && !match.unitAbbr)
          || (row.unit?.toUpperCase() === match.unitAbbr?.toUpperCase());
        const typeMatches = row.feedType == null || row.feedType === match.type;
        const bottleMatches = row.bottleType == null || row.bottleType === match.bottleType;

        const valuesMatch = amountMatches && unitMatches && typeMatches && bottleMatches;
        const hasValueEvidence = row.amount != null || row.feedType != null;

        let matchType: 'exact' | 'fuzzy' | null = null;
        const matchedFields: string[] = ['child', 'eventType', 'timestamp'];

        if (isExactTime && valuesMatch) {
          matchType = 'exact';
          if (amountMatches && row.amount != null) matchedFields.push('amount', 'unit');
          if (typeMatches && row.feedType != null) matchedFields.push('feedType');
          if (bottleMatches && row.bottleType != null) matchedFields.push('bottleType');
        } else if (isExactTime) {
          matchType = 'fuzzy';
          matchedFields.push('timeWindow');
        } else if (valuesMatch && hasValueEvidence && timeDiffMs <= fuzzyWindowMs) {
          matchType = 'fuzzy';
          matchedFields.push('fuzzyTime', 'amount', 'unit');
          if (typeMatches && row.feedType != null) matchedFields.push('feedType');
        }

        if (matchType) {
          addDuplicate({
            rowId: row.id,
            recordId: match.id,
            eventType: row.eventType,
            occurredAt: match.time.toISOString(),
            ...(options?.includeDetails ? { matchType, matchedFields } : {}),
          });
        }
      }
    } else if (row.eventType === 'diaper') {
      const matches = await tx.diaperLog.findMany({
        where: { ...scoped, time: queryWindow },
        select: { id: true, time: true, type: true },
        take: 50,
      });
      for (const match of matches) {
        const timeDiffMs = Math.abs(match.time.getTime() - time.getTime());
        const isExactTime = timeDiffMs <= exactWindowMs;
        const typeMatches = row.diaperType == null || row.diaperType === match.type;

        let matchType: 'exact' | 'fuzzy' | null = null;
        const matchedFields: string[] = ['child', 'eventType', 'timestamp'];

        if (isExactTime && typeMatches) {
          matchType = 'exact';
          if (row.diaperType != null) matchedFields.push('diaperType');
        } else if (isExactTime) {
          matchType = 'fuzzy';
          matchedFields.push('timeWindow');
        } else if (typeMatches && row.diaperType != null && timeDiffMs <= fuzzyWindowMs) {
          matchType = 'fuzzy';
          matchedFields.push('fuzzyTime', 'diaperType');
        }

        if (matchType) {
          addDuplicate({
            rowId: row.id,
            recordId: match.id,
            eventType: row.eventType,
            occurredAt: match.time.toISOString(),
            ...(options?.includeDetails ? { matchType, matchedFields } : {}),
          });
        }
      }
    } else if (row.eventType === 'sleep') {
      const matches = await tx.sleepLog.findMany({
        where: { ...scoped, startTime: queryWindow },
        select: { id: true, startTime: true, endTime: true, type: true },
        take: 50,
      });
      for (const match of matches) {
        const timeDiffMs = Math.abs(match.startTime.getTime() - time.getTime());
        const isExactTime = timeDiffMs <= exactWindowMs;
        const typeMatches = row.sleepType == null || row.sleepType === match.type;

        let matchType: 'exact' | 'fuzzy' | null = null;
        const matchedFields: string[] = ['child', 'eventType', 'timestamp'];

        if (isExactTime && typeMatches) {
          matchType = 'exact';
          if (row.sleepType != null) matchedFields.push('sleepType');
        } else if (isExactTime) {
          matchType = 'fuzzy';
          matchedFields.push('timeWindow');
        } else if (typeMatches && row.sleepType != null && timeDiffMs <= fuzzyWindowMs) {
          matchType = 'fuzzy';
          matchedFields.push('fuzzyTime', 'sleepType');
        }

        if (matchType) {
          addDuplicate({
            rowId: row.id,
            recordId: match.id,
            eventType: row.eventType,
            occurredAt: match.startTime.toISOString(),
            ...(options?.includeDetails ? { matchType, matchedFields } : {}),
          });
        }
      }
    }
  }

  // 3. Repeated same-time events on one sheet need an explicit keep/skip decision too.
  for (let index = 0; index < approved.length; index++) {
    const { row, milliseconds } = approved[index];
    if (milliseconds === null) continue;
    for (const previous of approved.slice(0, index)) {
      if (row.eventType === previous.row.eventType && previous.utc && previous.milliseconds !== null) {
        const timeDiffMs = Math.abs(milliseconds - previous.milliseconds);
        if (timeDiffMs <= exactWindowMs) {
          let matchType: 'exact' | 'fuzzy' = 'exact';
          const matchedFields: string[] = ['eventType', 'timeWindow'];
          if (row.eventType === 'feed') {
            const valuesMatch = row.amount === previous.row.amount && row.feedType === previous.row.feedType && row.bottleType === previous.row.bottleType;
            matchType = valuesMatch ? 'exact' : 'fuzzy';
            if (valuesMatch) matchedFields.push('amount', 'feedType');
          } else if (row.eventType === 'diaper') {
            const valuesMatch = row.diaperType === previous.row.diaperType;
            matchType = valuesMatch ? 'exact' : 'fuzzy';
            if (valuesMatch) matchedFields.push('diaperType');
          } else if (row.eventType === 'sleep') {
            const valuesMatch = row.sleepType === previous.row.sleepType;
            matchType = valuesMatch ? 'exact' : 'fuzzy';
            if (valuesMatch) matchedFields.push('sleepType');
          }
          addDuplicate({
            rowId: row.id,
            recordId: `draft:${previous.row.id}`,
            eventType: row.eventType,
            occurredAt: previous.utc,
            ...(options?.includeDetails ? { matchType, matchedFields } : {}),
          });
        }
      }
    }
  }
  return duplicates;
}

export function reviewHash(review: OcrReviewRequest): string {
  // Recursively sort maps: JSON property insertion order is not part of a caregiver's decision.
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;
  return createHash('sha256').update(JSON.stringify(canonical({ rows: review.rows, timeZone: review.timeZone, utcOffsets: review.utcOffsets || {}, duplicateDecisions: review.duplicateDecisions || {} }))).digest('hex');
}

export function toSproutRecords(document: OcrDocument, review: OcrReviewRequest): ExternalImportRecord[] {
  return review.rows.filter(row => row.approved && review.duplicateDecisions?.[row.id] !== 'skip').map(row => {
    const { start, end } = reviewTimes(row, review);
    if (!start.utc || (row.eventType === 'sleep' && !end?.utc)) throw new OcrError('Resolve every approved timestamp before importing.');
    const source = { providerId: 'babytracker-ocr-v1', entityType: row.eventType, recordId: `${document.babyId}:${document.sourceHash}:${row.id}`, childId: document.babyId };
    const base = { source, sourceChildId: document.babyId, notes: row.notes || undefined };
    const time = start.utc.slice(0, 19);
    if (row.eventType === 'feed' && row.feedType) return {
      ...base, targetType: 'feed', time, type: row.feedType, amount: row.amount ?? undefined,
      unitAbbr: row.unit ?? undefined, bottleType: row.bottleType ?? undefined,
      feedDuration: row.feedDuration ?? undefined,
      offeredAmount: row.offeredAmount ?? undefined, formulaKcalOz: row.formulaKcalOz ?? undefined,
      formulaName: row.formulaName ?? undefined, bottleLabel: row.bottleLabel ?? undefined,
      sourceCaregiverName: row.sourceCaregiverName ?? undefined,
    };
    if (row.eventType === 'diaper' && row.diaperType) return { ...base, targetType: 'diaper', time, type: row.diaperType };
    if (row.eventType === 'sleep' && row.sleepType && end?.utc) return { ...base, targetType: 'sleep', startTime: time, endTime: end.utc.slice(0, 19), type: row.sleepType };
    throw new OcrError('Resolve every approved event type before importing.');
  });
}
