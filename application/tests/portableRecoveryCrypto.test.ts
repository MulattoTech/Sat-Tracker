import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import { encrypt } from '@/app/api/utils/encryption';
import { sealOcrState } from '@/src/lib/ocr/crypto';
import {
  assertSourceKey, authenticateFileCiphertext, authenticateOcrState, authenticateConfigValue,
  createKeyProof, verifyKeyProof, verifyEncryptedMetadata,
} from '@/src/lib/portable-recovery/crypto';

const key = 'aB'.repeat(32);
function encryptedFile(value: Buffer, sourceKey = key) {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(sourceKey, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}
afterEach(() => vi.unstubAllEnvs());

describe('portable recovery authenticates existing encryption formats with the exact explicit source key', () => {
  it.each([undefined, null, '', 'aa', 'g'.repeat(64), ' ' + key, key + '\n', 42])('rejects invalid key syntax without normalizing %s', value => {
    expect(() => assertSourceKey(value)).toThrow();
  });
  it('accepts mixed-case hexadecimal without changing the text or process environment', () => {
    vi.stubEnv('ENC_HASH', 'cd'.repeat(32));
    assertSourceKey(key);
    expect(process.env.ENC_HASH).toBe('cd'.repeat(32));
    expect(key).toBe('aB'.repeat(32));
  });
  it('authenticates an actual IV16/tag16 file and preserves the ciphertext', () => {
    const plain = Buffer.from('Synthetic retained ciphertext');
    const bytes = encryptedFile(plain), before = Buffer.from(bytes);
    expect(authenticateFileCiphertext(bytes, key, { byteLength: plain.length })).toBe(plain.length);
    expect(bytes).toEqual(before);
    expect(() => authenticateFileCiphertext(bytes, 'ef'.repeat(32))).toThrow();
    expect(() => authenticateFileCiphertext(bytes, key, { byteLength: plain.length + 1 })).toThrow();
  });
  it.each([0, 16, 31, 33])('rejects a truncated or corrupted encrypted file at length %s', length => {
    const bytes = encryptedFile(Buffer.from('synthetic'));
    expect(() => authenticateFileCiphertext(bytes.subarray(0, length), key)).toThrow();
  });
  it('rejects changed authenticated bytes and an incorrect original OCR source hash', () => {
    const bytes = encryptedFile(Buffer.from('synthetic'));
    expect(() => authenticateFileCiphertext(bytes, key, { sha256: '0'.repeat(64) })).toThrow();
    bytes[20] ^= 1;
    expect(() => authenticateFileCiphertext(bytes, key)).toThrow();
  });
  it('opens production OCR envelopes only under the exact family/document/role AAD', () => {
    vi.stubEnv('ENC_HASH', key);
    const value = sealOcrState({ rows: [], synthetic: true }, 'family:document:review');
    expect(() => authenticateOcrState(value, 'family:document:review', key)).not.toThrow();
    for (const scope of ['other:document:review', 'family:other:review', 'family:document:original']) {
      expect(() => authenticateOcrState(value, scope, key)).toThrow();
    }
    expect(() => authenticateOcrState(value.replace('v1.', 'v2.'), 'family:document:review', key)).toThrow();
  });
  it('proves exact text case through the production PBKDF2 config format', () => {
    vi.stubEnv('ENC_HASH', key);
    const value = encrypt('synthetic-secret');
    expect(authenticateConfigValue(value, key)).toBe('authenticated');
    expect(() => authenticateConfigValue(value, key.toLowerCase())).toThrow();
    expect(authenticateConfigValue('legacy-synthetic-value', key)).toBe('legacy-plaintext');
    expect(() => authenticateConfigValue('a:b:c:d', key)).toThrow();
  });
  it('binds the whole canonical descriptor and exact key even without encrypted content', () => {
    const descriptor = { version: 1, metadata: { sha256: '0'.repeat(64), bytes: 17 }, media: [] };
    const proof = createKeyProof(descriptor, key);
    expect(JSON.stringify(proof)).not.toContain(key);
    expect(() => verifyKeyProof({ media: [], metadata: { bytes: 17, sha256: '0'.repeat(64) }, version: 1 }, proof, key)).not.toThrow();
    expect(() => verifyKeyProof(descriptor, proof, key.toLowerCase())).toThrow();
    expect(() => verifyKeyProof({ ...descriptor, version: 2 }, proof, key)).toThrow();
    expect(() => verifyKeyProof(descriptor, { ...proof, iterations: 1 }, key)).toThrow();
    expect(() => verifyKeyProof(descriptor, { ...proof, salt: proof.salt + '=' }, key)).toThrow();
  });
  it('authenticates every encrypted metadata column, including audit snapshots', () => {
    vi.stubEnv('ENC_HASH', key);
    const table = (rows: Record<string, string | null>[]) => ({ rowCount: rows.length, rows });
    const metadata = { tables: {
      AppConfig: table([{ id: 'config', adminPass: encrypt('synthetic-admin') }]),
      EmailConfig: table([{ id: 'email', sendGridApiKey: encrypt('synthetic-sendgrid'), smtp2goApiKey: null, password: 'legacy-synthetic' }]),
      NotificationConfig: table([{ id: 'notification', vapidPrivateKey: encrypt('synthetic-vapid') }]),
      OcrDocument: table([{ id: 'document', familyId: 'family', originalState: sealOcrState({}, 'family:document:original'), reviewState: sealOcrState({}, 'family:document:review') }]),
      OcrAudit: table([{ id: 'audit', documentId: 'document', snapshot: sealOcrState({}, 'family:document:audit') }]),
    } };
    const before = JSON.stringify(metadata);
    const result = verifyEncryptedMetadata(metadata, key);
    expect(result.authenticatedValues).toBe(6);
    expect(result.legacyPlaintextValues).toBe(1);
    expect(JSON.stringify(metadata)).toBe(before);
    metadata.tables.OcrAudit.rows[0].snapshot = sealOcrState({}, 'other:document:audit');
    expect(() => verifyEncryptedMetadata(metadata, key)).toThrow();
  });
});
