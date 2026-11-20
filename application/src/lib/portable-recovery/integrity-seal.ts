import { createHmac, timingSafeEqual } from 'node:crypto';
import { assertSourceKey } from './crypto';
import { canonicalStringify } from './schema';
import type { RecoveryReceipt } from './types';

export type RecoveryMediaFingerprint = {
  readonly storagePath: string;
  readonly sha256: string;
  readonly byteLength: number;
};

/** A key-bound seal for exact recovered scalars and ciphertext, not a general backup signature. */
export function recoveryIntegrityTag(
  receipt: RecoveryReceipt,
  tableHashes: Readonly<Record<string, string>>,
  media: readonly RecoveryMediaFingerprint[],
  exactSourceKey: string,
): string {
  assertSourceKey(exactSourceKey);
  const { integrityTag: _tag, ...fields } = receipt;
  const payload = canonicalStringify({
    receipt: fields,
    tables: Object.entries(tableHashes).sort(([a], [b]) => a.localeCompare(b)),
    media: media.map(file => ({
      storagePath: file.storagePath,
      sha256: file.sha256,
      byteLength: file.byteLength,
    })).sort((a, b) => a.storagePath < b.storagePath ? -1 : a.storagePath > b.storagePath ? 1 : 0),
  });
  // The exact case of ENC_HASH is part of the legacy recovery-key contract.
  return createHmac('sha256', Buffer.from(exactSourceKey, 'utf8')).update(payload).digest('hex');
}

export function verifyRecoveryIntegrity(
  receipt: RecoveryReceipt,
  tableHashes: Readonly<Record<string, string>>,
  media: readonly RecoveryMediaFingerprint[],
  exactSourceKey: string,
): void {
  const expected = receipt.integrityTag;
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error('Recovery receipt lacks a verified integrity seal');
  }
  const actual = recoveryIntegrityTag(receipt, tableHashes, media, exactSourceKey);
  if (!timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))) {
    throw new Error('Recovered metadata or media changed after verification');
  }
}
