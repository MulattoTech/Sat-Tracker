import type { ActiveBreastFeedResponse } from '@/app/api/types';

export interface BreastfeedStopIntent {
  scope: string;
  sessionId: string;
  familyId: string;
  babyId: string;
  expectedUpdatedAt: string;
  stoppedAt: string;
  leftDuration: number;
  rightDuration: number;
  pauseDuration: number;
}

const seconds = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2_147_483_647;
const instant = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const breastfeedStopKey = (scope: string) => `nurseryBreastfeedStopV1:${scope}`;

function parseIntent(scope: string, value: unknown): BreastfeedStopIntent | null {
  try {
    const owner = JSON.parse(scope);
    if (!Array.isArray(owner) || owner.length !== 3 || !owner.every(part => typeof part === 'string' && part)
      || !/^(account|caretaker):.+/.test(owner[1]) || !value || typeof value !== 'object' || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    if (v.scope !== scope || v.familyId !== owner[0] || v.babyId !== owner[2]
      || typeof v.sessionId !== 'string' || !v.sessionId || v.sessionId.length > 128
      || !instant(v.expectedUpdatedAt) || !instant(v.stoppedAt)
      || !seconds(v.leftDuration) || !seconds(v.rightDuration) || !seconds(v.pauseDuration)) return null;
    return { scope, familyId: owner[0], babyId: owner[2], sessionId: v.sessionId,
      expectedUpdatedAt: v.expectedUpdatedAt, stoppedAt: v.stoppedAt,
      leftDuration: v.leftDuration, rightDuration: v.rightDuration, pauseDuration: v.pauseDuration };
  } catch { return null; }
}

type StopSource = Pick<ActiveBreastFeedResponse, 'id' | 'familyId' | 'babyId' | 'updatedAt' | 'activeSide'
  | 'leftDuration' | 'rightDuration' | 'pauseDuration' | 'isPaused' | 'currentSideStartTime'> & { pausedAt: string | Date | null };

/** Capture the first stop, including a trailing pause. Waiting or retrying must
 * never turn into additional feeding time or move the second side's span. */
export function captureBreastfeedStop(session: StopSource, scope: string, now = Date.now()): BreastfeedStopIntent {
  if (!Number.isFinite(now) || (session.activeSide !== 'LEFT' && session.activeSide !== 'RIGHT')
    || ![session.leftDuration, session.rightDuration, session.pauseDuration].every(seconds)) {
    throw new Error('Review the breastfeeding timer before stopping it.');
  }
  const since = (time: string | Date | null) => {
    if (!time) return 0;
    const start = time instanceof Date ? time.getTime() : Date.parse(time);
    if (!Number.isFinite(start) || start > now) throw new Error('Review the breastfeeding timer before stopping it.');
    return Math.floor((now - start) / 1000);
  };
  const elapsed = session.isPaused ? 0 : since(session.currentSideStartTime);
  const intent = parseIntent(scope, { scope, familyId: session.familyId, babyId: session.babyId, sessionId: session.id,
    expectedUpdatedAt: session.updatedAt, stoppedAt: new Date(now).toISOString(),
    leftDuration: session.leftDuration + (session.activeSide === 'LEFT' ? elapsed : 0),
    rightDuration: session.rightDuration + (session.activeSide === 'RIGHT' ? elapsed : 0),
    pauseDuration: session.pauseDuration + (session.isPaused ? since(session.pausedAt) : 0),
  });
  if (!intent) throw new Error('Review the breastfeeding timer before stopping it.');
  return intent;
}

export type StopIntentRead = { status: 'saved'; intent: BreastfeedStopIntent } | { status: 'missing' | 'invalid' | 'unavailable' };

/** Per-tab storage survives refresh without allowing one tab to replace another
 * tab's stop intent. The API still arbitrates every shared-session mutation. */
export function readBreastfeedStop(scope: string): StopIntentRead {
  if (typeof window === 'undefined') return { status: 'unavailable' };
  try {
    const raw = window.sessionStorage.getItem(breastfeedStopKey(scope));
    if (raw === null) return { status: 'missing' };
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return { status: 'invalid' }; }
    const intent = parseIntent(scope, parsed);
    return intent ? { status: 'saved', intent } : { status: 'invalid' };
  } catch { return { status: 'unavailable' }; }
}

export function saveBreastfeedStop(intent: BreastfeedStopIntent): boolean {
  const normalized = parseIntent(intent.scope, intent);
  if (!normalized) return false;
  const read = readBreastfeedStop(intent.scope);
  if (read.status === 'unavailable' || read.status === 'invalid'
    || (read.status === 'saved' && JSON.stringify(read.intent) !== JSON.stringify(normalized))) return false;
  try {
    const encoded = JSON.stringify(normalized), key = breastfeedStopKey(intent.scope);
    window.sessionStorage.setItem(key, encoded);
    return window.sessionStorage.getItem(key) === encoded;
  } catch { return false; }
}

export function clearBreastfeedStop(intent: BreastfeedStopIntent): boolean {
  const read = readBreastfeedStop(intent.scope), normalized = parseIntent(intent.scope, intent);
  if (!normalized) return false;
  if (read.status === 'missing') return true;
  if (read.status !== 'saved' || JSON.stringify(read.intent) !== JSON.stringify(normalized)) return false;
  try {
    const key = breastfeedStopKey(intent.scope);
    window.sessionStorage.removeItem(key);
    return window.sessionStorage.getItem(key) === null;
  } catch { return false; }
}
