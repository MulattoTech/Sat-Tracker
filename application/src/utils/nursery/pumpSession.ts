// Pure localStorage read/write/validate helpers for the in-progress pump timer.
// Pump has no server-side "active session" record (unlike breastfeeding/sleep), so a
// page reload or a baby switch-and-back would otherwise lose an in-progress session
// entirely — this mirrors that persistence locally. New sessions are scoped to
// family, caregiver and baby; the unscoped V1 key is retained for explicit review.
import type { BottleUnit } from '@/src/utils/defaultBottleUnit';
import { isPumpAction, type PumpAction } from '@/src/utils/pumpAction';
import { representablePumpAmount, validPumpDuration } from '@/src/utils/pump-validation';

export interface PumpSubmission {
  requestId: string;
  expectedScope: string;
  babyId: string;
  startTime: string;
  endTime: string;
  duration: number;
  pumpAction: PumpAction;
  unitAbbr: BottleUnit;
  leftAmount?: number;
  rightAmount?: number;
}

export type PumpSessionPhase = 'timing' | 'paused' | 'selecting_action';
export type PumpSessionSide = 'left' | 'right' | 'both';

export interface PumpSessionSnapshot {
  phase: PumpSessionPhase;
  activeSide: PumpSessionSide;
  startTime: string;
  sideDuration: { left: number; right: number };
  pauseAccumulated: number;
  resumeTime: number | null;
  elapsed: number;
  amountLeft: string;
  amountRight: string;
  requestId?: string;
  scope?: string;
  unitAbbr?: BottleUnit;
  endTime?: string;
  pumpAction?: PumpAction;
  recoveredLegacy?: boolean;
  /** Exact request retained until confirmed or definitively rejected. */
  pending?: PumpSubmission;
}

const STORAGE_PREFIX = 'nurseryPumpSessionV1:';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonNegNumber(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v) && v >= 0;
}

export function pumpSessionKey(babyId: string, scope?: string): string {
  return scope ? `nurseryPumpSessionV2:${scope}` : `${STORAGE_PREFIX}${babyId}`;
}

const validRequestId = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
function scopeBaby(value: unknown): string | null {
  try {
    const parts = typeof value === 'string' ? JSON.parse(value) : null;
    return Array.isArray(parts) && parts.length === 3 && parts.every(part => typeof part === 'string' && part.length > 0)
      && /^(?:account|caretaker):.+/.test(parts[1]) ? parts[2] : null;
  } catch { return null; }
}

function parseSubmission(raw: unknown): PumpSubmission | null {
  if (!isPlainObject(raw) || !validRequestId(raw.requestId) || scopeBaby(raw.expectedScope) !== raw.babyId || typeof raw.babyId !== 'string'
    || !timestamp(raw.startTime) || !timestamp(raw.endTime) || Date.parse(raw.endTime) < Date.parse(raw.startTime)
    || !validPumpDuration(raw.duration) || typeof raw.duration !== 'number' || !isPumpAction(raw.pumpAction)
    || (raw.unitAbbr !== 'ML' && raw.unitAbbr !== 'OZ')) return null;
  for (const key of ['leftAmount', 'rightAmount'] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'number' || !representablePumpAmount(raw[key], raw.unitAbbr))) return null;
  }
  return { requestId: raw.requestId, expectedScope: raw.expectedScope as string, babyId: raw.babyId,
    startTime: raw.startTime, endTime: raw.endTime, duration: raw.duration, pumpAction: raw.pumpAction, unitAbbr: raw.unitAbbr,
    ...(raw.leftAmount !== undefined ? { leftAmount: raw.leftAmount as number } : {}),
    ...(raw.rightAmount !== undefined ? { rightAmount: raw.rightAmount as number } : {}) };
}

export function parsePumpSessionSnapshot(raw: unknown): PumpSessionSnapshot | null {
  if (!isPlainObject(raw)) return null;

  const phase = raw.phase;
  if (phase !== 'timing' && phase !== 'paused' && phase !== 'selecting_action') return null;

  const activeSide = raw.activeSide;
  if (activeSide !== 'left' && activeSide !== 'right' && activeSide !== 'both') return null;

  if (typeof raw.startTime !== 'string' || isNaN(Date.parse(raw.startTime))) return null;

  const sideDuration = raw.sideDuration;
  if (!isPlainObject(sideDuration) || !isNonNegNumber(sideDuration.left) || !isNonNegNumber(sideDuration.right)) return null;

  if (!isNonNegNumber(raw.pauseAccumulated)) return null;
  if (raw.resumeTime !== null && !isNonNegNumber(raw.resumeTime)) return null;
  if (!isNonNegNumber(raw.elapsed)) return null;
  if (typeof raw.amountLeft !== 'string' || typeof raw.amountRight !== 'string') return null;
  if (raw.requestId !== undefined && !validRequestId(raw.requestId)) return null;
  if (raw.scope !== undefined && !scopeBaby(raw.scope)) return null;
  if (raw.unitAbbr !== undefined && raw.unitAbbr !== 'ML' && raw.unitAbbr !== 'OZ') return null;
  if ([raw.requestId, raw.scope, raw.unitAbbr].some(value => value !== undefined)
    && [raw.requestId, raw.scope, raw.unitAbbr].some(value => value === undefined)) return null;
  if (raw.endTime !== undefined && !timestamp(raw.endTime)) return null;
  if (raw.pumpAction !== undefined && !isPumpAction(raw.pumpAction)) return null;
  if (raw.recoveredLegacy !== undefined && typeof raw.recoveredLegacy !== 'boolean') return null;
  const pending = raw.pending === undefined ? undefined : parseSubmission(raw.pending);
  if (raw.pending !== undefined && (!pending || pending.requestId !== raw.requestId || pending.expectedScope !== raw.scope
    || pending.startTime !== raw.startTime || pending.endTime !== raw.endTime || pending.unitAbbr !== raw.unitAbbr
    || pending.pumpAction !== raw.pumpAction || phase !== 'selecting_action')) return null;

  return {
    phase,
    activeSide,
    startTime: raw.startTime,
    sideDuration: { left: sideDuration.left, right: sideDuration.right },
    pauseAccumulated: raw.pauseAccumulated,
    resumeTime: raw.resumeTime,
    elapsed: raw.elapsed,
    amountLeft: raw.amountLeft,
    amountRight: raw.amountRight,
    ...(raw.requestId !== undefined ? { requestId: raw.requestId as string } : {}),
    ...(raw.scope !== undefined ? { scope: raw.scope as string } : {}),
    ...(raw.unitAbbr !== undefined ? { unitAbbr: raw.unitAbbr as BottleUnit } : {}),
    ...(raw.endTime !== undefined ? { endTime: raw.endTime as string } : {}),
    ...(raw.pumpAction !== undefined ? { pumpAction: raw.pumpAction as PumpAction } : {}),
    ...(raw.recoveredLegacy !== undefined ? { recoveredLegacy: raw.recoveredLegacy as boolean } : {}),
    ...(pending ? { pending } : {}),
  };
}

export type PumpSessionRead = { status: 'saved'; snapshot: PumpSessionSnapshot }
  | { status: 'missing' | 'unavailable' | 'invalid' };

/** Missing and unreadable are different: a storage exception must never erase
 * the only in-memory copy of an uncertain request. */
export function readPumpSession(babyId: string, scope?: string): PumpSessionRead {
  if (typeof window === 'undefined' || !babyId) return { status: 'unavailable' };
  try {
    const raw = window.localStorage.getItem(pumpSessionKey(babyId, scope));
    if (raw === null) return { status: 'missing' };
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return { status: 'invalid' }; }
    const snapshot = parsePumpSessionSnapshot(parsed);
    if (!snapshot || (scope && (scopeBaby(scope) !== babyId || snapshot.scope !== scope))) return { status: 'invalid' };
    return { status: 'saved', snapshot };
  } catch {
    return { status: 'unavailable' };
  }
}

export function loadPumpSession(babyId: string, scope?: string): PumpSessionSnapshot | null {
  const result = readPumpSession(babyId, scope);
  return result.status === 'saved' ? result.snapshot : null;
}

export function savePumpSession(babyId: string, snapshot: PumpSessionSnapshot, scope?: string): boolean {
  if (typeof window === 'undefined' || !babyId) return false;
  try {
    const key = pumpSessionKey(babyId, scope), encoded = JSON.stringify(snapshot);
    window.localStorage.setItem(key, encoded);
    return window.localStorage.getItem(key) === encoded;
  } catch {
    return false;
  }
}

export function clearPumpSession(babyId: string, scope?: string): boolean {
  if (typeof window === 'undefined' || !babyId) return false;
  try {
    const key = pumpSessionKey(babyId, scope);
    window.localStorage.removeItem(key);
    return window.localStorage.getItem(key) === null;
  } catch {
    return false;
  }
}

export type PumpSessionMutation =
  | { kind: 'create' | 'save'; snapshot: PumpSessionSnapshot }
  | { kind: 'reject' | 'remove'; requestId: string; pending: PumpSubmission };
export type PumpSessionMutationResult =
  | { status: 'saved'; snapshot: PumpSessionSnapshot }
  | { status: 'removed' }
  | { status: 'changed'; snapshot: PumpSessionSnapshot | null }
  | { status: 'unavailable' | 'invalid' | 'locking-unavailable' };

/** All V2 writers share this origin-wide lock. A check followed by a separate
 * localStorage write is not a cross-tab CAS. Recheck identity and the frozen
 * payload inside the lock, including after a network response arrives. */
export async function mutatePumpSession(babyId: string, scope: string, mutation: PumpSessionMutation): Promise<PumpSessionMutationResult> {
  if (scopeBaby(scope) !== babyId || ('snapshot' in mutation && (!parsePumpSessionSnapshot(mutation.snapshot) || mutation.snapshot.scope !== scope))) return { status: 'invalid' };
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return { status: 'locking-unavailable' };
  try {
    return await navigator.locks.request(pumpSessionKey(babyId, scope), () => {
      const read = readPumpSession(babyId, scope);
      if (read.status === 'unavailable' || read.status === 'invalid') return { status: read.status };
      const saved = read.status === 'saved' ? read.snapshot : null;
      const requestId = 'snapshot' in mutation ? mutation.snapshot.requestId : mutation.requestId;
      if (saved && saved.requestId !== requestId) return { status: 'changed' as const, snapshot: saved };
      if (!saved && mutation.kind !== 'create') return { status: 'changed' as const, snapshot: null };
      if (!('snapshot' in mutation)) {
        if (!saved?.pending || JSON.stringify(saved.pending) !== JSON.stringify(mutation.pending)) return { status: 'changed' as const, snapshot: saved };
        if (mutation.kind === 'remove') return clearPumpSession(babyId, scope) ? { status: 'removed' as const } : { status: 'unavailable' as const };
        const editable = { ...saved, pending: undefined };
        return savePumpSession(babyId, editable, scope) ? { status: 'saved' as const, snapshot: editable } : { status: 'unavailable' as const };
      }
      if (saved?.pending) {
        // No stale timer render, other tab, or changed action may unfreeze a
        // request that could already have reached the server.
        return JSON.stringify(saved.pending) === JSON.stringify(mutation.snapshot.pending)
          ? { status: 'saved' as const, snapshot: saved } : { status: 'changed' as const, snapshot: saved };
      }
      return savePumpSession(babyId, mutation.snapshot, scope)
        ? { status: 'saved' as const, snapshot: mutation.snapshot } : { status: 'unavailable' as const };
    });
  } catch { return { status: 'unavailable' }; }
}

/** Freeze the actual endpoint and exact amounts before the first network write.
 * An uncertain retry must use `pending` unchanged, never the current clock. */
export function preparePumpSubmission(session: PumpSessionSnapshot, babyId: string, action: PumpAction): PumpSubmission {
  if (!session.requestId || !session.scope || !session.endTime || !session.unitAbbr) throw new Error('Review the pumping session before saving.');
  const unitAbbr = session.unitAbbr;
  const amount = (value: string) => {
    if (!value.trim()) return undefined;
    const parsed = Number(value);
    if (!representablePumpAmount(parsed, unitAbbr) || !Number.isFinite(parsed)) throw new Error('Enter a valid non-negative pumping amount.');
    return parsed;
  };
  const leftAmount = amount(session.amountLeft), rightAmount = amount(session.amountRight);
  const duration = Math.round((session.sideDuration.left + session.sideDuration.right + session.elapsed) / 60);
  const payload = { requestId: session.requestId, expectedScope: session.scope, babyId, startTime: session.startTime,
    endTime: session.endTime, duration, pumpAction: action, unitAbbr: session.unitAbbr,
    ...(leftAmount !== undefined ? { leftAmount } : {}), ...(rightAmount !== undefined ? { rightAmount } : {}) };
  if (!parseSubmission(payload)) throw new Error('Review the pumping session before saving.');
  return payload;
}
