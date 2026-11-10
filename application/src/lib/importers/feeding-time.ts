import type { ExternalImportFeedRecord } from '@/src/types/external-import';

import { normalizeImportTimestamp, resolveImportTimestamp } from './timestamp';

export const normalizeFeedingTimestamp = (value: string): string => normalizeImportTimestamp(value, 'feeding');
export const resolveFeedingTimestamp = (value: string, sourceTimezone: string): Date =>
  resolveImportTimestamp(value, sourceTimezone, 'feeding');

export function resolveExternalImportFeedTiming(record: ExternalImportFeedRecord, sourceTimezone: string) {
  const time = resolveFeedingTimestamp(record.time, sourceTimezone);
  if ((record.startTime !== undefined) !== (record.endTime !== undefined)) {
    throw new Error('Both feeding start and end timestamps are required to import a timed session.');
  }
  const startTime = record.startTime !== undefined ? resolveFeedingTimestamp(record.startTime, sourceTimezone) : undefined;
  const endTime = record.endTime !== undefined ? resolveFeedingTimestamp(record.endTime, sourceTimezone) : undefined;
  const feedDuration = startTime && endTime ? (endTime.getTime() - startTime.getTime()) / 1000 : record.feedDuration;
  if (feedDuration !== undefined && (!Number.isInteger(feedDuration) || feedDuration < 0 || feedDuration > 2_147_483_647)) {
    throw new Error('Feeding duration must be a non-negative whole number of seconds. Check the source start and end timestamps.');
  }
  if (startTime && endTime && record.feedDuration !== undefined && record.feedDuration !== feedDuration) {
    throw new Error('Feeding duration conflicts with the source start and end timestamps.');
  }
  return { time, startTime, endTime, feedDuration };
}
