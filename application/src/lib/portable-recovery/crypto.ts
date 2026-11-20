import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalJson, mediaRows, PortableMediaError, requiredString, type MediaMetadata } from './media-types';
export { canonicalJson } from './media-types';

const KEY_PROOF_TEXT = Buffer.from('Sat-Tracker portable recovery key verification v1', 'utf8');
const KEY_PROOF_AAD = 'sat-tracker.portable-recovery:manifest:v1\0';
const ITERATIONS = 100_000;

export function assertSourceKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new PortableMediaError('SOURCE_KEY_FORMAT', 'Supply the exact 64-character hexadecimal source encryption key, without whitespace.');
  }
}
function authenticationError(): never {
  throw new PortableMediaError('DECRYPTION_FAILED', 'Encrypted content could not be authenticated with the supplied source key and original scope.');
}
function base64(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) authenticationError();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length)) authenticationError();
  return bytes;
}
function open(ciphertext: Buffer, key: Buffer, iv: Buffer, tag: Buffer, aad?: Buffer): Buffer {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    if (aad) decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch { return authenticationError(); }
}

/** No environment lookup, file write, re-encryption or plaintext return. */
export function authenticateFileCiphertext(bytes: Buffer, exactKey: string, expected: { byteLength?: number; sha256?: string } = {}): number {
  assertSourceKey(exactKey);
  if (bytes.length < 32) authenticationError();
  const key = Buffer.from(exactKey, 'hex');
  let plain: Buffer | undefined;
  try {
    plain = open(bytes.subarray(32), key, bytes.subarray(0, 16), bytes.subarray(16, 32));
    if ((expected.byteLength !== undefined && plain.length !== expected.byteLength)
      || (expected.sha256 !== undefined && createHash('sha256').update(plain).digest('hex') !== expected.sha256)) {
      throw new PortableMediaError('MEDIA_CONTENT_MISMATCH', 'Authenticated media does not match its original size or source hash.');
    }
    return plain.length;
  } finally { plain?.fill(0); key.fill(0); }
}

export function authenticateOcrState(value: string, scope: string, exactKey: string): void {
  assertSourceKey(exactKey);
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') authenticationError();
  const iv = base64(parts[1], 12), tag = base64(parts[2], 16), ciphertext = base64(parts[3]);
  const key = Buffer.from(exactKey, 'hex');
  let plain: Buffer | undefined;
  try {
    plain = open(ciphertext, key, iv, tag, Buffer.from(scope, 'utf8'));
    try { JSON.parse(plain.toString('utf8')); } catch { authenticationError(); }
  } finally { plain?.fill(0); key.fill(0); }
}

export function authenticateConfigValue(value: string, exactKey: string): 'authenticated' | 'legacy-plaintext' {
  assertSourceKey(exactKey);
  const parts = value.split(':');
  // The existing application deliberately accepts historical plaintext settings.
  // Preserve them exactly and disclose that they are not ciphertext evidence.
  if (parts.length !== 4) return 'legacy-plaintext';
  const iv = base64(parts[0], 16), salt = base64(parts[1], 32), tag = base64(parts[2], 16), ciphertext = base64(parts[3]);
  const key = pbkdf2Sync(exactKey, Buffer.from('baby-tracker-salt'), ITERATIONS, 32, 'sha256');
  let plain: Buffer | undefined;
  try { plain = open(ciphertext, key, iv, tag, salt); return 'authenticated'; }
  finally { plain?.fill(0); key.fill(0); }
}

export interface PortableKeyProof {
  readonly format: 'pbkdf2-sha256-aes256gcm-v1';
  readonly iterations: 100000;
  readonly salt: string;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}
/** Authenticates the entire descriptor, including metadata and every file hash. */
export function createKeyProof(descriptor: unknown, exactKey: string): PortableKeyProof {
  assertSourceKey(exactKey);
  const salt = randomBytes(32), iv = randomBytes(12);
  const key = pbkdf2Sync(exactKey, salt, ITERATIONS, 32, 'sha256');
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(KEY_PROOF_AAD + canonicalJson(descriptor), 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(KEY_PROOF_TEXT), cipher.final()]);
    return { format: 'pbkdf2-sha256-aes256gcm-v1', iterations: ITERATIONS, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  } finally { key.fill(0); }
}
export function verifyKeyProof(descriptor: unknown, proof: unknown, exactKey: string): void {
  assertSourceKey(exactKey);
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) authenticationError();
  const p = proof as Record<string, unknown>;
  if (Object.keys(p).sort().join(',') !== 'ciphertext,format,iterations,iv,salt,tag'
    || p.format !== 'pbkdf2-sha256-aes256gcm-v1' || p.iterations !== ITERATIONS) authenticationError();
  const salt = base64(p.salt, 32), iv = base64(p.iv, 12), tag = base64(p.tag, 16), ciphertext = base64(p.ciphertext, KEY_PROOF_TEXT.length);
  const key = pbkdf2Sync(exactKey, salt, ITERATIONS, 32, 'sha256');
  let plain: Buffer | undefined;
  try {
    plain = open(ciphertext, key, iv, tag, Buffer.from(KEY_PROOF_AAD + canonicalJson(descriptor), 'utf8'));
    if (plain.length !== KEY_PROOF_TEXT.length || !timingSafeEqual(plain, KEY_PROOF_TEXT)) authenticationError();
  } finally { plain?.fill(0); key.fill(0); }
}

export function verifyEncryptedMetadata(metadata: MediaMetadata, exactKey: string): {
  authenticatedValues: number; legacyPlaintextValues: number;
  diagnostics: { code: 'LEGACY_PLAINTEXT_SECRET'; model: string; recordId: string; field: string }[];
} {
  assertSourceKey(exactKey);
  let authenticatedValues = 0;
  const diagnostics: { code: 'LEGACY_PLAINTEXT_SECRET'; model: string; recordId: string; field: string }[] = [];
  for (const [model, fields] of Object.entries({ AppConfig: ['adminPass'], EmailConfig: ['sendGridApiKey', 'smtp2goApiKey', 'password'], NotificationConfig: ['vapidPrivateKey'] })) {
    for (const row of mediaRows(metadata, model)) for (const field of fields) {
      const value = row[field];
      if (value === null || value === '') continue;
      const result = authenticateConfigValue(requiredString(value, `${model}.${field}`), exactKey);
      if (result === 'authenticated') authenticatedValues++;
      else diagnostics.push({ code: 'LEGACY_PLAINTEXT_SECRET', model, recordId: requiredString(row.id, `${model}.id`), field });
    }
  }
  const documents = new Map<string, string>();
  for (const row of mediaRows(metadata, 'OcrDocument')) {
    const id = requiredString(row.id, 'OcrDocument.id'), family = requiredString(row.familyId, 'OcrDocument.familyId');
    if (documents.has(id)) throw new PortableMediaError('DUPLICATE_OCR_DOCUMENT', 'OCR document IDs must be unique.');
    documents.set(id, family);
    for (const [field, role] of [['originalState', 'original'], ['reviewState', 'review']]) {
      authenticateOcrState(requiredString(row[field], `OcrDocument.${field}`), `${family}:${id}:${role}`, exactKey); authenticatedValues++;
    }
  }
  for (const row of mediaRows(metadata, 'OcrAudit')) {
    const id = requiredString(row.documentId, 'OcrAudit.documentId'), family = documents.get(id);
    if (!family) throw new PortableMediaError('MISSING_OCR_DOCUMENT', 'An OCR audit references a missing document.');
    authenticateOcrState(requiredString(row.snapshot, 'OcrAudit.snapshot'), `${family}:${id}:audit`, exactKey); authenticatedValues++;
  }
  return { authenticatedValues, legacyPlaintextValues: diagnostics.length, diagnostics };
}
