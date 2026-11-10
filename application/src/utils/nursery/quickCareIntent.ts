export type QuickCareKind = 'diaper' | 'food';
type CommonIntent = { version: 1; scope: string; familyId: string; babyId: string; requestId: string; time: string };
export type QuickCareIntent = CommonIntent & (
  { kind: 'diaper'; type: 'WET' | 'DIRTY' | 'BOTH' | 'DRY' }
  | { kind: 'food'; foodId: string; foodName: string }
);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const instant = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const quickCareIntentKey = (kind: QuickCareKind, scope: string) => `nurseryQuickCareIntentV1:${kind}:${scope}`;

/** Immutable first action, stored for this family/actor/child and kind. Names
 * are review labels only; only the frozen food ID is sent to the API. */
export function normalizeQuickCareIntent(kind: QuickCareKind, scope: string, input: unknown): QuickCareIntent | null {
  try {
    const owner = JSON.parse(scope);
    if (!Array.isArray(owner) || owner.length !== 3 || JSON.stringify(owner) !== scope
      || !owner.every(identifier) || !/^(account|caretaker):.+/.test(owner[1])
      || !input || typeof input !== 'object' || Array.isArray(input)) return null;
    const v = input as Record<string, unknown>;
    if (v.version !== 1 || v.kind !== kind || v.scope !== scope || v.familyId !== owner[0] || v.babyId !== owner[2]
      || !instant(v.time) || typeof v.requestId !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(v.requestId)) return null;
    const keys = ['version', 'kind', 'scope', 'familyId', 'babyId', 'requestId', 'time', ...(kind === 'diaper' ? ['type'] : ['foodId', 'foodName'])];
    if (Object.keys(v).length !== keys.length || keys.some(key => !Object.hasOwn(v, key))) return null;
    const common: CommonIntent = { version: 1, scope, familyId: owner[0], babyId: owner[2], requestId: v.requestId, time: v.time };
    if (kind === 'diaper') return typeof v.type === 'string' && ['WET', 'DIRTY', 'BOTH', 'DRY'].includes(v.type)
      ? { ...common, kind, type: v.type as 'WET' | 'DIRTY' | 'BOTH' | 'DRY' } : null;
    return identifier(v.foodId) && typeof v.foodName === 'string' && v.foodName.trim().length > 0 && v.foodName.length <= 1000
      ? { ...common, kind, foodId: v.foodId, foodName: v.foodName } : null;
  } catch { return null; }
}

export type QuickCareIntentRead = { status: 'saved'; intent: QuickCareIntent } | { status: 'missing' | 'invalid' | 'unavailable' };
export function readQuickCareIntent(kind: QuickCareKind, scope: string): QuickCareIntentRead {
  if (typeof window === 'undefined') return { status: 'unavailable' };
  try {
    const raw = window.localStorage.getItem(quickCareIntentKey(kind, scope));
    if (raw === null) return { status: 'missing' };
    let input: unknown; try { input = JSON.parse(raw); } catch { return { status: 'invalid' }; }
    const intent = normalizeQuickCareIntent(kind, scope, input);
    return intent ? { status: 'saved', intent } : { status: 'invalid' };
  } catch { return { status: 'unavailable' }; }
}
export type QuickCareIntentMutation = { status: 'saved'; intent: QuickCareIntent }
  | { status: 'removed' } | { status: 'changed'; intent: QuickCareIntent | null }
  | { status: 'unavailable'; mayHaveSaved: boolean }
  | { status: 'invalid' | 'locking-unavailable' | 'busy' | 'cancelled' };

/** Only synchronous local persistence is locked, never network delivery.
 * Verify cannot recreate another tab's cleared action; removal compares the
 * complete original intent so late replies cannot discard a newer action. */
export async function mutateQuickCareIntent(intent: QuickCareIntent, operation: 'create' | 'verify' | 'remove',
  canWrite: () => boolean = () => true): Promise<QuickCareIntentMutation> {
  const normalized = normalizeQuickCareIntent(intent.kind, intent.scope, intent);
  if (!normalized) return { status: 'invalid' };
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return { status: 'locking-unavailable' };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 2000);
  let mayHaveSaved = false;
  try {
    return await navigator.locks.request(quickCareIntentKey(intent.kind, intent.scope), { signal: controller.signal }, () => {
      if (!canWrite()) return { status: 'cancelled' as const };
      const read = readQuickCareIntent(intent.kind, intent.scope);
      if (read.status === 'invalid') return { status: 'invalid' as const };
      if (read.status === 'unavailable') return { status: 'unavailable' as const, mayHaveSaved: false };
      const saved = read.status === 'saved' ? read.intent : null;
      if ((!saved && operation !== 'create') || (saved && JSON.stringify(saved) !== JSON.stringify(normalized))) {
        return { status: 'changed' as const, intent: saved };
      }
      const key = quickCareIntentKey(intent.kind, intent.scope);
      if (operation === 'remove') {
        window.localStorage.removeItem(key);
        return window.localStorage.getItem(key) === null ? { status: 'removed' as const } : { status: 'unavailable' as const, mayHaveSaved: true };
      }
      if (saved) return { status: 'saved' as const, intent: saved };
      const encoded = JSON.stringify(normalized); window.localStorage.setItem(key, encoded); mayHaveSaved = true;
      return window.localStorage.getItem(key) === encoded ? { status: 'saved' as const, intent: normalized }
        : { status: 'unavailable' as const, mayHaveSaved: true };
    });
  } catch { return controller.signal.aborted ? { status: 'busy' } : { status: 'unavailable', mayHaveSaved }; }
  finally { clearTimeout(timer); }
}

export function quickCareRequest(intent: QuickCareIntent) {
  return { url: `/api/${intent.kind}-log`, body: { babyId: intent.babyId, time: intent.time,
    ...(intent.kind === 'diaper' ? { type: intent.type } : { foodId: intent.foodId }),
    nurseryScope: intent.scope, requestId: intent.requestId } };
}
