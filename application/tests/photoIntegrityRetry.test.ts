import { describe, expect, it, vi } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';
import { PhotoIntegrityError, withPhotoIntegrity } from '@/app/api/utils/photo-integrity';

describe('photo transaction replay decisions', () => {
  it.each(['P2028', 'P1008'])('never replays an uncertain %s outcome even if a nested driver code resembles retryable contention', async code => {
    for (const originalCode of ['SQLITE_BUSY', '40001']) {
      const transaction = vi.fn(async () => { throw { code, cause: { originalCode } }; });
      const action = vi.fn();
      await expect(withPhotoIntegrity({ $transaction: transaction } as unknown as PrismaClient, 'synthetic-family', action))
        .rejects.toMatchObject({ status: 409, code: 'PHOTO_LINK_BUSY' });
      expect(transaction).toHaveBeenCalledTimes(1); expect(action).not.toHaveBeenCalled();
    }
  });

  it('retries a confirmed lock rejection before application writes and then executes the action once', async () => {
    const lock = vi.fn().mockRejectedValueOnce({ cause: { originalCode: 'SQLITE_BUSY' } }).mockResolvedValue(1);
    const transaction = vi.fn(async (action: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      action({ $executeRaw: lock } as unknown as Prisma.TransactionClient));
    const action = vi.fn(async () => 'saved');
    expect(await withPhotoIntegrity({ $transaction: transaction } as unknown as PrismaClient, 'synthetic-family', action)).toBe('saved');
    expect(lock).toHaveBeenCalledTimes(2); expect(action).toHaveBeenCalledTimes(1);
  });

  it('does not replay SQLite BUSY after application work began or disguise a non-contention failure', async () => {
    const transaction = vi.fn(async (action: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      action({ $executeRaw: async () => 1 } as unknown as Prisma.TransactionClient));
    const db = { $transaction: transaction } as unknown as PrismaClient;
    const busyAction = vi.fn(async () => { throw { cause: { originalCode: 'SQLITE_BUSY' } }; });
    await expect(withPhotoIntegrity(db, 'synthetic-family', busyAction)).rejects.toBeInstanceOf(PhotoIntegrityError);
    expect(busyAction).toHaveBeenCalledTimes(1);
    const failure = new Error('synthetic validation failure');
    await expect(withPhotoIntegrity(db, 'synthetic-family', async () => { throw failure; })).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledTimes(2);
  });
});
