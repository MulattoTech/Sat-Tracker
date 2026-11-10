export type SleepIntent = {
  kind: 'start'; scope: string; familyId: string; babyId: string; requestedAt: string;
  requestId: string; startTime: string; type: 'NAP'; location: string;
} | {
  kind: 'wake' | 'undo-start' | 'undo-wake'; scope: string; familyId: string; babyId: string; requestedAt: string;
  sleepId: string; expectedRevision: string; startTime: string; endTime?: string;
};

const instant = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const sleepIntentKey = (scope: string) => `nurserySleepIntentV1:${scope}`;

/** This browser keeps one immutable first action per authenticated family/actor/child.
 * These fields describe care intent; they never contain authentication tokens. */
export function normalizeSleepIntent(scope: string, input: unknown): SleepIntent | null {
  try {
    const owner = JSON.parse(scope);
    if (!Array.isArray(owner) || owner.length !== 3 || JSON.stringify(owner) !== scope
      || !owner.every(part => typeof part === 'string' && part.length > 0 && part.length <= 200)
      || !/^(account|caretaker):.+/.test(owner[1]) || !input || typeof input !== 'object' || Array.isArray(input)) return null;
    const v = input as Record<string, unknown>;
    if (v.scope !== scope || v.familyId !== owner[0] || v.babyId !== owner[2]
      || !instant(v.requestedAt) || !instant(v.startTime)) return null;
    const common = { scope, familyId: owner[0], babyId: owner[2], requestedAt: v.requestedAt, startTime: v.startTime };
    const keys = ['kind', 'scope', 'familyId', 'babyId', 'requestedAt', 'startTime'];
    let result: SleepIntent;
    if (v.kind === 'start') {
      if (typeof v.requestId !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(v.requestId)
        || v.type !== 'NAP' || typeof v.location !== 'string' || !v.location.trim() || v.location.length > 500
        || v.startTime !== v.requestedAt) return null;
      keys.push('requestId', 'type', 'location');
      result = { ...common, kind: v.kind, requestId: v.requestId, type: v.type, location: v.location };
    } else {
      if (!['wake', 'undo-start', 'undo-wake'].includes(String(v.kind)) || typeof v.sleepId !== 'string' || !v.sleepId || v.sleepId.length > 128
        || typeof v.expectedRevision !== 'string' || !/^[a-f\d]{64}$/.test(v.expectedRevision)) return null;
      keys.push('sleepId', 'expectedRevision');
      result = { ...common, kind: v.kind as 'wake' | 'undo-start' | 'undo-wake', sleepId: v.sleepId, expectedRevision: v.expectedRevision };
      if (v.kind === 'wake') {
        if (!instant(v.endTime) || v.endTime !== v.requestedAt || Date.parse(v.endTime) < Date.parse(v.startTime)
          || Math.round((Date.parse(v.endTime) - Date.parse(v.startTime)) / 60_000) > 2_147_483_647) return null;
        keys.push('endTime'); result.endTime = v.endTime;
      }
    }
    return Object.keys(v).some(key => !keys.includes(key)) ? null : result;
  } catch { return null; }
}

export type SleepIntentRead = { status: 'saved'; intent: SleepIntent } | { status: 'missing' | 'invalid' | 'unavailable' };
export function readSleepIntent(scope: string): SleepIntentRead {
  if (typeof window === 'undefined') return { status: 'unavailable' };
  try {
    const raw = window.localStorage.getItem(sleepIntentKey(scope));
    if (raw === null) return { status: 'missing' };
    let input: unknown;
    try { input = JSON.parse(raw); } catch { return { status: 'invalid' }; }
    const intent = normalizeSleepIntent(scope, input);
    return intent ? { status: 'saved', intent } : { status: 'invalid' };
  } catch { return { status: 'unavailable' }; }
}

export type SleepIntentMutationResult =
  | { status: 'saved'; intent: SleepIntent }
  | { status: 'removed' }
  | { status: 'changed'; intent: SleepIntent | null }
  | { status: 'invalid' | 'unavailable' | 'locking-unavailable' | 'busy' | 'cancelled' };

/** Every writer uses one origin-wide lock. Verify never recreates an action
 * removed by another tab; remove cannot erase a newer action after a late reply.
 * The lock covers synchronous storage only, never network delivery. */
export async function mutateSleepIntent(
  scope: string, kind: 'create' | 'verify' | 'remove', intent: SleepIntent, canWrite: () => boolean = () => true,
): Promise<SleepIntentMutationResult> {
  const normalized = normalizeSleepIntent(scope, intent);
  if (!normalized) return { status: 'invalid' };
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return { status: 'locking-unavailable' };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2000);
  try {
    return await navigator.locks.request(sleepIntentKey(scope), { signal: controller.signal }, () => {
      if (!canWrite()) return { status: 'cancelled' as const };
      const read = readSleepIntent(scope);
      if (read.status === 'unavailable' || read.status === 'invalid') return { status: read.status };
      const saved = read.status === 'saved' ? read.intent : null;
      if ((!saved && kind !== 'create') || (saved && JSON.stringify(saved) !== JSON.stringify(normalized))) {
        return { status: 'changed' as const, intent: saved };
      }
      const key = sleepIntentKey(scope);
      if (kind === 'remove') {
        window.localStorage.removeItem(key);
        return window.localStorage.getItem(key) === null ? { status: 'removed' as const } : { status: 'unavailable' as const };
      }
      if (saved) return { status: 'saved' as const, intent: saved };
      const encoded = JSON.stringify(normalized);
      window.localStorage.setItem(key, encoded);
      return window.localStorage.getItem(key) === encoded
        ? { status: 'saved' as const, intent: normalized } : { status: 'unavailable' as const };
    });
  } catch { return { status: controller.signal.aborted ? 'busy' : 'unavailable' }; }
  finally { clearTimeout(timer); }
}
