import type { ExternalImportPumpRecord } from '@/src/types/external-import';
import { resolveImportTimestamp } from './timestamp';

export function resolveExternalImportPumpTiming(record: ExternalImportPumpRecord, sourceTimezone: string) {
  const startTime = resolveImportTimestamp(record.startTime, sourceTimezone, 'pumping');
  const endTime = resolveImportTimestamp(record.endTime, sourceTimezone, 'pumping');
  const elapsed = endTime.getTime() - startTime.getTime();
  if (elapsed < 0) throw new Error('Pumping end time must not be before start time');
  // PumpLog stores whole minutes. Preserve exact endpoints and the existing
  // nearest-minute convention, but only after resolving both actual instants.
  const duration = Math.round(elapsed / 60_000);
  if (!Number.isSafeInteger(duration) || duration > 2_147_483_647) {
    throw new Error('Pumping duration is outside the supported range. Check the source timestamps.');
  }
  if (record.duration !== undefined && record.duration !== duration) {
    throw new Error('Pumping duration conflicts with the source start and end timestamps.');
  }
  return { startTime, endTime, duration };
}
