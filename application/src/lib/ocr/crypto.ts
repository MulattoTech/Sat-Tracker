import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function key(): Buffer {
  const value = process.env.ENC_HASH;
  if (!value || !/^[a-f\d]{64}$/i.test(value)) {
    throw new Error('OCR requires the existing 32-byte Sprout encryption key.');
  }
  return Buffer.from(value, 'hex');
}

export function sealOcrState(value: unknown, scope: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(scope));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}

export function openOcrState<T>(value: string, scope: string): T {
  const [version, iv, tag, ciphertext, extra] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext || extra) throw new Error('Invalid encrypted OCR state.');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(scope));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8'));
}
