import type { OcrFieldOrigin } from './types';

export const OCR_MAX_FEED_DURATION_SECONDS = 24 * 60 * 60;
const label = /\b(?:(?:feeding|feed|nursing|bottle)\s+duration|duration|(?:fed|feeding|nursed|nursing|breastfed|bottle)\s+for)\b\s*[:=]?\s*/gi;
const quantity = /([0-9]+(?:\.[0-9]+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi;

/** Duration cells are not event clocks, including decimal minutes and 4-digit seconds. */
export function maskFeedDuration(text: string): string {
  return text.replace(new RegExp(label.source + '[^;|\\t\\n]*', 'gi'), match => ' '.repeat(match.length))
    .replace(quantity, match => ' '.repeat(match.length));
}

/** Only an explicitly labelled elapsed quantity is a feeding duration; never subtract guessed clocks. */
export function parseFeedDuration(text: string): { value: number | null; origin: OcrFieldOrigin } {
  const labels = [...text.matchAll(label)];
  const unresolved = { value: null, origin: 'ambiguous' as const };
  if (!labels.length) return { value: null, origin: 'missing' };
  if (labels.length !== 1) return unresolved;
  const cue = labels[0];
  if (/\b(?:no|not|without)\s*$/i.test(text.slice(0, cue.index))) return unresolved;
  const raw = text.slice((cue.index ?? 0) + cue[0].length).split(/[;|\t\n]/)[0].trim();
  const parts = [...raw.matchAll(quantity)];
  if (!parts.length || raw.replace(quantity, '').replace(/\band\b/gi, '').trim()) return unresolved;
  let seconds = 0, previousScale = Infinity;
  for (const part of parts) {
    const scale = /^h/i.test(part[2]) ? 3600 : /^m/i.test(part[2]) ? 60 : 1;
    // Repeated/out-of-order units can be alternatives or separate entries, never an implicit sum.
    if (scale >= previousScale) return unresolved;
    previousScale = scale;
    seconds += Number(part[1]) * scale;
  }
  const rounded = Math.round(seconds);
  if (!Number.isFinite(seconds) || Math.abs(seconds - rounded) > 1e-8
    || rounded < 1 || rounded > OCR_MAX_FEED_DURATION_SECONDS) return unresolved;
  return { value: rounded, origin: 'source' };
}
