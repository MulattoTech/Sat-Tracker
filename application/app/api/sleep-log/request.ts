import { NextResponse, type NextRequest } from 'next/server';
import type { SleepLogCreate } from '../types';
import type { AuthResult } from '../utils/auth';
import { careFields, CareWriteError, readCareWrite } from '../utils/care-write';
import { journalScope } from '@/src/lib/bottle-journal/outbox-identity';

export type SleepAction = 'start' | 'wake' | 'undo-start' | 'undo-wake';
export type SleepRequest = { action: 'start'; requestId: string; expectedScope: string }
  | { action: 'wake' | 'undo-start' | 'undo-wake'; expectedRevision: string; expectedScope: string };

export class SleepWriteError extends CareWriteError {
  constructor(message = 'The sleep record changed. Reload and review the care log before trying again.',
    readonly code = 'SLEEP_CONFLICT', status = 409) { super(message, status); }
  response() { return NextResponse.json({ success: false, error: this.message, code: this.code }, { status: this.status }); }
}

const metadata = new Set(['nurseryAction', 'requestId', 'expectedRevision', 'expectedScope']);
const canonicalInstant = (value: unknown): value is string => typeof value === 'string'
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

/** Recovery metadata is parsed independently; only readCareWrite's copied
 * scalar result can ever reach Prisma. Old requests keep their existing shape. */
export async function readSleepWrite(req: NextRequest, method: 'POST' | 'PUT' | 'DELETE') {
  let input: unknown;
  try {
    const text = await req.text();
    input = method === 'DELETE' && !text ? {} : JSON.parse(text);
  } catch { throw new CareWriteError(); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CareWriteError();
  const raw = input as Record<string, unknown>;
  const scalars = Object.fromEntries(Object.entries(raw).filter(([key]) => !metadata.has(key)));
  const body = await readCareWrite<Partial<SleepLogCreate>>({ json: async () => scalars },
    method === 'DELETE' ? {} : careFields.sleep, method === 'POST' ? ['babyId', 'startTime', 'type'] : []);
  if (![...metadata].some(key => Object.hasOwn(raw, key))) return { body, request: null };
  const action = raw.nurseryAction;
  const allowed = method === 'POST' ? ['start'] : method === 'PUT' ? ['wake', 'undo-wake'] : ['undo-start'];
  if (typeof action !== 'string' || !allowed.includes(action) || typeof raw.expectedScope !== 'string'
    || raw.expectedScope.length > 1000) throw new CareWriteError('Invalid nursery sleep request.');
  let request: SleepRequest;
  if (action === 'start') {
    if (typeof raw.requestId !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(raw.requestId)
      || Object.hasOwn(raw, 'expectedRevision') || !canonicalInstant(body.startTime)
      || body.endTime != null || body.duration != null) throw new CareWriteError('Invalid nursery sleep start.');
    request = { action, expectedScope: raw.expectedScope, requestId: raw.requestId.toLowerCase() };
  } else {
    if (typeof raw.expectedRevision !== 'string' || !/^[a-f\d]{64}$/.test(raw.expectedRevision)
      || Object.hasOwn(raw, 'requestId')) throw new CareWriteError('Invalid nursery sleep revision.');
    if (Object.keys(body).some(key => !['endTime', 'duration'].includes(key))) throw new CareWriteError('Invalid nursery sleep change.');
    if (action === 'wake' && (!canonicalInstant(body.endTime) || Object.hasOwn(body, 'duration'))) throw new CareWriteError('Invalid nursery wake time.');
    if (action === 'undo-wake' && (body.endTime !== null || body.duration !== null)) throw new CareWriteError('Invalid nursery sleep undo.');
    request = { action: action as 'wake' | 'undo-start' | 'undo-wake', expectedScope: raw.expectedScope, expectedRevision: raw.expectedRevision };
  }
  return { body, request };
}

export function sleepActor(auth: AuthResult): string | null {
  return auth.isAccountAuth && auth.accountId ? `account:${auth.accountId}` : auth.caretakerId ? `caretaker:${auth.caretakerId}` : null;
}

export function assertSleepScope(request: SleepRequest | null, auth: AuthResult, babyId: string) {
  if (!request) return;
  const actor = sleepActor(auth);
  if (!actor || !auth.familyId || auth.isSetupAuth || auth.isSysAdmin
    || request.expectedScope !== journalScope(auth.familyId, actor, babyId)) {
    throw new SleepWriteError('The signed-in caregiver or child changed. Return to the original caregiver and child to review this sleep action.', 'SLEEP_SCOPE_CHANGED');
  }
}
