export const PUMP_REVISION_CONFLICT = 'This pumping record changed. Your changes were not saved. Load the latest record and review your correction.';

/** Revisions use the exact UTC millisecond string returned by the API. */
export function isPumpRevision(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) && instant.toISOString() === value;
}

/** Legacy callers can omit the precondition; a present invalid value fails closed. */
export function checkPumpRevision(value: unknown, updatedAt: Date) {
  if (value === undefined) return null;
  if (!isPumpRevision(value)) return { status: 400, error: 'Invalid pumping revision. Load the latest record before editing.' };
  if (value !== updatedAt.toISOString()) return { status: 409, error: PUMP_REVISION_CONFLICT };
  return null;
}
