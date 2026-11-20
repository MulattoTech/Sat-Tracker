import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { authenticateFileCiphertext, assertSourceKey } from './crypto';
import {
  mediaRows, PortableMediaError, portableLimits, requiredString,
  type MediaInventory, type MediaInventoryEntry, type MediaMetadata, type MediaOmission,
  type MediaReference, type PortableLimits, type VerifiedMedia,
} from './media-types';

/** Portable names are unchanged ASCII; Windows aliases and Unicode ambiguity fail closed. */
export function assertPortablePath(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > 512 || value !== value.normalize('NFC')
    || value.split('/').some(segment => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment)
      || segment.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
    throw new PortableMediaError('UNSAFE_MEDIA_PATH', 'A media/archive path is unsafe or not portable; no path is normalized or repaired.');
  }
}
export function canonicalMediaPath(value: string): string {
  assertPortablePath(value);
  if (!/^(?:photos\/[A-Za-z0-9][A-Za-z0-9._-]*\/|feedback\/|ocr\/)?[^/]+\.enc$/i.test(value)) {
    throw new PortableMediaError('UNSUPPORTED_MEDIA_PATH', 'A file reference does not use a supported encrypted-media storage location.');
  }
  return value;
}
function storedName(value: unknown, label: string): string {
  const name = requiredString(value, label); assertPortablePath(name);
  if (name.includes('/') || !name.endsWith('.enc')) throw new PortableMediaError('INVALID_MEDIA_REFERENCE', `Invalid encrypted stored name in ${label}.`);
  return name;
}
function instant(value: unknown, label: string): string {
  const text = requiredString(value, label);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) throw new PortableMediaError('INVALID_RETENTION_TIME', `Invalid ${label}.`);
  return text;
}
function length(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new PortableMediaError('INVALID_MEDIA_SIZE', `Invalid ${label}.`);
  return value as number;
}
function indexed(metadata: MediaMetadata, model: string) {
  const result = new Map<string, Readonly<Record<string, unknown>>>();
  for (const row of mediaRows(metadata, model)) {
    const id = requiredString(row.id, `${model}.id`);
    if (result.has(id)) throw new PortableMediaError('DUPLICATE_MEDIA_RECORD', `Duplicate ${model} record ID.`);
    result.set(id, row);
  }
  return result;
}

/** Derives references from metadata only. Never scans for or attaches orphan files. */
export function inventoryReferencedMedia(metadata: MediaMetadata, now = new Date()): MediaInventory {
  if (!Number.isFinite(now.getTime())) throw new PortableMediaError('INVALID_RETENTION_TIME', 'A valid recovery time is required.');
  const families = indexed(metadata, 'Family'), babies = indexed(metadata, 'Baby');
  const vaccines = indexed(metadata, 'VaccineLog'), feedback = indexed(metadata, 'Feedback');
  const entries: MediaInventoryEntry[] = [], omissions: MediaOmission[] = [];
  const claimed = new Set<string>();
  const claim = (storagePath: string, reference: MediaReference, include: boolean) => {
    canonicalMediaPath(storagePath);
    const folded = storagePath.normalize('NFC').toLowerCase();
    if (claimed.has(folded)) throw new PortableMediaError('MEDIA_PATH_COLLISION', 'Multiple media references collide on the same portable storage path; inspect the source without automatic repair.');
    claimed.add(folded);
    if (include) entries.push({ storagePath, references: [reference] });
  };
  for (const row of mediaRows(metadata, 'Milestone')) {
    if (row.photo !== null && row.photo !== '') throw new PortableMediaError('UNSUPPORTED_LEGACY_MEDIA_REFERENCE', 'Milestone.photo contains a legacy reference without a supported storage mapping; inspect it before declaring recovery complete.');
  }
  for (const row of mediaRows(metadata, 'Photo')) {
    const id = requiredString(row.id, 'Photo.id'), family = requiredString(row.familyId, 'Photo.familyId');
    assertPortablePath(family);
    if (family.includes('/') || !families.has(family) || babies.get(requiredString(row.babyId, 'Photo.babyId'))?.familyId !== family) {
      throw new PortableMediaError('INVALID_MEDIA_OWNERSHIP', 'A Photo has an unresolved or mismatched family/child storage namespace; inspect its metadata without automatic repair.');
    }
    // Keep deletedAt and all target links unchanged. Even purge-eligible rows still
    // present in the source retain their bytes; their eligibility is not extended.
    for (const [field, size, role] of [['storedName', 'fileSize', 'photo-display'], ['thumbStoredName', 'thumbSize', 'photo-thumbnail']] as const) {
      claim(`photos/${family}/${storedName(row[field], `Photo.${field}`)}`, { model: 'Photo', recordId: id, field, role, plaintextBytes: length(row[size], `Photo.${size}`) }, true);
    }
  }
  for (const [model, parent, parents, prefix, role] of [
    ['VaccineDocument', 'vaccineLogId', vaccines, '', 'vaccine-document'],
    ['FeedbackAttachment', 'feedbackId', feedback, 'feedback/', 'feedback-attachment'],
  ] as const) {
    for (const row of mediaRows(metadata, model)) {
      if (!parents.has(requiredString(row[parent], `${model}.${parent}`))) throw new PortableMediaError('MISSING_MEDIA_PARENT', `${model} references a missing parent.`);
      claim(prefix + storedName(row.storedName, `${model}.storedName`), { model, recordId: requiredString(row.id, `${model}.id`), field: 'storedName', role, plaintextBytes: length(row.fileSize, `${model}.fileSize`) }, true);
    }
  }
  for (const row of mediaRows(metadata, 'OcrDocument')) {
    const id = requiredString(row.id, 'OcrDocument.id'), expires = instant(row.sourceExpiresAt, 'OcrDocument.sourceExpiresAt');
    if (row.purgedAt !== null) instant(row.purgedAt, 'OcrDocument.purgedAt');
    const reason = row.purgedAt !== null ? 'ocr-purged' : new Date(expires) <= now ? 'ocr-expired' : null;
    let previews: unknown;
    try { previews = JSON.parse(requiredString(row.previewFiles, 'OcrDocument.previewFiles')); }
    catch { throw new PortableMediaError('INVALID_OCR_REFERENCES', 'OCR preview references are invalid; inspect the source metadata.'); }
    if (!Array.isArray(previews)) throw new PortableMediaError('INVALID_OCR_REFERENCES', 'OCR preview references must be an array.');
    const paths: string[] = [], pages = new Set<number>();
    const add = (name: unknown, field: string, role: 'ocr-source' | 'ocr-preview', extra: Partial<MediaReference> = {}) => {
      const file = storedName(name, `OcrDocument.${field}`);
      if (!/^[a-f\d-]{36}\.enc$/i.test(file)) throw new PortableMediaError('INVALID_OCR_REFERENCES', 'An OCR source filename does not match the existing encrypted storage format.');
      const storagePath = `ocr/${file}`; paths.push(storagePath);
      claim(storagePath, { model: 'OcrDocument', recordId: id, field, role, sourceExpiresAt: expires, ...extra }, !reason);
    };
    if (row.sourceFile !== null) {
      const hash = requiredString(row.sourceHash, 'OcrDocument.sourceHash');
      if (!/^[a-f\d]{64}$/.test(hash)) throw new PortableMediaError('INVALID_OCR_REFERENCES', 'An OCR source hash is invalid.');
      add(row.sourceFile, 'sourceFile', 'ocr-source', { plaintextBytes: length(row.byteSize, 'OcrDocument.byteSize'), plaintextSha256: hash });
    } else if (!reason) throw new PortableMediaError('MISSING_OCR_SOURCE', 'A retained OCR document has no source reference; recovery cannot claim complete media.');
    previews.forEach((preview, index) => {
      if (!preview || typeof preview !== 'object' || Array.isArray(preview) || !Number.isInteger(preview.page) || preview.page < 1 || pages.has(preview.page)) {
        throw new PortableMediaError('INVALID_OCR_REFERENCES', 'OCR preview pages must be distinct positive page numbers.');
      }
      pages.add(preview.page); add(preview.file, `previewFiles[${index}].file`, 'ocr-preview');
    });
    if (!reason && previews.length !== length(row.pageCount, 'OcrDocument.pageCount')) throw new PortableMediaError('INVALID_OCR_REFERENCES', 'A retained OCR document is missing declared preview references.');
    if (reason) omissions.push({ model: 'OcrDocument', recordId: id, reason, sourceExpiresAt: expires, storagePaths: paths.sort() });
  }
  return { entries: entries.sort((a, b) => a.storagePath < b.storagePath ? -1 : 1), omissions: omissions.sort((a, b) => a.recordId < b.recordId ? -1 : 1) };
}

export function authenticateMedia(bytes: Buffer, entry: MediaInventoryEntry, exactKey: string): void {
  if (!Array.isArray(entry.references) || entry.references.length === 0) throw new PortableMediaError('INVALID_MEDIA_REFERENCE', 'Encrypted media must have an explicit original reference.');
  for (const ref of entry.references) authenticateFileCiphertext(bytes, exactKey, { byteLength: ref.plaintextBytes, sha256: ref.plaintextSha256 });
}

/** Bounded read from operator-supplied roots. Every path component is checked;
 * file identity/size/times must remain stable during the read. No destination IO. */
export async function readReferencedMedia(
  inventory: MediaInventory, roots: { filesRoot: string; ocrRoot?: string }, exactKey: string,
  lowerLimits: Partial<PortableLimits> = {},
): Promise<VerifiedMedia[]> {
  assertSourceKey(exactKey); const limits = portableLimits(lowerLimits);
  if (inventory.entries.length > limits.mediaEntries) throw new PortableMediaError('ARCHIVE_LIMIT', 'The referenced media count exceeds the portable recovery limit.');
  const output: VerifiedMedia[] = []; let total = 0;
  for (const entry of inventory.entries) {
    canonicalMediaPath(entry.storagePath);
    const override = entry.storagePath.startsWith('ocr/') && roots.ocrRoot;
    const root = path.resolve(override || roots.filesRoot), segments = (override ? entry.storagePath.slice(4) : entry.storagePath).split('/');
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new PortableMediaError('UNSAFE_MEDIA_PATH', 'The selected media root must be a real directory.');
    const canonicalRoot = await realpath(root);
    let current = canonicalRoot;
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      const info = await lstat(current).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new PortableMediaError('MISSING_MEDIA_FILE', 'A required referenced encrypted file is missing; recovery cannot claim complete media.'); throw error; });
      if (info.isSymbolicLink() || (index < segments.length - 1 ? !info.isDirectory() : !info.isFile())) {
        throw new PortableMediaError('UNSAFE_MEDIA_PATH', 'Referenced media must contain only real directories and regular files, without symlinks.');
      }
    }
    const before = await lstat(current);
    if (before.size < 32 || before.size > limits.entryBytes || total + before.size > limits.expandedBytes) throw new PortableMediaError('ARCHIVE_LIMIT', 'Referenced encrypted media exceeds the portable recovery byte limit or is truncated.');
    const handle = await open(current, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new PortableMediaError('MEDIA_CHANGED_DURING_READ', 'Referenced media changed during recovery preflight.');
      const bounded = Buffer.alloc(before.size + 1); let offset = 0;
      while (offset < bounded.length) {
        const result = await handle.read(bounded, offset, bounded.length - offset, offset);
        if (!result.bytesRead) break; offset += result.bytesRead;
      }
      const after = await handle.stat(), linked = await lstat(current);
      if (offset !== before.size || linked.isSymbolicLink() || linked.dev !== before.dev || linked.ino !== before.ino
        || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || await realpath(current) !== path.join(canonicalRoot, ...segments)) {
        throw new PortableMediaError('MEDIA_CHANGED_DURING_READ', 'Referenced media changed during recovery preflight.');
      }
      bytes = bounded.subarray(0, offset);
    } finally { await handle.close(); }
    authenticateMedia(bytes, entry, exactKey); total += bytes.length;
    output.push({ ...entry, ciphertext: bytes, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return output;
}
