import type { OcrCandidate, OcrEditableField } from '@/src/lib/ocr/types';
import type { OcrReviewRequest } from '@/src/lib/ocr/contracts';
import { normalizeAmountMl, resolveOcrLocalDateTime, validateOcrCandidate } from '@/src/lib/ocr/validation';

export type RowOffsets = NonNullable<OcrReviewRequest['utcOffsets']>[string];

export function manualOcrRow(page: number, id: string): OcrCandidate {
  return {
    id: `manual-${id}`, eventType: 'unknown', localDate: null, localTime: null,
    endLocalDate: null, endLocalTime: null, feedType: null, bottleType: null,
    amount: null, unit: null, feedDuration: null, offeredAmount: null, formulaKcalOz: null, formulaName: null, bottleLabel: null, sourceCaregiverName: null, diaperType: null, sleepType: null, notes: '', approved: false, rejected: false,
    source: { page, line: 1, slot: 0, rawText: '', engine: 'manual', confidence: null },
    fieldSources: {}, warnings: ['Manually transcribed from the source; verify every field.'],
  };
}

export function editOcrRow(row: OcrCandidate, patch: Partial<OcrCandidate>): OcrCandidate {
  const fieldSources = { ...row.fieldSources };
  for (const key of Object.keys(patch)) {
    if (key !== 'approved' && key !== 'rejected') fieldSources[key as OcrEditableField] = 'corrected';
  }
  return { ...row, ...patch, approved: false, rejected: false, fieldSources };
}

export function isValidTimezone(tz: string): boolean {
  if (!tz || typeof tz !== 'string' || !tz.trim() || tz.length > 128) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

export function mergeOcrRows(target: OcrCandidate, source: OcrCandidate): OcrCandidate {
  const fieldSources: OcrCandidate['fieldSources'] = { ...target.fieldSources };
  const merged: Partial<{ -readonly [K in keyof OcrCandidate]: OcrCandidate[K] }> = {};
  if (target.eventType === 'unknown' && source.eventType !== 'unknown') {
    merged.eventType = source.eventType;
    fieldSources.eventType = 'corrected';
  }
  for (const field of ['localDate', 'localTime', 'endLocalDate', 'endLocalTime', 'feedType', 'bottleType', 'diaperType', 'sleepType', 'feedDuration', 'formulaKcalOz', 'formulaName', 'bottleLabel', 'sourceCaregiverName'] as const) {
    if (target[field] == null && source[field] != null) {
      (merged as Record<string, unknown>)[field] = source[field];
      fieldSources[field] = 'corrected';
    }
  }
  // Both bottle quantities share one unit. Never reinterpret a copied number in
  // the target's unit or borrow a unit for a target quantity whose unit is unknown.
  let quantityUnit = target.unit;
  const targetHasQuantity = target.amount != null || target.offeredAmount != null;
  let unresolvedQuantity = false;
  if (!quantityUnit && !targetHasQuantity && source.unit) {
    quantityUnit = source.unit;
    merged.unit = source.unit;
    fieldSources.unit = 'corrected';
  }
  for (const field of ['amount', 'offeredAmount'] as const) {
    const sourceAmount = source[field];
    if (target[field] == null && sourceAmount != null) {
      if (source.unit && quantityUnit) {
        const sourceMl = sourceAmount * (source.unit === 'OZ' ? 29.5735295625 : 1);
        merged[field] = Math.round(sourceMl / (quantityUnit === 'OZ' ? 29.5735295625 : 1) * 1_000_000) / 1_000_000;
        fieldSources[field] = 'corrected';
      } else {
        fieldSources[field] = 'ambiguous';
        unresolvedQuantity = true;
      }
    }
  }
  if (!quantityUnit && targetHasQuantity) {
    fieldSources.unit = 'ambiguous';
    unresolvedQuantity = true;
  }
  const mergedNotes = [target.notes, source.notes].filter(Boolean).join(' · ').slice(0, 2000);
  if (mergedNotes !== target.notes) {
    merged.notes = mergedNotes;
    fieldSources.notes = 'corrected';
  }
  const mergeWarning = `Merged with draft row from page ${source.source.page}, line ${source.source.line}.`;
  return {
    ...target,
    ...merged,
    approved: false,
    rejected: false,
    fieldSources,
    warnings: [...new Set([...target.warnings, ...source.warnings, mergeWarning,
      ...(unresolvedQuantity ? ['Multiple quantities appear in this event; choose the recorded amount or split the event.'] : []),
    ])],
  };
}

export interface ReviewTotals {
  totalRows: number;
  approvedCount: number;
  rejectedCount: number;
  excludedCount: number;
  feeds: {
    totalCount: number;
    approvedCount: number;
    totalMl: number;
    totalOz: number;
    breastCount: number;
    bottleCount: number;
  };
  diapers: {
    totalCount: number;
    approvedCount: number;
    wet: number;
    dirty: number;
    both: number;
    dry: number;
  };
  sleep: {
    totalCount: number;
    approvedCount: number;
    totalMinutes: number;
    napCount: number;
    nightSleepCount: number;
  };
}

export function calculateReviewTotals(rows: OcrCandidate[]): ReviewTotals {
  const totals: ReviewTotals = {
    totalRows: rows.length,
    approvedCount: 0,
    rejectedCount: 0,
    excludedCount: 0,
    feeds: { totalCount: 0, approvedCount: 0, totalMl: 0, totalOz: 0, breastCount: 0, bottleCount: 0 },
    diapers: { totalCount: 0, approvedCount: 0, wet: 0, dirty: 0, both: 0, dry: 0 },
    sleep: { totalCount: 0, approvedCount: 0, totalMinutes: 0, napCount: 0, nightSleepCount: 0 },
  };

  for (const row of rows) {
    if (row.rejected) {
      totals.rejectedCount++;
    } else if (row.approved) {
      totals.approvedCount++;
    } else {
      totals.excludedCount++;
    }

    if (row.eventType === 'feed') {
      totals.feeds.totalCount++;
      if (row.approved) {
        totals.feeds.approvedCount++;
        if (row.feedType === 'BREAST') totals.feeds.breastCount++;
        if (row.feedType === 'BOTTLE') totals.feeds.bottleCount++;
        if (typeof row.amount === 'number' && Number.isFinite(row.amount) && row.amount > 0 && row.unit) {
          const ml = normalizeAmountMl(row.amount, row.unit);
          totals.feeds.totalMl += ml;
        }
      }
    } else if (row.eventType === 'diaper') {
      totals.diapers.totalCount++;
      if (row.approved) {
        totals.diapers.approvedCount++;
        if (row.diaperType === 'WET') totals.diapers.wet++;
        else if (row.diaperType === 'DIRTY') totals.diapers.dirty++;
        else if (row.diaperType === 'BOTH') totals.diapers.both++;
        else if (row.diaperType === 'DRY') totals.diapers.dry++;
      }
    } else if (row.eventType === 'sleep') {
      totals.sleep.totalCount++;
      if (row.approved) {
        totals.sleep.approvedCount++;
        if (row.sleepType === 'NAP') totals.sleep.napCount++;
        else if (row.sleepType === 'NIGHT_SLEEP') totals.sleep.nightSleepCount++;
        if (row.localDate && row.localTime && row.endLocalDate && row.endLocalTime) {
          const startMs = Date.parse(`${row.localDate}T${row.localTime}:00Z`);
          const endMs = Date.parse(`${row.endLocalDate}T${row.endLocalTime}:00Z`);
          if (endMs > startMs) {
            totals.sleep.totalMinutes += Math.round((endMs - startMs) / 60000);
          }
        }
      }
    }
  }

  totals.feeds.totalMl = Math.round(totals.feeds.totalMl * 10) / 10;
  totals.feeds.totalOz = Math.round((totals.feeds.totalMl / 29.5735) * 10) / 10;
  return totals;
}

export function rowReviewIssues(row: OcrCandidate, timeZone: string, offsets: RowOffsets = {}) {
  if (row.rejected) {
    return { errors: [], warnings: [...row.warnings, 'Marked as rejected — will be excluded from import.'] };
  }
  if (!isValidTimezone(timeZone)) {
    return { errors: ['Choose a valid time zone.'], warnings: [...row.warnings] };
  }
  const validation = validateOcrCandidate(row, { now: new Date(), deferSleepOrdering: true });
  const errors = [...validation.errors];
  const start = row.localDate && row.localTime
    ? resolveOcrLocalDateTime(row.localDate, row.localTime, timeZone, { utcOffsetMinutes: offsets.start }) : null;
  const end = row.eventType === 'sleep' && row.endLocalDate && row.endLocalTime
    ? resolveOcrLocalDateTime(row.endLocalDate, row.endLocalTime, timeZone, { utcOffsetMinutes: offsets.end }) : null;
  for (const resolution of [start, end]) if (resolution && resolution.status !== 'valid' && resolution.message) errors.push(resolution.message);
  if (start?.utc && end?.utc && end.utc <= start.utc) errors.push('Sleep end must be after its start.');
  return { errors: [...new Set(errors)], warnings: [...validation.warnings] };
}
