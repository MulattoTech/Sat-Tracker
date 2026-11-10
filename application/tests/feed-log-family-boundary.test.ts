import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(),
}));
vi.mock('@/app/api/db', () => ({ default: { feedLog: { findUnique: mocks.findUnique, update: mocks.update }, baby: { findFirst: mocks.findFirst } } }));
vi.mock('@/app/api/utils/auth', () => ({ withAuthContext: (fn: (...args: any[]) => unknown) => (req: unknown) => fn(req, { authenticated: true, familyId: 'family-a', caretakerId: 'caregiver-a' }) }));
vi.mock('@/app/api/utils/writeProtection', () => ({ checkWritePermission: () => ({ allowed: true }) }));
vi.mock('@/src/lib/notifications/activityHook', () => ({ notifyActivityCreated: vi.fn(), resetTimerNotificationState: vi.fn() }));
import { PUT } from '@/app/api/feed-log/route';
const now = new Date('2026-10-20T12:00:00Z');
beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue({ id: 'feed-a', familyId: 'family-a', babyId: 'child-a', type: 'BOTTLE' });
  mocks.update.mockResolvedValue({ id: 'feed-a', familyId: 'family-a', babyId: 'child-a', type: 'BOTTLE', time: now, createdAt: now, updatedAt: now, deletedAt: null });
});
const request = (body: object) => new NextRequest('http://localhost/api/feed-log?id=feed-a', { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
describe('Existing feed API keeps edits inside the authenticated family', () => {
  it('rejects reassignment to another family child before any update', async () => {
    mocks.findFirst.mockResolvedValue(null);
    const response = await PUT(request({ babyId: 'other-family-child', amount: 120 }));
    expect(response.status).toBe(404); expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.findFirst).toHaveBeenCalledWith({ where: { id: 'other-family-child', familyId: 'family-a', deletedAt: null } });
  });
  it('never passes client supplied IDs, caretaker ownership or timestamps into the update', async () => {
    const response = await PUT(request({ id: 'replacement', familyId: 'family-b', caretakerId: 'other-caregiver', createdAt: '2000-01-01', updatedAt: '2000-01-01', sourcePumpId: 'foreign-pump', sourceCaregiverName: 'forged', amount: 85 }));
    expect(response.status).toBe(200);
    const data = mocks.update.mock.calls[0][0].data;
    expect(data.amount).toBe(85);
    for (const field of ['id', 'familyId', 'caretakerId', 'createdAt', 'updatedAt', 'sourcePumpId', 'sourceCaregiverName']) expect(data).not.toHaveProperty(field);
  });
  it('conceals records in other families', async () => {
    mocks.findUnique.mockResolvedValue({ id: 'feed-a', familyId: 'family-b', babyId: 'child-b' });
    expect((await PUT(request({ amount: 85 }))).status).toBe(404); expect(mocks.update).not.toHaveBeenCalled();
  });
  it('rejects contradictory bottle volumes in the older API too', async () => {
    expect((await PUT(request({ amount: 90, offeredAmount: 60 }))).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
