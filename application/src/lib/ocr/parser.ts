import {
  OCR_MAX_CANDIDATES, OCR_MAX_NOTES, OCR_MAX_SOURCE_LINE, OCR_PARSER_VERSION,
  OcrCandidate, OcrEditableField, OcrEventType, OcrFieldOrigin, OcrPageText, OcrParseOptions,
} from './types';
import { isOcrDate } from './validation';
import { maskFeedDuration, parseFeedDuration } from './duration';

interface Clock { readonly value: string | null; readonly raw: string; readonly index: number; }
interface DateMatch { readonly value: string | null; readonly raw: string; }

const feedPattern = /\b(?:feed(?:ing)?|fed|bottle|btl|formula|breast\s*milk|breastfed|breastfeed(?:ing)?|nurs(?:e|ed|ing))\b/i;
const diaperPattern = /\b(?:diaper|nappy|wet|dirty|dry|stool|poop(?:ed)?|urine|pee(?:d)?|bowel\s*movement|bm|soiled)\b/i;
const sleepPattern = /\b(?:sleep|slept|asleep|nap(?:ped)?|bedtime|awake|woke)\b/i;
const volumePattern = /(?<![\w.,/+-])([+-]?(?:\d+\s+\d+\s*\/\s*\d+|\d+\s*[¼½¾]|\d+\s*\/\s*\d+|\d+(?:[.,]\d+)?|[¼½¾]))\s*(m[lL](?:s)?|millilit(?:er|re)s?|cc(?:s)?|c\.c\.?|(?:fl\.?\s*)?oz|ounces?)\b/gi;
const volumeRangePattern = /(?<![\w.,/+-])((?:\d+(?:[.,]\d+)?|[¼½¾]|\d+\s*\/\s*\d+))\s*(?:-|–|—|\bto\b)\s*((?:\d+(?:[.,]\d+)?|[¼½¾]|\d+\s*\/\s*\d+))\s*(m[lL](?:s)?|millilit(?:er|re)s?|cc(?:s)?|c\.c\.?|(?:fl\.?\s*)?oz|ounces?)\b/gi;
// Only canonical ISO dates are resolved, but every full numeric date-like span must
// reset an inherited date and be excluded from clock parsing. A two-part dotted
// token remains a possible clock (14.15), not a guessed day/month heading.
const dateLikePattern = /\b(?:\d{4}[/.-]\d{1,2}[/.-]\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}[/-]\d{1,2})\b/g;
const volumeRoleLabels = 'offered|prepared|consumed|taken|drank|drunk|remaining|leftover|left|unconsumed|unused|discarded|wasted|spilled|refused|residual';
const volumeRoleLabelPattern = new RegExp('\\b(?:' + volumeRoleLabels + ')\\b', 'i');

function maskNamedMetadata(text: string): string {
  return text.replace(/(?:^|[;|\t])\s*(?:formula(?:\s+name)?|brand|bottle\s+(?:id|label)|caregiver|fed\s+by|concentration)\s*:\s*[^;|\t\n]*/gi,
    match => ' '.repeat(match.length));
}

function datesIn(text: string): DateMatch[] {
  text = maskFeedDuration(maskNamedMetadata(text));
  const dates: DateMatch[] = [];
  const volumeSpans = [...text.matchAll(volumePattern)].map(match => [match.index ?? 0, (match.index ?? 0) + match[0].length]);
  for (const match of text.matchAll(dateLikePattern)) {
    if (volumeSpans.some(([start, end]) => (match.index ?? 0) >= start && (match.index ?? 0) < end)) continue;
    const raw = match[0];
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) dates.push({ value: isOcrDate(raw) ? raw : null, raw });
    // Unsupported separators/orderings remain visible and require an explicit date.
    else dates.push({ value: null, raw });
  }
  return dates;
}

function clocksIn(text: string, mode: OcrParseOptions['timeFormat']): Clock[] {
  text = maskFeedDuration(maskNamedMetadata(text));
  const clocks: Clock[] = [];
  // A year inside a date or digits in a volume are not military clock times.
  const excluded = [
    ...text.matchAll(dateLikePattern),
    ...text.matchAll(volumePattern),
  ].map(match => [match.index ?? 0, (match.index ?? 0) + match[0].length]);
  const isExcluded = (index: number) => excluded.some(([start, end]) => index >= start && index < end);
  const pattern = /\b(?:(\d{1,2})[:.](\d{2})\s*([ap]\.?m\.?)?|(\d{1,2})\s*([ap]\.?m\.?)|noon|midnight)(?![\w:])/gi;
  for (const match of text.matchAll(pattern)) {
    if (isExcluded(match.index ?? 0)) continue;
    const raw = match[0].trim();
    let value: string | null = null;
    if (/^noon$/i.test(raw)) value = '12:00';
    else if (/^midnight$/i.test(raw)) value = '00:00';
    else {
      const hour = Number(match[1] ?? match[4]);
      const minute = Number(match[2] ?? 0);
      const meridiem = match[3] ?? match[5];
      if (minute < 60 && meridiem && hour >= 1 && hour <= 12) {
        const normalizedHour = hour % 12 + (/^p/i.test(meridiem) ? 12 : 0);
        value = `${String(normalizedHour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      } else if (minute < 60 && !meridiem && hour <= 23 && mode !== '12h' && (hour === 0 || hour > 12 || mode === '24h')) {
        value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      }
    }
    if (/^\s*\?/.test(text.slice((match.index ?? 0) + match[0].length))) value = null;
    clocks.push({ raw, value, index: match.index ?? 0 });
  }
  if (mode === '24h') {
    const militaryPattern = /(?<![\d:])\b([01]\d|2[0-3])([0-5]\d)\b(?![\d:])/g;
    for (const match of text.matchAll(militaryPattern)) {
      if (isExcluded(match.index ?? 0)) continue;
      const raw = match[0];
      if (!clocks.some(c => (match.index ?? 0) >= c.index && (match.index ?? 0) < c.index + c.raw.length)) {
        clocks.push({ raw, value: `${match[1]}:${match[2]}`, index: match.index ?? 0 });
      }
    }
  }
  return clocks.sort((a, b) => a.index - b.index);
}

function parseAmount(raw: string): number | null {
  if (raw.includes(',')) return null;
  if (/[-–—]|\bto\b/i.test(raw)) return null;
  const normalized = raw.replace(/([¼½¾])/g, char => ` ${ ({ '¼': '1/4', '½': '1/2', '¾': '3/4' })[char] }`).trim();
  const mixed = normalized.match(/^([+]?\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  const fraction = normalized.match(/^([+]?\d+)\s*\/\s*(\d+)$/);
  let amount: number;
  if (mixed) amount = Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  else if (fraction) amount = Number(fraction[1]) / Number(fraction[2]);
  else amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function volumesIn(text: string): { amount: number | null; unit: 'ML' | 'OZ'; raw: string; index: number }[] {
  text = maskNamedMetadata(text);
  const ranges = [...text.matchAll(volumeRangePattern)].map(match => ({
    amount: null,
    unit: /^(?:ml|milli|cc|c\.c)/i.test(match[3]) ? ('ML' as const) : ('OZ' as const),
    raw: match[0],
    index: match.index ?? 0,
  }));
  const singles = [...text.matchAll(volumePattern)]
    .filter(match => !ranges.some(r => (match.index ?? 0) >= r.index && (match.index ?? 0) < r.index + r.raw.length))
    .map(match => ({
      amount: /^\s*\?/.test(text.slice((match.index ?? 0) + match[0].length)) ? null : parseAmount(match[1]),
      unit: /^(?:ml|milli|cc|c\.c)/i.test(match[2]) ? ('ML' as const) : ('OZ' as const),
      raw: match[0],
      index: match.index ?? 0,
    }));
  return [...ranges, ...singles].sort((a, b) => a.index - b.index);
}


function volumeRole(text: string, volume: { index: number; raw: string }): 'offered' | 'consumed' | 'residual' | 'ambiguous' | null {
  const before = text.slice(0, volume.index);
  const after = text.slice(volume.index + volume.raw.length);
  const prefix = before.match(new RegExp('\\b(?:((?:not|no|without)\\s+))?(' + volumeRoleLabels + ')\\s*[:=]?\\s*$', 'i'));
  const suffix = after.match(new RegExp('^\\s*(' + volumeRoleLabels + ')(?=\\s*(?:[,;|]|$))', 'i'));
  const role = (label: string) => /^(?:offered|prepared)$/i.test(label) ? 'offered'
    : /^(?:consumed|taken|drank|drunk)$/i.test(label) ? 'consumed' : 'residual';
  const prefixRole = prefix ? role(prefix[2]) : null;
  const suffixRole = suffix ? role(suffix[1]) : null;
  if (prefix?.[1] || (prefixRole && suffixRole && prefixRole !== suffixRole)) return 'ambiguous';
  return prefixRole ?? suffixRole;
}

/** Only isolated, explicitly labelled cells are names; surrounding prose is never guessed. */
function labelledText(text: string, labels: string, max: number): { value: string | null; ambiguous: boolean } {
  const matches = [...text.matchAll(new RegExp('(?:^|[;|\\t])\\s*(?:' + labels + ')\\s*:\\s*([^;|\\t\\n]*)', 'gi'))];
  if (matches.length !== 1) return { value: null, ambiguous: matches.length > 1 };
  const value = matches[0][1].trim();
  const ambiguous = !value || value.length > max || /\?|~~|\b(?:illegible|unclear|crossed\s*out)\b/i.test(value);
  return { value: ambiguous ? null : value, ambiguous };
}

function typesIn(text: string): OcrEventType[] {
  const result: OcrEventType[] = [];
  if (feedPattern.test(text) || volumesIn(text).length) result.push('feed');
  if (diaperPattern.test(text)) result.push('diaper');
  if (sleepPattern.test(text)) result.push('sleep');
  return result;
}

function segmentsIn(text: string): string[] {
  const initial = text.split(/[;|\t]+/);
  const segments: string[] = [];
  for (const fragment of initial) {
    const trimmed = fragment.trim();
    if (!trimmed) continue;
    // Labelled bottle cells belong to the preceding feeding, not separate events.
    if (segments.length && typesIn(segments[segments.length - 1]).includes('feed')
      && /^(?:(?:(?:feeding|feed|nursing|bottle)\s+)?duration|offered|prepared|consumed|taken|drank|drunk|formula(?:\s+name)?|brand|bottle\s+(?:id|label)|caregiver|fed\s+by|concentration)\s*[:=]/i.test(trimmed)) {
      segments[segments.length - 1] += `; ${trimmed}`;
      continue;
    }
    if (typesIn(trimmed).length > 1 && /[,/]/.test(trimmed)) {
      const parts = trimmed.split(/[,/]+/);
      let temp = '';
      for (const part of parts) {
        if (typesIn(part).length > 0 && temp && typesIn(temp).length > 0) {
          segments.push(temp.trim());
          temp = part;
        } else {
          temp = temp ? `${temp}, ${part}` : part;
        }
      }
      if (temp.trim()) segments.push(temp.trim());
    } else {
      if (segments.length && typesIn(trimmed).length === 0) {
        segments[segments.length - 1] += `; ${trimmed}`;
      } else {
        segments.push(trimmed);
      }
    }
  }
  return segments.length ? segments : [text];
}

function makeCandidate(
  page: OcrPageText, lineNumber: number, rawText: string, segment: string,
  eventType: OcrEventType, slot: number, contextDate: string | null,
  contextDateOrigin: 'user' | 'page-header', mode: OcrParseOptions['timeFormat'],
): OcrCandidate {
  const warnings: string[] = ['Verify every field against the source before approving.'];
  const fieldSources: Partial<Record<OcrEditableField, OcrFieldOrigin>> = {};
  const mark = (field: OcrEditableField, present: boolean, origin: OcrFieldOrigin = 'source') => {
    fieldSources[field] = present ? origin : 'missing';
  };
  const dateMatches = datesIn(segment);
  const ownDate = dateMatches[0];
  let localDate = ownDate ? ownDate.value : contextDate;
  mark('localDate', localDate !== null, ownDate ? 'source' : 'context');
  if (ownDate && ownDate.value === null) {
    fieldSources.localDate = 'ambiguous';
    warnings.push('The source date is incomplete or ambiguous; enter an explicit date.');
  }
  const ownClocks = clocksIn(segment, mode);
  const lineClocks = clocksIn(rawText, mode);
  let inheritedClock: Clock | undefined;
  if (ownClocks.length === 0) {
    if (lineClocks.length === 1) {
      inheritedClock = lineClocks[0];
    } else if (lineClocks.length > 1) {
      const firstCol = rawText.split(/[|;\t]+/)[0];
      const leadingClocks = clocksIn(firstCol, mode);
      if (leadingClocks.length === 1 && leadingClocks[0].value !== null) {
        inheritedClock = leadingClocks[0];
      }
    }
  }
  const clocks = ownClocks.length ? ownClocks : inheritedClock ? [inheritedClock] : [];
  let localTime = clocks[0]?.value ?? null;
  mark('localTime', localTime !== null, inheritedClock ? 'context' : 'source');
  if (clocks.some(clock => clock.value === null)) {
    fieldSources.localTime = 'ambiguous';
    warnings.push('The time is ambiguous or invalid. Confirm AM/PM or choose a 24-hour sheet.');
  }
  if (eventType !== 'sleep' && clocks.length > 1) {
    localTime = null; fieldSources.localTime = 'ambiguous';
    warnings.push('Multiple times appear in this event; split or correct it.');
  }
  let endLocalDate: string | null = null;
  let endLocalTime: string | null = null;
  let feedType: OcrCandidate['feedType'] = null;
  let bottleType: OcrCandidate['bottleType'] = null;
  let diaperType: OcrCandidate['diaperType'] = null;
  let sleepType: OcrCandidate['sleepType'] = null;
  let amount: number | null = null;
  let unit: OcrCandidate['unit'] = null;
  let feedDuration: number | null = null;
  let offeredAmount: number | null = null;
  let formulaKcalOz: number | null = null;
  let formulaName: string | null = null;
  let bottleLabel: string | null = null;
  let sourceCaregiverName: string | null = null;

  if (eventType === 'feed') {
    const bottle = /\b(?:bottle|btl)\b/i.test(segment);
    const breast = /\b(?:breast\s*feed(?:ing)?|breastfed|nurs(?:e|ed|ing))\b/i.test(segment);
    feedType = bottle !== breast ? bottle ? 'BOTTLE' : 'BREAST' : null;
    const formula = /\bformula\b/i.test(segment);
    const milk = /\b(?:breast\s*milk|ebm|expressed\s+milk)\b/i.test(segment);
    bottleType = formula !== milk ? formula ? 'Formula' : 'Breast Milk' : null;
    if (formula && milk) warnings.push('Mixed formula and breast milk need a reviewer-selected designation and notes.');
    const quantityText = maskNamedMetadata(segment);
    const duration = parseFeedDuration(quantityText);
    feedDuration = duration.value;
    fieldSources.feedDuration = duration.origin;
    if (duration.origin === 'ambiguous') warnings.push('Feeding duration is unclear; enter an explicit elapsed duration or leave it unrecorded.');
    const volumes = volumesIn(quantityText);
    const roles = volumes.map(volume => volumeRole(quantityText, volume));
    const offered = volumes.filter((_, index) => roles[index] === 'offered');
    const consumed = volumes.filter((_, index) => roles[index] === 'consumed');
    const hasVolumeLabels = volumeRoleLabelPattern.test(quantityText);
    if (roles.includes('ambiguous')) {
      fieldSources.amount = 'ambiguous'; fieldSources.offeredAmount = 'ambiguous'; fieldSources.unit = 'ambiguous';
      warnings.push('Multiple quantities appear in this event; choose the recorded amount or split the event.');
    } else if (hasVolumeLabels) {
      if (consumed.length === 1) ({ amount, unit } = consumed[0]);
      else {
        fieldSources.amount = consumed.length ? 'ambiguous' : 'missing';
        warnings.push('Confirm the consumed volume; offered or remaining volume is not consumption.');
      }
      if (offered.length === 1) {
        unit ??= offered[0].unit;
        if (offered[0].amount !== null) {
          const ml = offered[0].amount * (offered[0].unit === 'OZ' ? 29.5735295625 : 1);
          offeredAmount = Math.round(ml / (unit === 'OZ' ? 29.5735295625 : 1) * 1_000_000) / 1_000_000;
        } else fieldSources.offeredAmount = 'ambiguous';
      } else if (offered.length > 1) {
        fieldSources.offeredAmount = 'ambiguous';
        warnings.push('Multiple offered volumes need correction.');
      }
      if (consumed.length === 1 && amount === null) fieldSources.amount = 'ambiguous';
      if (roles.includes(null)) {
        warnings.push('An unlabelled quantity was not assigned to offered or consumed volume.');
      }
    } else if (volumes.length === 1) ({ amount, unit } = volumes[0]);
    else if (volumes.length > 1) {
      fieldSources.amount = 'ambiguous'; fieldSources.unit = 'ambiguous';
      warnings.push('Multiple quantities appear in this event; choose the recorded amount or split the event.');
    }
    if (volumes.length === 1 && amount === null && !hasVolumeLabels) {
      fieldSources.amount = 'ambiguous'; warnings.push('The quantity is ambiguous; compare the original and enter a number.');
    }
    const concentrations = [...segment.matchAll(/\b(\d+(?:\.\d+)?)\s*kcal\s*(?:\/|per)\s*(?:fl\.?\s*)?oz\b/gi)];
    if (concentrations.length === 1) {
      const match = concentrations[0];
      const value = Number(match[1]);
      if (value > 0 && value <= 60
        && !/[-–—,]\s*$|\bto\s*$/i.test(segment.slice(0, match.index ?? 0))
        && !/^\s*\?/.test(segment.slice((match.index ?? 0) + match[0].length))) formulaKcalOz = value;
      else fieldSources.formulaKcalOz = 'ambiguous';
    } else if (concentrations.length > 1) fieldSources.formulaKcalOz = 'ambiguous';
    const formulaLabel = labelledText(segment, 'formula\\s+name|formula|brand', 120);
    const bottleId = labelledText(segment, 'bottle\\s+(?:id|label)', 80);
    const caregiver = labelledText(segment, 'caregiver|fed\\s+by', 120);
    formulaName = formulaLabel.value && !/^\d+(?:\.\d+)?\s*kcal\s*(?:\/|per)\s*oz$/i.test(formulaLabel.value) ? formulaLabel.value : null; bottleLabel = bottleId.value; sourceCaregiverName = caregiver.value;
    for (const [field, parsed] of [['formulaName', formulaLabel], ['bottleLabel', bottleId], ['sourceCaregiverName', caregiver]] as const) {
      if (parsed.ambiguous) fieldSources[field] = 'ambiguous';
    }
    if (!feedType) warnings.push('Feeding method is not explicit; select it during review.');
  }
  if (eventType === 'diaper') {
    const wet = /\b(?:wet|urine|pee(?:d)?)\b/i.test(segment);
    const dirty = /\b(?:dirty|stool|poop(?:ed)?|bowel\s*movement|bm|soiled)\b/i.test(segment) && !/\b(?:breast\s*milk|ebm)\b/i.test(segment);
    const dry = /\bdry\b/i.test(segment);
    diaperType = wet && dirty ? 'BOTH' : wet ? 'WET' : dirty ? 'DIRTY' : dry ? 'DRY' : null;
    if (dry && (wet || dirty)) { diaperType = null; warnings.push('Conflicting diaper descriptions require review.'); }
  }
  if (eventType === 'sleep') {
    sleepType = /\bnap(?:ped)?\b/i.test(segment) ? 'NAP' : /\b(?:night\s*sleep|overnight|bedtime)\b/i.test(segment) ? 'NIGHT_SLEEP' : null;
    if (clocks.length === 2) {
      endLocalTime = clocks[1].value;
      endLocalDate = dateMatches[1]?.value ?? (localTime && endLocalTime && endLocalTime > localTime ? localDate : null);
      if (!endLocalDate && endLocalTime) warnings.push('Confirm the sleep end date; crossing midnight is never assumed.');
    } else if (clocks.length > 2) {
      localTime = null;
      warnings.push('Several sleep times appear in this event; split or correct it.');
    } else if (/\b(?:awake|woke)\b/i.test(segment) && !/\b(?:sleep|slept|asleep|nap(?:ped)?|bedtime)\b/i.test(segment)) {
      endLocalTime = localTime; endLocalDate = localDate; localTime = null;
      warnings.push('Only a wake time was recognized; enter the sleep start before importing.');
    }
  }
  if (/\?|\b(?:crossed\s*out|illegible|unclear|void|error|mistake|scratched\s*out)\b|~~/i.test(segment)) {
    warnings.push('Uncertain or crossed-out text appears in this row. Correct it using the source.');
  }
  const conflictingText = /\b(?:no|not|without)\s+(?:wet|dirty|dry|stool|poop|urine|pee|bottle|formula|breast\s*milk|bm|soiled)\b|\b(?:wet|dirty|dry|bottle|formula|breast\s*milk|bm|soiled)\s*\?|~~|\b(?:void|error|mistake|crossed\s*out)\b/i.test(segment);
  if (conflictingText && eventType === 'diaper') {
    diaperType = null;
    warnings.push('Negated, uncertain or crossed-out diaper text needs an explicit type selection.');
  }
  if (conflictingText && eventType === 'feed') {
    feedType = null;
    amount = null; feedDuration = null; fieldSources.feedDuration = 'ambiguous'; offeredAmount = null; formulaKcalOz = null; formulaName = null; bottleLabel = null; sourceCaregiverName = null;
    warnings.push('Negated, uncertain or crossed-out feeding text needs explicit field corrections.');
  }
  if (page.confidence !== undefined && page.confidence !== null && page.confidence < 70) warnings.push('Low engine recognition score; manual transcription may be necessary.');
  if (eventType === 'unknown') warnings.push('No supported care event was identified; classify it or reject this row.');
  if (!localDate) warnings.push('A complete event date is required.');
  if (!localTime) warnings.push('An unambiguous event time is required.');
  mark('eventType', eventType !== 'unknown');
  mark('endLocalDate', endLocalDate !== null, dateMatches[1] ? 'source' : 'context');
  mark('endLocalTime', endLocalTime !== null);
  mark('feedType', feedType !== null); mark('bottleType', bottleType !== null);
  if (!fieldSources.amount) mark('amount', amount !== null);
  if (!fieldSources.unit) mark('unit', unit !== null);
  for (const [field, value] of Object.entries({ feedDuration, offeredAmount, formulaKcalOz, formulaName, bottleLabel, sourceCaregiverName })) {
    if (!fieldSources[field as OcrEditableField]) mark(field as OcrEditableField, value !== null);
  }
  mark('diaperType', diaperType !== null); mark('sleepType', sleepType !== null); mark('notes', true);
  return {
    id: `p${page.page}-l${lineNumber}-${eventType}-${slot}`, eventType, localDate, localTime,
    endLocalDate, endLocalTime, feedType, bottleType, amount, unit, diaperType, sleepType,
    feedDuration, offeredAmount, formulaKcalOz, formulaName, bottleLabel, sourceCaregiverName,
    notes: segment.trim().slice(0, OCR_MAX_NOTES), approved: false,
    source: {
      page: page.page, line: lineNumber, slot, rawText, engine: page.engine || OCR_PARSER_VERSION,
      confidence: page.confidence ?? null,
      ...(contextDate ? { contextDate, contextDateOrigin } : {}),
      ...(page.rotation !== undefined ? { rotation: page.rotation } : {}),
      ...(page.crop ? { crop: { ...page.crop } } : {}),
    }, fieldSources, warnings,
  };
}

/** Conservative English line parser. It preserves unknown rows and never writes or approves events. */
export function parseOcrPages(pages: readonly OcrPageText[], options: OcrParseOptions = {}): OcrCandidate[] {
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > 50) throw new Error('Supply between 1 and 50 OCR pages.');
  if (options.defaultDate !== undefined && !isOcrDate(options.defaultDate)) throw new Error('The supplied date must be a valid YYYY-MM-DD date.');
  if (options.timeFormat !== undefined && !['24h', '12h', 'unknown'].includes(options.timeFormat)) throw new Error('Invalid time format.');
  const pageIds = new Set<number>();
  const candidates: OcrCandidate[] = [];
  for (const page of pages) {
    if (!Number.isInteger(page.page) || page.page < 1 || page.page > 10000 || pageIds.has(page.page)
      || typeof page.text !== 'string' || page.text.length > 200000
      || (page.engine !== undefined && (typeof page.engine !== 'string' || page.engine.length > 200))
      || (page.confidence !== undefined && page.confidence !== null && (!Number.isFinite(page.confidence) || page.confidence < 0 || page.confidence > 100))) {
      throw new Error('Invalid or oversized OCR page.');
    }
    pageIds.add(page.page);
    let contextDate: string | null = options.defaultDate ?? null;
    let contextDateOrigin: 'user' | 'page-header' = 'user';
    const lines = page.text.replace(/\r\n?/g, '\n').split('\n');
    for (let index = 0; index < lines.length; index++) {
      const rawText = lines[index];
      if (!rawText.trim()) continue;
      if (rawText.length > OCR_MAX_SOURCE_LINE) throw new Error('An OCR row is too long; crop the page or use manual entry.');
      const lineDates = datesIn(rawText);
      const lineTypes = typesIn(rawText);
      const clockTokens = clocksIn(rawText, options.timeFormat);
      const datedHeading = /\b(?:log|sheet|records?|date)\b/i.test(rawText)
        && !/\b(?:wet|dirty|dry|formula|breast|poop|stool|nursing)\b/i.test(rawText)
        && volumesIn(rawText).length === 0;
      if (lineDates.length === 1 && (lineTypes.length === 0 || datedHeading) && clockTokens.length === 0) {
        contextDate = lineDates[0].value; contextDateOrigin = 'page-header';
        if (contextDate !== null) continue;
      }
      // Plain table headings contain no event data. Unknown data rows remain visible.
      if (lineTypes.length && clockTokens.length === 0 && lineDates.length === 0
        && /\b(?:date|time|amount|unit|notes)\b/i.test(rawText)
        && /^(?:[\s|,:/-]|date|time|feeding|feed|bottle|amount|unit|diaper|wet|dirty|sleep|notes|milk|ml|oz)+$/i.test(rawText)) continue;
      let slot = 0;
      for (const segment of segmentsIn(rawText)) {
        const types = typesIn(segment);
        for (const eventType of types.length ? types : ['unknown'] as const) {
          candidates.push(makeCandidate(page, index + 1, rawText, segment, eventType, slot++, contextDate, contextDateOrigin, options.timeFormat));
          if (candidates.length > OCR_MAX_CANDIDATES) throw new Error(`At most ${OCR_MAX_CANDIDATES} draft events are supported per document.`);
        }
      }
    }
  }
  return candidates;
}
