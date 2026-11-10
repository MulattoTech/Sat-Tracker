import { journalScopeFromToken } from '@/src/lib/bottle-journal/outbox-identity';

export interface MedicineDoseSubmission {
  requestId: string;
  expectedScope: string;
  babyId: string;
  medicineId: string;
  time: string;
  doseAmount: number;
  unitAbbr: string | null;
  notes: string | null;
}
export interface SavedMedicineDose {
  version: 1;
  request: MedicineDoseSubmission;
  medicineName: string;
  isSupplement: boolean;
}
export type MedicineDoseRead = { status: 'saved'; snapshot: SavedMedicineDose }
  | { status: 'missing' | 'unavailable' | 'invalid' };
export type MedicineDoseMutationResult = { status: 'saved'; snapshot: SavedMedicineDose }
  | { status: 'removed' }
  | { status: 'changed'; snapshot: SavedMedicineDose | null }
  | { status: 'unavailable' | 'invalid' | 'locking-unavailable' };

export const medicineDoseScopeFromToken = journalScopeFromToken;
export const medicineDoseStorageKey = (scope: string) => `medicineDosePendingV1:${scope}`;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';
const identifier = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function scopeChild(scope: unknown): string | null {
  try {
    const value = typeof scope === 'string' ? JSON.parse(scope) : null;
    return Array.isArray(value) && value.length === 3 && value.every(identifier)
      && /^(account|caretaker):.+/.test(value[1]) ? value[2] : null;
  } catch { return null; }
}

/** Reject unreadable or incomplete requests instead of treating them as an
 * empty draft. Preserve the first values without consulting the current clock. */
export function parseSavedMedicineDose(value: unknown): SavedMedicineDose | null {
  if (!object(value) || value.version !== 1 || typeof value.medicineName !== 'string'
    || typeof value.isSupplement !== 'boolean' || !object(value.request)) return null;
  const request = value.request;
  if (typeof request.requestId !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(request.requestId)
    || scopeChild(request.expectedScope) !== request.babyId || !identifier(request.babyId) || !identifier(request.medicineId)
    || typeof request.time !== 'string' || !Number.isFinite(Date.parse(request.time))
    || typeof request.doseAmount !== 'number' || !Number.isFinite(request.doseAmount) || request.doseAmount < 0
    || !nullableString(request.unitAbbr) || !nullableString(request.notes)) return null;
  if (Object.keys(value).some(key => !['version', 'request', 'medicineName', 'isSupplement'].includes(key))
    || Object.keys(request).some(key => !['requestId', 'expectedScope', 'babyId', 'medicineId', 'time', 'doseAmount', 'unitAbbr', 'notes'].includes(key))) return null;
  return { version: 1, medicineName: value.medicineName, isSupplement: value.isSupplement,
    request: { requestId: request.requestId, expectedScope: request.expectedScope as string,
      babyId: request.babyId, medicineId: request.medicineId, time: request.time,
      doseAmount: request.doseAmount, unitAbbr: request.unitAbbr, notes: request.notes } };
}

export function freezeMedicineDose(
  values: { babyId: string; medicineId: string; time: string; doseAmount: number; unitAbbr?: string | null; notes?: string | null },
  scope: string, medicineName: string, isSupplement: boolean, requestId = crypto.randomUUID(),
): SavedMedicineDose {
  const snapshot = parseSavedMedicineDose({ version: 1, medicineName, isSupplement,
    request: { requestId, expectedScope: scope, babyId: values.babyId, medicineId: values.medicineId,
      time: values.time, doseAmount: values.doseAmount, unitAbbr: values.doseAmount === 0 ? null : values.unitAbbr ?? null,
      notes: values.notes ?? null } });
  if (!snapshot) throw new Error('Review the dose details before saving.');
  return snapshot;
}

export function readMedicineDose(scope: string): MedicineDoseRead {
  if (typeof window === 'undefined' || !scopeChild(scope)) return { status: 'unavailable' };
  try {
    const raw = window.localStorage.getItem(medicineDoseStorageKey(scope));
    if (raw === null) return { status: 'missing' };
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return { status: 'invalid' }; }
    const snapshot = parseSavedMedicineDose(value);
    return snapshot?.request.expectedScope === scope ? { status: 'saved', snapshot } : { status: 'invalid' };
  } catch { return { status: 'unavailable' }; }
}

export function sameSavedMedicineDose(left: SavedMedicineDose, right: SavedMedicineDose): boolean {
  const parsedLeft = parseSavedMedicineDose(left), parsedRight = parseSavedMedicineDose(right);
  return !!parsedLeft && !!parsedRight && JSON.stringify(parsedLeft) === JSON.stringify(parsedRight);
}

/** Persist before dispatch, or remove only an exact acknowledged/reviewed copy.
 * The short origin-wide lock covers the comparison and storage mutation; it is
 * never held across a network request. No passive effects write these snapshots. */
export async function mutateMedicineDose(scope: string, kind: 'create' | 'verify' | 'remove', snapshot: SavedMedicineDose): Promise<MedicineDoseMutationResult> {
  if (!parseSavedMedicineDose(snapshot) || snapshot.request.expectedScope !== scope) return { status: 'invalid' };
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return { status: 'locking-unavailable' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    return await navigator.locks.request(medicineDoseStorageKey(scope), { mode: 'exclusive', signal: controller.signal }, () => {
      const read = readMedicineDose(scope);
      if (read.status === 'invalid' || read.status === 'unavailable') return { status: read.status };
      const saved = read.status === 'saved' ? read.snapshot : null;
      if (saved && !sameSavedMedicineDose(saved, snapshot)) return { status: 'changed' as const, snapshot: saved };
      if (!saved && kind !== 'create') return { status: 'changed' as const, snapshot: null };
      try {
        const key = medicineDoseStorageKey(scope);
        if (kind === 'remove') {
          window.localStorage.removeItem(key);
          return window.localStorage.getItem(key) === null ? { status: 'removed' as const } : { status: 'unavailable' as const };
        }
        if (saved) return { status: 'saved' as const, snapshot: saved };
        const encoded = JSON.stringify(snapshot);
        window.localStorage.setItem(key, encoded);
        return window.localStorage.getItem(key) === encoded ? { status: 'saved' as const, snapshot } : { status: 'unavailable' as const };
      } catch { return { status: 'unavailable' as const }; }
    });
  } catch { return { status: 'locking-unavailable' }; }
  finally { clearTimeout(timer); }
}

/** Bound fetch, any shared authentication refresh, and reading the response
 * body together. A timeout never implies that the server rejected the dose. */
export async function requestMedicineDoseJSON(fetcher: (url: string, options?: RequestInit) => Promise<Response>, request: MedicineDoseSubmission) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Saving the dose request timed out. Its original details are kept.'));
    }, 20_000);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetcher('/api/medicine-log', { method: 'POST', cache: 'no-store', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
        return { response, data: await response.json() };
      })(), deadline,
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
