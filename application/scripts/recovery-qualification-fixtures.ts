/** Synthetic, complete scalar/FK fixture. Never imports the application's singleton client or environment. */
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createPortableMetadata, type PortableProvider, type PortableScalar } from '../src/lib/portable-recovery/metadata-codec';
import type { PortableSchemaRegistry } from '../src/lib/portable-recovery/schema';

export const exportedAt = '2026-11-20T01:02:03.456Z';
export const restoredAt = '2026-11-20T02:02:03.456Z';
export const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function seal(plain: Buffer, key: Buffer, iv: Buffer, aad?: Buffer) {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(aad);
  const bytes = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { bytes, tag: cipher.getAuthTag() };
}
function sealSetting(value: string, exactKey: string): string {
  const iv = randomBytes(16), salt = randomBytes(32);
  const key = pbkdf2Sync(exactKey, Buffer.from('baby-tracker-salt'), 100_000, 32, 'sha256');
  try {
    const { bytes, tag } = seal(Buffer.from(value), key, iv, salt);
    return [iv, salt, tag, bytes].map(part => part.toString('base64')).join(':');
  } finally { key.fill(0); }
}
function sealState(value: unknown, scope: string, exactKey: string): string {
  const iv = randomBytes(12), key = Buffer.from(exactKey, 'hex');
  try {
    const { bytes, tag } = seal(Buffer.from(JSON.stringify(value)), key, iv, Buffer.from(scope));
    return ['v1', iv.toString('base64'), tag.toString('base64'), bytes.toString('base64')].join('.');
  } finally { key.fill(0); }
}

/** Independent plaintext oracle for the existing IV16/tag16 on-disk format. */
export function decryptFixtureFile(bytes: Buffer, exactKey: string): Buffer {
  const key = Buffer.from(exactKey, 'hex');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 16));
    decipher.setAuthTag(bytes.subarray(16, 32));
    return Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]);
  } finally { key.fill(0); }
}

export async function recoveryFixture(registry: PortableSchemaRegistry, exactKey: string) {
  const rows: Record<string, Record<string, PortableScalar>[]> = {};
  for (const model of registry.models) {
    const row: Record<string, PortableScalar> = {};
    for (const field of model.fields) {
      row[field.name] = field.nullable ? null : field.type === 'String' ? `${model.name}-${field.name} café\nline 2` :
        field.type === 'DateTime' ? exportedAt : field.type === 'Boolean' ? false :
          field.type === 'Int' ? 0 : field.type === 'Float' ? 1.25 : field.enumValues![0];
    }
    if (Object.hasOwn(row, 'id')) row.id = `synthetic-${model.name}`;
    rows[model.name] = [row];
  }
  // Deliberately include nullable cycles and the Feedback self-FK; none are inferred on restore.
  for (const model of registry.models) for (const fk of model.foreignKeys) {
    fk.fields.forEach((field, index) => { rows[model.name][0][field] = rows[fk.referencedModel][0][fk.referencedFields[index]]; });
  }
  rows.Family[0].slug = 'synthetic-recovery-family';
  rows.Family[0].isActive = true; rows.Family[0].setupStage = 3;
  rows.Caretaker[0].loginId = '11'; rows.Caretaker[0].securityPin = '241357'; rows.Caretaker[0].role = 'ADMIN';
  rows.Settings[0].authType = 'CARETAKER';
  rows.AppConfig[0].enablePhotos = true;
  rows.Family.push({ ...rows.Family[0], id: 'synthetic-foreign-Family', slug: 'synthetic-recovery-foreign', accountId: null });
  rows.Caretaker.push({ ...rows.Caretaker[0], id: 'synthetic-foreign-Caretaker', familyId: 'synthetic-foreign-Family', accountId: null,
    loginId: '22', securityPin: '864209' });
  rows.Settings.push({ ...rows.Settings[0], id: 'synthetic-foreign-Settings', familyId: 'synthetic-foreign-Family' });
  rows.Baby[0].gestationalAgeDays = 224;
  rows.DiaperLog[0].rashObserved = null;
  rows.DiaperLog[0].rashDescription = 'Synthetic observation only';
  rows.Milestone[0].photo = null;
  rows.PhotoFavorite[0].accountId = rows.Account[0].id;
  rows.PhotoFavorite[0].caretakerId = rows.Caretaker[0].id;
  rows.FeedLog[0].sourcePumpId = rows.PumpLog[0].id;
  rows.PhotoLink[0].activityType = 'diaper'; rows.PhotoLink[0].activityId = rows.DiaperLog[0].id;
  rows.PhotoLink.push({ ...rows.PhotoLink[0], id: 'synthetic-hidden-photo-link', activityType: 'unsupported-historical-target', activityId: 'unresolved-historical-target' });
  rows.Photo.push({ ...rows.Photo[0], id: 'synthetic-trashed-photo', deletedAt: '2026-11-01T01:02:03.456Z', caption: 'Preserved synthetic trash' });

  const files = new Map<string, { ciphertext: Buffer; plaintext: Buffer }>();
  let color = 0;
  const media = async (storagePath: string) => {
    color += 1;
    const plaintext = await sharp({ create: { width: 3, height: 2, channels: 3, background: { r: 17 * color, g: 140, b: 90 } } }).png().toBuffer();
    const iv = randomBytes(16), key = Buffer.from(exactKey, 'hex');
    try {
      const encrypted = seal(plaintext, key, iv);
      files.set(storagePath, { plaintext, ciphertext: Buffer.concat([iv, encrypted.tag, encrypted.bytes]) });
    } finally { key.fill(0); }
    return plaintext;
  };
  for (const photo of rows.Photo) {
    photo.mimeType = 'image/png'; photo.originalName = 'synthetic.png';
    photo.storedName = randomUUID() + '.enc'; photo.thumbStoredName = randomUUID() + '.enc';
    photo.fileSize = (await media(`photos/${photo.familyId}/${photo.storedName}`)).length;
    photo.thumbSize = (await media(`photos/${photo.familyId}/${photo.thumbStoredName}`)).length;
  }
  for (const [model, prefix] of [['VaccineDocument', ''], ['FeedbackAttachment', 'feedback/']] as const) {
    const row = rows[model][0]; row.storedName = randomUUID() + '.enc'; row.mimeType = 'image/png'; row.originalName = 'synthetic.png';
    row.fileSize = (await media(prefix + row.storedName)).length;
  }
  const ocrTemplate = rows.OcrDocument[0], auditTemplate = rows.OcrAudit[0];
  rows.OcrDocument = []; rows.OcrAudit = [];
  const ocrIds: Record<string, string> = {};
  for (const [label, expiry, purged] of [
    ['retained', '2026-11-22T01:02:03.456Z', false],
    ['transit-expired', '2026-11-20T01:32:03.456Z', false],
    ['already-expired', '2026-11-19T01:02:03.456Z', false],
    ['purged', '2026-11-18T01:02:03.456Z', true],
  ] as const) {
    const id = randomUUID(), family = String(rows.Family[0].id); ocrIds[label] = id;
    const sourceFile = randomUUID() + '.enc', previewFile = randomUUID() + '.enc';
    const source = purged ? Buffer.from('synthetic purged content') : await media('ocr/' + sourceFile);
    if (!purged) await media('ocr/' + previewFile);
    rows.OcrDocument.push({ ...ocrTemplate, id, familyId: family, babyId: rows.Baby[0].id, mimeType: 'image/png', originalName: 'synthetic.png',
      byteSize: source.length, sourceHash: sha256(source), sourceFile: purged ? null : sourceFile,
      previewFiles: JSON.stringify(purged ? [] : [{ page: 1, file: previewFile }]), pageCount: 1,
      sourceExpiresAt: expiry, purgedAt: purged ? '2026-11-19T01:02:03.456Z' : null,
      originalState: sealState({ synthetic: label, rows: [] }, `${family}:${id}:original`, exactKey),
      reviewState: sealState({ synthetic: label, rows: [], edited: false }, `${family}:${id}:review`, exactKey) });
    rows.OcrAudit.push({ ...auditTemplate, id: `synthetic-audit-${label}`, documentId: id,
      snapshot: sealState({ synthetic: label, event: 'created' }, `${family}:${id}:audit`, exactKey) });
  }
  for (const [model, fields] of Object.entries({ AppConfig: ['adminPass'], EmailConfig: ['sendGridApiKey', 'smtp2goApiKey', 'password'], NotificationConfig: ['vapidPrivateKey'] })) {
    for (const field of fields) rows[model][0][field] = sealSetting(`synthetic-only-${model}-${field}`, exactKey);
  }
  const metadata = (provider: PortableProvider) => createPortableMetadata(registry, { provider, exportedAt }, rows);
  return { files, metadata, ocrIds };
}
