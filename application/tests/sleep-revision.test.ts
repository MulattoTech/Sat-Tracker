import { describe, expect, it } from 'vitest';
import type { SleepLog } from '@prisma/client';
import { sleepRevision } from '@/app/api/sleep-log/revision';
const row: SleepLog = { id: 'sleep', babyId: 'child', familyId: 'family', caretakerId: 'caregiver', type: 'NAP',
  startTime: new Date('2026-10-20T12:00:00Z'), endTime: null, duration: null, location: 'Crib', quality: null, notes: null,
  createdAt: new Date('2026-10-20T12:00:00Z'), updatedAt: new Date('2026-10-20T12:00:00Z'), deletedAt: null };
const changes: Record<keyof SleepLog, unknown> = { id: 'other', babyId: 'sibling', familyId: 'foreign', caretakerId: 'peer', type: 'NIGHT_SLEEP',
  startTime: new Date('2026-10-20T12:05:00Z'), endTime: new Date('2026-10-20T13:00:00Z'), duration: 0, location: null, quality: 'GOOD', notes: '',
  createdAt: new Date('2026-10-20T12:00:00.001Z'), updatedAt: new Date('2026-10-20T12:00:00.001Z'), deletedAt: new Date('2026-10-20T13:00:00Z') };
describe('opaque full-content sleep revision', () => {
  it.each(Object.entries(changes))('observes persisted %s independently of updatedAt', (key, value) => {
    expect(sleepRevision({ ...row, [key]: value })).not.toBe(sleepRevision(row));
  });
  it('is stable for the same scalar state independent of property construction order', () => {
    const reordered = Object.fromEntries(Object.entries(row).reverse()) as SleepLog;
    expect(sleepRevision(reordered)).toBe(sleepRevision(row)); expect(sleepRevision(row)).toMatch(/^[a-f\d]{64}$/);
  });
});
