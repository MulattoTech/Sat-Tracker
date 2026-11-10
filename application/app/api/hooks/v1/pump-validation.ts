import type { PumpLog } from '@prisma/client';
import { normalizeVolumeUnit } from '@/src/utils/unit-conversion';
import { parsePumpTimestamp, representablePumpAmount, validPumpDuration } from '@/src/utils/pump-validation';

const amountFields = ['leftAmount', 'rightAmount', 'totalAmount'] as const;
export type PumpValidationContext = Pick<PumpLog, 'startTime' | 'endTime' | 'duration' | 'leftAmount' | 'rightAmount' | 'totalAmount' | 'unitAbbr'>;
type PumpFields = Partial<Pick<PumpLog, 'duration' | 'leftAmount' | 'rightAmount' | 'totalAmount'>> & {
  startTime?: Date; endTime?: Date;
};

// Hooks accept numeric strings. Validate their numeric value with the same
// bounds as the manual API without changing hooks' partial-update semantics.
export function prepareHookPumpFields(
  body: Record<string, unknown>, existing?: PumpValidationContext, deriveTotal = false,
): { data: PumpFields } | { error: string; code: string } {
  const data: PumpFields = {};
  const unit = normalizeVolumeUnit((body.unitAbbr !== undefined ? body.unitAbbr : existing?.unitAbbr) as string | null | undefined);
  if (body.unitAbbr !== undefined && unit === null) return { code: 'INVALID_UNIT', error: 'Pumping unitAbbr must be OZ or ML.' };
  const validAmount = (value: unknown): value is number | null => representablePumpAmount(value, unit);
  for (const field of [...amountFields, 'duration'] as const) {
    const value = body[field];
    if (value === undefined) continue;
    const numeric = value === null ? null : typeof value === 'number' ? value :
      typeof value === 'string' && value.trim() ? Number(value) : NaN;
    if (field === 'duration' ? !validPumpDuration(numeric) : !validAmount(numeric)) {
      return { code: field === 'duration' ? 'INVALID_DURATION' : 'INVALID_AMOUNT', error: field === 'duration'
        ? 'Pumping duration must be a non-negative whole number of minutes within the supported integer range.'
        : `${field} must be a finite, non-negative number within the supported volume range, or null.` };
    }
    data[field] = numeric;
  }
  // POST historically derives from sides when the total is absent OR null.
  // PUT changes only submitted fields, including an explicit null total.
  if (deriveTotal && body.totalAmount == null && (body.leftAmount !== undefined || body.rightAmount !== undefined)) {
    const left = data.leftAmount !== undefined ? data.leftAmount : existing?.leftAmount ?? null;
    const right = data.rightAmount !== undefined ? data.rightAmount : existing?.rightAmount ?? null;
    if (!validAmount(left) || !validAmount(right)) return { code: 'INVALID_AMOUNT', error: 'Correct the existing pumping amounts before calculating a new total.' };
    const total = left === null && right === null ? null : (left ?? 0) + (right ?? 0);
    if (!validAmount(total)) return { code: 'INVALID_AMOUNT', error: 'The combined pumping amount exceeds the supported volume range.' };
    data.totalAmount = total;
  }
  for (const field of ['startTime', 'endTime'] as const) {
    if (body[field] === undefined) continue;
    const parsed = parsePumpTimestamp(body[field]);
    if (!parsed) return { code: 'INVALID_TIME', error: `${field} must be a valid pumping timestamp.` };
    data[field] = parsed;
  }
  const start = data.startTime ?? existing?.startTime;
  const end = data.endTime ?? existing?.endTime;
  if ((data.startTime !== undefined || data.endTime !== undefined) && start && end && end < start) {
    return { code: 'INVALID_TIME', error: 'Pumping end time must not be before start time.' };
  }
  if (body.unitAbbr !== undefined && amountFields.some(field => {
    const amount = data[field] !== undefined ? data[field] : existing?.[field];
    return amount !== undefined && !validAmount(amount);
  })) return { code: 'INVALID_AMOUNT', error: 'The existing pumping amounts cannot be represented in the requested unit.' };
  const total = data.totalAmount !== undefined ? data.totalAmount : existing?.totalAmount;
  if ((body.pumpAction === 'STORED' || body.pumpAction === 'FED') && total !== undefined && !validAmount(total)) {
    return { code: 'INVALID_AMOUNT', error: 'Correct the pumping total before adding it to stock or a feeding record.' };
  }
  return { data };
}
