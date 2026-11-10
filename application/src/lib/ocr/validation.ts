import {
  OCR_MAX_NOTES, OCR_MAX_SOURCE_LINE, OcrCandidate, OcrCrop, OcrEditableField,
  OcrFieldOrigin, OcrTimeResolution, OcrValidationResult,
} from './types';
import { OCR_MAX_FEED_DURATION_SECONDS } from './duration';

const editableFields: readonly OcrEditableField[] = [
  'eventType', 'localDate', 'localTime', 'endLocalDate', 'endLocalTime',
  'feedType', 'bottleType', 'amount', 'unit', 'diaperType', 'sleepType', 'notes',
  'feedDuration', 'offeredAmount', 'formulaKcalOz', 'formulaName', 'bottleLabel', 'sourceCaregiverName',
];
const origins: readonly OcrFieldOrigin[] = ['source', 'context', 'missing', 'ambiguous', 'corrected'];

export function isOcrDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isOcrTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function normalizeAmountMl(amount: number, unit: 'ML' | 'OZ'): number {
  if (!Number.isFinite(amount) || amount < 0 || (unit !== 'ML' && unit !== 'OZ')) {
    throw new Error('A finite non-negative amount and a supported volume unit are required.');
  }
  return Math.round(amount * (unit === 'OZ' ? 29.5735295625 : 1) * 1000) / 1000;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Validate untrusted review JSON. Authorization and immutable source matching are server responsibilities. */
export function validateOcrCandidate(
  input: unknown,
  options: {
    readonly requireApproval?: boolean;
    readonly allowIncomplete?: boolean;
    /** Caller must compare resolved UTC instants, including an explicit DST occurrence. */
    readonly deferSleepOrdering?: boolean;
    readonly now?: Date;
  } = {},
): OcrValidationResult {
  const value = object(input);
  if (!value) return { valid: false, errors: ['A draft event is required.'], warnings: [] };
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = (field: string, max: number, nullable = false): string | null => {
    const entry = value[field];
    if (entry === null && nullable) return null;
    if (typeof entry !== 'string' || entry.length > max) {
      errors.push(`Invalid ${field}.`); return null;
    }
    return entry;
  };
  const choice = <T extends string>(field: string, allowed: readonly T[], nullable = true): T | null => {
    const entry = value[field];
    if (entry === null && nullable) return null;
    if (typeof entry !== 'string' || !allowed.includes(entry as T)) {
      errors.push(`Invalid ${field}.`); return null;
    }
    return entry as T;
  };

  const id = text('id', 128);
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) errors.push('A valid source row ID is required.');
  const eventType = choice('eventType', ['feed', 'diaper', 'sleep', 'unknown'] as const, false);
  const localDate = text('localDate', 10, true);
  const localTime = text('localTime', 5, true);
  const endLocalDate = text('endLocalDate', 10, true);
  const endLocalTime = text('endLocalTime', 5, true);
  const feedType = choice('feedType', ['BREAST', 'BOTTLE'] as const);
  const bottleType = choice('bottleType', ['Formula', 'Breast Milk', 'Other'] as const);
  const unit = choice('unit', ['ML', 'OZ'] as const);
  const diaperType = choice('diaperType', ['WET', 'DIRTY', 'BOTH', 'DRY'] as const);
  const sleepType = choice('sleepType', ['NAP', 'NIGHT_SLEEP'] as const);
  const notes = text('notes', OCR_MAX_NOTES);
  const optionalText = (field: string, max: number): string | null | undefined => {
    if (value[field] === undefined) return undefined;
    if (value[field] === null || value[field] === '') return null;
    if (typeof value[field] !== 'string' || (value[field] as string).length > max
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value[field] as string)) {
      errors.push('Invalid optional bottle metadata.'); return null;
    }
    return (value[field] as string).trim() || null;
  };
  const optionalNumber = (field: string, max: number, positive = false): number | null | undefined => {
    if (value[field] === undefined) return undefined;
    if (value[field] === null) return null;
    if (typeof value[field] !== 'number' || !Number.isFinite(value[field])
      || Number(value[field]) < 0 || Number(value[field]) > max || (positive && value[field] === 0)) {
      errors.push('Invalid optional bottle quantity or concentration.'); return null;
    }
    return value[field] as number;
  };
  const feedDuration = value.feedDuration;
  if (feedDuration !== undefined && feedDuration !== null
    && (typeof feedDuration !== 'number' || !Number.isInteger(feedDuration)
      || feedDuration < 1 || feedDuration > OCR_MAX_FEED_DURATION_SECONDS)) {
    errors.push('Feeding duration must be a whole number of seconds between 1 and 86400, or left blank.');
  }
  if (eventType === 'feed' && typeof feedDuration === 'number' && feedDuration > 2 * 60 * 60) {
    warnings.push('Feeding duration exceeds two hours; compare it with the source before approving.');
  }
  const offeredAmount = optionalNumber('offeredAmount', 100000);
  const formulaKcalOz = optionalNumber('formulaKcalOz', 60, true);
  const formulaName = optionalText('formulaName', 120);
  const bottleLabel = optionalText('bottleLabel', 80);
  const sourceCaregiverName = optionalText('sourceCaregiverName', 120);
  const rejected = typeof value.rejected === 'boolean' ? value.rejected : false;
  if (rejected && value.approved === true) errors.push('A rejected event cannot also be approved.');
  const amount = value.amount;
  if (amount !== null && (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 100000)) {
    errors.push('Amount must be a finite positive number.');
  }
  if (typeof value.approved !== 'boolean') errors.push('Approval must be explicit.');
  if (options.requireApproval && value.approved !== true) errors.push('Approve this event before importing.');
  if ((!eventType || eventType === 'unknown') && !options.allowIncomplete) errors.push('Choose an event type.');
  if (!isOcrDate(localDate) && (!options.allowIncomplete || localDate !== null)) errors.push('Enter a complete, valid date.');
  if (!isOcrTime(localTime) && (!options.allowIncomplete || localTime !== null)) errors.push('Enter an unambiguous time in 24-hour form.');
  if (endLocalDate !== null && !isOcrDate(endLocalDate)) errors.push('Enter a valid end date.');
  if (endLocalTime !== null && !isOcrTime(endLocalTime)) errors.push('Enter a valid end time.');
  if (eventType === 'feed') {
    if (offeredAmount != null && unit === null && !options.allowIncomplete) errors.push('Offered volume requires the same explicit unit as consumed volume.');
    if (offeredAmount != null && typeof amount === 'number' && amount > offeredAmount + 0.000001) errors.push('Consumed volume cannot exceed offered volume.');
    if (!feedType && !options.allowIncomplete) errors.push('Choose a feeding method.');
    if (feedType === 'BOTTLE' && (amount === null || unit === null) && !options.allowIncomplete) errors.push('Bottle feeds require an amount and unit.');
    if ((amount === null) !== (unit === null) && !options.allowIncomplete) errors.push('Amount and unit must be supplied together.');
    if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0 && unit) {
      const ml = normalizeAmountMl(amount, unit);
      if (ml > 500 || ml < 1) warnings.push('Unusual feeding quantity; compare it with the source before approving.');
    }
  }
  if (eventType === 'diaper' && !diaperType && !options.allowIncomplete) errors.push('Choose a diaper type.');
  if (eventType === 'sleep') {
    if (!sleepType && !options.allowIncomplete) errors.push('Choose a sleep type.');
    if ((!isOcrDate(endLocalDate) || !isOcrTime(endLocalTime)) && !options.allowIncomplete) errors.push('Sleep imports require a complete end date and time.');
    if (isOcrDate(localDate) && isOcrTime(localTime) && isOcrDate(endLocalDate) && isOcrTime(endLocalTime)) {
      const duration = Date.parse(`${endLocalDate}T${endLocalTime}:00Z`) - Date.parse(`${localDate}T${localTime}:00Z`);
      if (duration <= 0 && !options.deferSleepOrdering) errors.push('Sleep end must be after its start.');
      if (duration > 24 * 60 * 60 * 1000) warnings.push('Sleep spans more than 24 hours; verify both dates.');
    }
  }
  const now = options.now;
  if (now && isOcrDate(localDate) && localDate > new Date(now.getTime() + 86400000).toISOString().slice(0, 10)) {
    warnings.push('The event date is in the future; compare it with the source.');
  }

  const source = object(value.source);
  const rotationValid = source?.rotation === undefined || [0, 90, 180, 270].includes(source.rotation as number);
  const cropObj = source?.crop ? object(source.crop) : null;
  const cropValid = source?.crop === undefined || (
    cropObj !== null
    && Number.isFinite(cropObj.left) && Number(cropObj.left) >= 0
    && Number.isFinite(cropObj.top) && Number(cropObj.top) >= 0
    && Number.isFinite(cropObj.width) && Number(cropObj.width) > 0
    && Number.isFinite(cropObj.height) && Number(cropObj.height) > 0
    && (cropObj.unit === undefined || ['pixel', 'percent'].includes(String(cropObj.unit)))
  );
  const sourceValid = source && ['page', 'line', 'slot'].every(key =>
    typeof source[key] === 'number' && Number.isInteger(source[key]) && Number(source[key]) >= (key === 'slot' ? 0 : 1) && Number(source[key]) <= 100000,
  ) && typeof source.rawText === 'string' && source.rawText.length <= OCR_MAX_SOURCE_LINE
    && typeof source.engine === 'string' && source.engine.length > 0 && source.engine.length <= 200
    && (source.confidence === null || (typeof source.confidence === 'number' && Number.isFinite(source.confidence) && source.confidence >= 0 && source.confidence <= 100))
    && (source.contextDate === undefined || isOcrDate(source.contextDate))
    && (source.contextDateOrigin === undefined || ['user', 'page-header'].includes(String(source.contextDateOrigin)))
    && rotationValid && cropValid;
  if (!sourceValid) errors.push('Invalid source reference.');
  const evidence = object(value.fieldSources);
  const fieldSources: Partial<Record<OcrEditableField, OcrFieldOrigin>> = {};
  if (!evidence) errors.push('Field provenance is required.');
  else for (const [key, origin] of Object.entries(evidence)) {
    if (!editableFields.includes(key as OcrEditableField) || !origins.includes(origin as OcrFieldOrigin)) errors.push('Invalid field provenance.');
    else fieldSources[key as OcrEditableField] = origin as OcrFieldOrigin;
  }
  if (!Array.isArray(value.warnings) || value.warnings.length > 30 || value.warnings.some(w => typeof w !== 'string' || w.length > 300)) {
    errors.push('Invalid uncertainty indicators.');
  }
  if (errors.length || !sourceValid || !id || !eventType || notes === null) {
    return { valid: false, errors: [...new Set(errors)], warnings };
  }
  const candidate: OcrCandidate = {
    id, eventType, localDate, localTime, endLocalDate, endLocalTime,
    feedType, bottleType, unit, diaperType, sleepType, amount: amount as number | null,
    notes,
    ...(feedDuration !== undefined ? { feedDuration: feedDuration as number | null } : {}),
    ...(offeredAmount !== undefined ? { offeredAmount } : {}),
    ...(formulaKcalOz !== undefined ? { formulaKcalOz } : {}),
    ...(formulaName !== undefined ? { formulaName } : {}),
    ...(bottleLabel !== undefined ? { bottleLabel } : {}),
    ...(sourceCaregiverName !== undefined ? { sourceCaregiverName } : {}),
    approved: value.approved as boolean, rejected, source: {
      page: source.page as number, line: source.line as number, slot: source.slot as number,
      rawText: source.rawText as string, engine: source.engine as string, confidence: source.confidence as number | null,
      ...(source.contextDate ? { contextDate: source.contextDate as string } : {}),
      ...(source.contextDateOrigin ? { contextDateOrigin: source.contextDateOrigin as 'user' | 'page-header' } : {}),
      ...(typeof source.rotation === 'number' ? { rotation: source.rotation as number } : {}),
      ...(cropObj ? { crop: {
        left: Number(cropObj.left), top: Number(cropObj.top), width: Number(cropObj.width), height: Number(cropObj.height),
        ...(cropObj.unit ? { unit: cropObj.unit as 'pixel' | 'percent' } : {}),
      } } : {}),
    },
    fieldSources, warnings: value.warnings as string[],
  };
  return { valid: true, errors: [], warnings, candidate };
}

/** Resolve a wall clock by round-tripping possible offsets; never guess during DST folds/gaps. */
export function resolveOcrLocalDateTime(
  date: string,
  time: string,
  timeZone: string,
  options: { readonly utcOffsetMinutes?: number } = {},
): OcrTimeResolution {
  const invalid = (message: string): OcrTimeResolution => ({ status: 'invalid', utc: null, candidates: [], message });
  if (!isOcrDate(date) || !isOcrTime(time)) return invalid('A valid local date and time are required.');
  if (typeof timeZone !== 'string' || !timeZone.trim() || timeZone.length > 128) return invalid('Choose a valid time zone.');
  if (options.utcOffsetMinutes !== undefined && (!Number.isInteger(options.utcOffsetMinutes) || Math.abs(options.utcOffsetMinutes) > 840)) {
    return invalid('Choose a valid UTC offset for this occurrence.');
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
  } catch { return invalid('Choose a valid time zone.'); }
  const parts = (stamp: number): string => {
    const fields = Object.fromEntries(formatter.formatToParts(new Date(stamp)).map(part => [part.type, part.value]));
    return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}:${fields.second}`;
  };
  const expected = `${date}T${time}:00`;
  const naive = Date.parse(`${expected}Z`);
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const stamp = naive + hours * 3600000;
    offsets.add(Date.parse(`${parts(stamp)}Z`) - stamp);
  }
  const all = [...offsets].map(offset => naive - offset)
    .filter(stamp => parts(stamp) === expected).sort((a, b) => a - b);
  const candidates = [...new Set(all)].map(stamp => new Date(stamp).toISOString());
  if (candidates.length === 0) return { status: 'nonexistent', utc: null, candidates, message: 'This local time does not exist because the clock changed. Correct it before importing.' };
  if (options.utcOffsetMinutes !== undefined) {
    const selected = candidates.find(value => (naive - Date.parse(value)) / 60000 === options.utcOffsetMinutes);
    return selected ? { status: 'valid', utc: selected, candidates }
      : invalid('That UTC offset does not match this time zone and date.');
  }
  if (candidates.length > 1) return { status: 'ambiguous', utc: null, candidates, message: 'The clock repeats this local time. Select the intended occurrence before importing.' };
  return { status: 'valid', utc: candidates[0], candidates };
}
