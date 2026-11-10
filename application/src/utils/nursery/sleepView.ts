import type { SleepLogResponse } from '@/app/api/types';
import type { SleepIntent } from './sleepIntent';

export type NurserySleep = SleepLogResponse & { revision: string };
export function readNurserySleep(value: unknown, familyId: string, babyId: string): NurserySleep | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.familyId !== familyId || row.babyId !== babyId || typeof row.id !== 'string' || !row.id || row.id.length > 128
    || typeof row.revision !== 'string' || !/^[a-f\d]{64}$/.test(row.revision)
    || typeof row.startTime !== 'string' || !Number.isFinite(Date.parse(row.startTime))
    || (row.endTime !== null && (typeof row.endTime !== 'string' || !Number.isFinite(Date.parse(row.endTime))))
    || (row.deletedAt !== null && typeof row.deletedAt !== 'string')
    || !['NAP', 'NIGHT_SLEEP'].includes(String(row.type))) return null;
  return row as NurserySleep;
}

export function sleepIntentRequest(intent: SleepIntent) {
  const metadata = { nurseryAction: intent.kind, expectedScope: intent.scope };
  if (intent.kind === 'start') return { url: '/api/sleep-log', method: 'POST', body: {
    babyId: intent.babyId, startTime: intent.startTime, type: intent.type, location: intent.location,
    ...metadata, requestId: intent.requestId,
  } };
  return { url: `/api/sleep-log?id=${encodeURIComponent(intent.sleepId)}`, method: intent.kind === 'undo-start' ? 'DELETE' : 'PUT', body: {
    ...metadata, expectedRevision: intent.expectedRevision,
    ...(intent.kind === 'wake' ? { endTime: intent.endTime } : intent.kind === 'undo-wake' ? { endTime: null, duration: null } : {}),
  } };
}

/** Matching values allow only a guarded retry, never automatic confirmation.
 * The server's durable receipt still proves which request created the row. */
export function matchesSleepStart(row: NurserySleep, intent: Extract<SleepIntent, { kind: 'start' }>) {
  const actor = (JSON.parse(intent.scope) as string[])[1];
  return row.deletedAt === null && row.endTime === null && row.startTime === intent.startTime && row.type === intent.type
    && row.location === intent.location && row.quality === null && row.notes === null && row.duration === null
    && (!actor.startsWith('caretaker:') || row.caretakerId === actor.slice('caretaker:'.length));
}
