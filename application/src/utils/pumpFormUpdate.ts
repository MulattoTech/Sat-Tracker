import type { PumpLogCreate, PumpLogResponse } from '@/app/api/types';

/** Review of an imported disposition must not rewrite untouched source fields. */
export function changedPumpFields(
  existing: PumpLogResponse,
  draft: PumpLogCreate,
  editedTimes: { start: boolean; end: boolean },
): Partial<PumpLogCreate> {
  const update: Partial<PumpLogCreate> = {};
  for (const key of Object.keys(draft) as (keyof PumpLogCreate)[]) {
    const value = draft[key];
    if (value === undefined || key === 'duration') continue;
    if (key === 'startTime' || key === 'endTime') {
      if (!editedTimes[key === 'startTime' ? 'start' : 'end']) continue;
      const previous = existing[key];
      if (previous && new Date(previous).getTime() === new Date(value as string).getTime()) continue;
    } else if (value === existing[key] || (key === 'notes' && value === (existing.notes ?? ''))) {
      continue;
    }
    Object.assign(update, { [key]: value });
  }
  const hasEnd = update.endTime !== undefined || existing.endTime !== null;
  if (hasEnd && (update.startTime !== undefined || update.endTime !== undefined) && draft.duration !== undefined) {
    update.duration = draft.duration;
  }
  return update;
}
