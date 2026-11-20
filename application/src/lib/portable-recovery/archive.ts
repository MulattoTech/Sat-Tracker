import { createHash, randomUUID } from 'node:crypto';
import { crc32, inflateRawSync } from 'node:zlib';
import JSZip from 'jszip';
import { portableTableHash, type PortableMetadataV1 } from './metadata-codec';
import { assertSourceKey, createKeyProof, verifyKeyProof, verifyEncryptedMetadata, type PortableKeyProof } from './crypto';
import { assertPortablePath, authenticateMedia, inventoryReferencedMedia } from './media-inventory';
import { canonicalJson, PortableMediaError, portableLimits, type MediaInventory, type MediaOmission, type PortableLimits, type VerifiedMedia } from './media-types';
export { PORTABLE_LIMITS, PortableMediaError } from './media-types';
export const MAX_PORTABLE_ARCHIVE_BYTES = 512 * 1024 * 1024;

const FORMAT = 'sat-tracker.portable-recovery';
const SCOPE = 'complete-application-metadata-and-referenced-encrypted-media';
const EXCLUSIONS = Object.freeze({ separateApiLogDatabase: true, diagnosticApiLogs: 'separate-or-colocated', environment: true, sourceEncryptionKey: true, unreferencedFiles: true, applicationAndModelAssets: true });
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
// Reject disclosures of the raw file key in any case, including JSON escapes.
// Cryptographic derivation/authentication always uses the original exact text.
const containsSourceKey = (metadata: PortableMetadataV1, exactKey: string) => new RegExp(exactKey, 'i').test(JSON.stringify(metadata));
function invalid(message: string): never { throw new PortableMediaError('INVALID_ARCHIVE', message); }
function limit(message: string): never { throw new PortableMediaError('ARCHIVE_LIMIT', message); }
function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }

/** Strict ZIP32 reader; deliberately no JSZip load/extraction. JSZip normalizes
 * paths and merges duplicate names, which would discard preflight evidence. */
export function readBoundedZip(
  archive: Buffer, lowerLimits: Partial<PortableLimits> = {}, allowedPath?: (name: string) => boolean,
): ReadonlyMap<string, Buffer> {
  const limits = portableLimits(lowerLimits);
  if (!Buffer.isBuffer(archive) || archive.length > limits.archiveBytes) limit('The portable archive exceeds its byte limit.');
  const end = archive.length - 22;
  if (end < 0 || archive.readUInt32LE(end) !== 0x06054b50 || archive.readUInt16LE(end + 20) !== 0) invalid('A complete ZIP32 archive without a trailing comment is required.');
  const count = archive.readUInt16LE(end + 10), centralBytes = archive.readUInt32LE(end + 12), centralStart = archive.readUInt32LE(end + 16);
  if (archive.readUInt16LE(end + 4) !== 0 || archive.readUInt16LE(end + 6) !== 0 || archive.readUInt16LE(end + 8) !== count
    || count === 0xffff || centralBytes === 0xffffffff || centralStart === 0xffffffff || centralStart + centralBytes !== end) invalid('Split, ZIP64 or inconsistent archives are not supported.');
  if (count > limits.mediaEntries + 2) limit('The portable archive contains too many entries.');
  const descriptors: { name: string; start: number; end: number; dataStart: number; compressed: number; expanded: number; method: number; crc: number }[] = [];
  const names = new Set<string>(); let cursor = centralStart, expandedTotal = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50) invalid('The ZIP central directory is truncated or invalid.');
    const madeBy = archive.readUInt16LE(cursor + 4), needed = archive.readUInt16LE(cursor + 6), flags = archive.readUInt16LE(cursor + 8), method = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16), compressed = archive.readUInt32LE(cursor + 20), expanded = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28), extra = archive.readUInt16LE(cursor + 30), comment = archive.readUInt16LE(cursor + 32);
    const attributes = archive.readUInt32LE(cursor + 38), start = archive.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameLength + extra + comment > end || !nameLength || nameLength > 512) invalid('A ZIP entry name is invalid.');
    const nameBytes = archive.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBytes.toString('ascii');
    if (!Buffer.from(name, 'ascii').equals(nameBytes)) invalid('Archive paths must use the supported portable ASCII form.');
    assertPortablePath(name);
    const folded = name.normalize('NFC').toLowerCase();
    if (names.has(folded)) invalid('Duplicate or case-colliding archive paths are not allowed.'); names.add(folded);
    if (allowedPath && !allowedPath(name)) invalid('The archive contains an undeclared or unsupported entry.');
    const mode = (attributes >>> 16) & 0xf000;
    if (![0, 3].includes(madeBy >>> 8) || needed > 20 || (flags & ~0x800) !== 0 || ![0, 8].includes(method)
      || extra || comment || archive.readUInt16LE(cursor + 34) !== 0 || (attributes & 0x10) !== 0 || ![0, 0x8000].includes(mode)
      || [compressed, expanded, start].includes(0xffffffff)) invalid('Encrypted, linked, directory, extended or unsupported ZIP entries are not allowed.');
    const entryLimit = name === 'metadata.json' ? Math.min(limits.entryBytes, limits.metadataBytes) : name === 'manifest.json' ? Math.min(limits.entryBytes, limits.manifestBytes) : limits.entryBytes;
    expandedTotal += expanded;
    if (expanded > entryLimit || expandedTotal > limits.expandedBytes) limit('The archive declared expansion exceeds its bounded limit.');
    if (start + 30 > centralStart || archive.readUInt32LE(start) !== 0x04034b50) invalid('A ZIP local file header is missing or overlaps the directory.');
    const localNameLength = archive.readUInt16LE(start + 26), localExtra = archive.readUInt16LE(start + 28), dataStart = start + 30 + localNameLength + localExtra;
    const dataEnd = dataStart + compressed;
    if (dataEnd > centralStart || localExtra || localNameLength !== nameLength
      || archive.readUInt16LE(start + 4) !== needed || archive.readUInt16LE(start + 6) !== flags || archive.readUInt16LE(start + 8) !== method
      || archive.readUInt16LE(start + 10) !== archive.readUInt16LE(cursor + 12) || archive.readUInt16LE(start + 12) !== archive.readUInt16LE(cursor + 14)
      || archive.readUInt32LE(start + 14) !== crc || archive.readUInt32LE(start + 18) !== compressed || archive.readUInt32LE(start + 22) !== expanded
      || !archive.subarray(start + 30, start + 30 + localNameLength).equals(nameBytes)) invalid('ZIP local and central headers disagree.');
    if (method === 0 && compressed !== expanded) invalid('An uncompressed ZIP entry has inconsistent lengths.');
    descriptors.push({ name, start, end: dataEnd, dataStart, compressed, expanded, method, crc });
    cursor += 46 + nameLength + extra + comment;
  }
  if (cursor !== end) invalid('The ZIP central directory count or length is inconsistent.');
  let next = 0;
  for (const descriptor of [...descriptors].sort((a, b) => a.start - b.start)) {
    if (descriptor.start !== next) invalid('ZIP members overlap or contain undeclared data between entries.'); next = descriptor.end;
  }
  if (next !== centralStart) invalid('ZIP data contains an undeclared prefix or suffix.');
  const output = new Map<string, Buffer>();
  for (const descriptor of descriptors) {
    const compressed = archive.subarray(descriptor.dataStart, descriptor.end); let bytes: Buffer;
    try {
      if (descriptor.method === 0) bytes = Buffer.from(compressed);
      else {
        // Node 22 supports bounded inflation and the consumed-input diagnostic.
        const result = inflateRawSync(compressed, { maxOutputLength: Math.max(1, descriptor.expanded), info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
        if (result.engine.bytesWritten !== compressed.length) invalid('A compressed ZIP entry contains trailing data.'); bytes = result.buffer;
      }
    } catch (error) {
      if (error instanceof PortableMediaError) throw error;
      invalid('A ZIP entry is corrupt or exceeds its declared bounded expansion.');
    }
    if (bytes.length !== descriptor.expanded || crc32(bytes) !== descriptor.crc) invalid('A ZIP entry failed its exact length or CRC check.');
    output.set(descriptor.name, bytes);
  }
  return output;
}

function json(bytes: Buffer): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { return invalid('An archive JSON document is invalid UTF-8 or JSON.'); }
}
/** Full schema/dependency validation remains mandatory in the root orchestrator.
 * This layer independently checks every value it uses before file/key operations. */
function metadataShape(value: unknown): PortableMetadataV1 {
  if (!plain(value) || value.format !== 'sat-tracker.application-metadata' || value.version !== 1
    || !plain(value.source) || !['sqlite', 'postgresql'].includes(String(value.source.provider))
    || typeof value.source.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.source.exportedAt)) || new Date(value.source.exportedAt).toISOString() !== value.source.exportedAt
    || !plain(value.schema) || typeof value.schema.fingerprint !== 'string' || !/^sha256:[a-f\d]{64}$/.test(value.schema.fingerprint)
    || !Array.isArray(value.schema.models) || !plain(value.tables)) invalid('The portable application metadata envelope is invalid.');
  for (const [name, table] of Object.entries(value.tables)) {
    if (!/^[A-Z][A-Za-z0-9]+$/.test(name) || !plain(table) || !Array.isArray(table.rows) || table.rowCount !== table.rows.length
      || table.rows.some(row => !plain(row) || Object.values(row).some(cell => cell !== null && !['string', 'number', 'boolean'].includes(typeof cell)))) invalid('A portable metadata table or scalar row is invalid.');
  }
  const models = new Set<string>();
  for (const model of value.schema.models) {
    if (!plain(model) || typeof model.name !== 'string' || models.has(model.name) || !Array.isArray(model.primaryKey)
      || !model.primaryKey.length || model.primaryKey.some(field => typeof field !== 'string')) invalid('The declared metadata model identities are invalid.');
    models.add(model.name);
  }
  if (models.size !== Object.keys(value.tables).length || [...models].some(name => !Object.hasOwn(value.tables as object, name))) invalid('Every declared application model must have a table entry, including empty models.');
  return value as unknown as PortableMetadataV1;
}

interface ManifestMedia {
  readonly path: string; readonly storagePath: string; readonly references: VerifiedMedia['references'];
  readonly encryption: 'aes-256-gcm-iv16-tag16-v1'; readonly byteLength: number; readonly sha256: string;
}
export interface PortableArchiveManifest {
  readonly format: typeof FORMAT; readonly version: 1; readonly exportId: string; readonly sourceRevision: string;
  readonly exportedAt: string; readonly sourceProvider: 'sqlite' | 'postgresql'; readonly scope: typeof SCOPE;
  readonly schema: PortableMetadataV1['schema'];
  readonly metadata: { readonly path: 'metadata.json'; readonly byteLength: number; readonly sha256: string };
  readonly tables: readonly { readonly name: string; readonly rowCount: number; readonly sha256: string }[];
  readonly media: readonly ManifestMedia[]; readonly omissions: readonly MediaOmission[];
  readonly exclusions: typeof EXCLUSIONS; readonly keyProof: PortableKeyProof;
}
function descriptor(metadata: PortableMetadataV1, metadataBytes: Buffer, media: readonly VerifiedMedia[], inventory: MediaInventory, sourceRevision: string, exportId: string): Omit<PortableArchiveManifest, 'keyProof'> {
  if (!/^[a-f\d]{40}$/.test(sourceRevision) || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/.test(exportId)) invalid('An exact source revision and export UUID are required.');
  return { format: FORMAT, version: 1, exportId, sourceRevision, exportedAt: metadata.source.exportedAt, sourceProvider: metadata.source.provider,
    scope: SCOPE, schema: metadata.schema, metadata: { path: 'metadata.json', byteLength: metadataBytes.length, sha256: hash(metadataBytes) },
    tables: Object.keys(metadata.tables).sort().map(name => {
      const model = metadata.schema.models.find(item => item.name === name);
      if (!model) invalid('A table is missing from the declared application schema.');
      return { name, rowCount: metadata.tables[name].rowCount, sha256: portableTableHash(model, metadata.tables[name].rows) };
    }),
    media: media.map(file => ({ path: 'media/' + file.storagePath, storagePath: file.storagePath, references: file.references, encryption: 'aes-256-gcm-iv16-tag16-v1', byteLength: file.byteLength, sha256: file.sha256 })),
    omissions: inventory.omissions, exclusions: EXCLUSIONS };
}
function mediaFromEntries(inventory: MediaInventory, files: ReadonlyMap<string, Buffer>, limits: PortableLimits): VerifiedMedia[] {
  if (inventory.entries.length > limits.mediaEntries) limit('The media inventory exceeds the portable archive entry limit.');
  let total = 0;
  return inventory.entries.map(entry => {
    const ciphertext = files.get('media/' + entry.storagePath);
    if (!ciphertext) invalid('A required referenced encrypted-media member is missing.');
    total += ciphertext.length;
    if (ciphertext.length > limits.entryBytes || total > limits.expandedBytes) limit('Encrypted media exceeds the portable archive byte limit.');
    return { ...entry, ciphertext, byteLength: ciphertext.length, sha256: hash(ciphertext) };
  });
}

export async function createPortableArchive(input: {
  metadata: PortableMetadataV1; media: readonly VerifiedMedia[]; omissions: readonly MediaOmission[]; sourceRevision: string;
}, exactSourceKey: string, lowerLimits: Partial<PortableLimits> = {}): Promise<Buffer> {
  assertSourceKey(exactSourceKey); const limits = portableLimits(lowerLimits);
  const metadataBytes = Buffer.from(JSON.stringify(input.metadata), 'utf8');
  if (metadataBytes.length > Math.min(limits.metadataBytes, limits.entryBytes)) limit('Application metadata exceeds the portable archive limit.');
  const metadata = metadataShape(json(metadataBytes));
  if (containsSourceKey(metadata, exactSourceKey)) throw new PortableMediaError('SOURCE_KEY_IN_METADATA', 'The source encryption key appears in persisted metadata; do not embed it in a portable archive.');
  const inventory = inventoryReferencedMedia(metadata, new Date(metadata.source.exportedAt));
  if (canonicalJson(input.omissions) !== canonicalJson(inventory.omissions)) invalid('Media retention omissions do not match the original metadata.');
  const files = new Map<string, Buffer>();
  if (input.media.length > limits.mediaEntries) limit('The supplied media count exceeds the portable archive limit.');
  let suppliedBytes = 0;
  for (const file of input.media) {
    const name = 'media/' + file.storagePath; assertPortablePath(name);
    if (files.has(name) || !Buffer.isBuffer(file.ciphertext)) invalid('A supplied encrypted-media member is duplicate or inconsistent.');
    suppliedBytes += file.ciphertext.length;
    if (file.ciphertext.length > limits.entryBytes || suppliedBytes > limits.expandedBytes) limit('Supplied encrypted media exceeds the portable byte limit.');
    if (file.byteLength !== file.ciphertext.length || file.sha256 !== hash(file.ciphertext)) invalid('A supplied encrypted-media member is inconsistent.');
    files.set(name, Buffer.from(file.ciphertext));
  }
  const media = mediaFromEntries(inventory, files, limits);
  const byPath = new Map(media.map(file => [file.storagePath, file]));
  if (files.size !== media.length || input.media.some(file => !byPath.has(file.storagePath) || canonicalJson(file.references) !== canonicalJson(byPath.get(file.storagePath)!.references))) invalid('Supplied media contains undeclared or mismatched references.');
  verifyEncryptedMetadata(metadata, exactSourceKey);
  for (const file of media) authenticateMedia(file.ciphertext, file, exactSourceKey);
  const details = descriptor(metadata, metadataBytes, media, inventory, input.sourceRevision, randomUUID());
  const manifest: PortableArchiveManifest = { ...details, keyProof: createKeyProof(details, exactSourceKey) };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  if (manifestBytes.length > Math.min(limits.manifestBytes, limits.entryBytes)) limit('The portable archive manifest exceeds its limit.');
  files.set('metadata.json', metadataBytes); files.set('manifest.json', manifestBytes);
  const expanded = [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0);
  const storedSize = expanded + [...files.keys()].reduce((sum, name) => sum + 76 + 2 * Buffer.byteLength(name), 22);
  if (expanded > limits.expandedBytes || storedSize > limits.archiveBytes) limit('The complete archive exceeds its bounded size; no partial archive is produced.');
  const zip = new JSZip();
  for (const [name, bytes] of files) zip.file(name, bytes, { binary: true, createFolders: false, compression: 'STORE', unixPermissions: 0o100600, date: new Date('1980-01-02T00:00:00.000Z') });
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE', platform: 'UNIX', streamFiles: false });
  if (bytes.length > limits.archiveBytes) limit('The complete archive exceeds its bounded size.');
  return bytes;
}

export function preflightPortableArchive(archive: Buffer, exactSourceKey: string, options: { now?: Date; limits?: Partial<PortableLimits> } = {}): {
  manifest: PortableArchiveManifest; metadata: PortableMetadataV1; media: readonly VerifiedMedia[];
  mediaToRestore: readonly VerifiedMedia[]; omissions: readonly MediaOmission[];
  encryption: ReturnType<typeof verifyEncryptedMetadata>;
} {
  assertSourceKey(exactSourceKey); const limits = portableLimits(options.limits), now = options.now ?? new Date();
  const files = readBoundedZip(archive, options.limits, name => name === 'manifest.json' || name === 'metadata.json' || name.startsWith('media/'));
  const metadataBytes = files.get('metadata.json'), manifestBytes = files.get('manifest.json');
  if (!metadataBytes || !manifestBytes) invalid('A versioned portable archive requires manifest.json and metadata.json.');
  const metadata = metadataShape(json(metadataBytes)), manifestValue = json(manifestBytes);
  if (!plain(manifestValue) || manifestValue.format !== FORMAT || manifestValue.version !== 1 || typeof manifestValue.sourceRevision !== 'string' || typeof manifestValue.exportId !== 'string') invalid('The portable recovery manifest format or version is unsupported.');
  if (containsSourceKey(metadata, exactSourceKey)) throw new PortableMediaError('SOURCE_KEY_IN_METADATA', 'The source encryption key must be supplied separately from metadata.');
  const inventory = inventoryReferencedMedia(metadata, new Date(metadata.source.exportedAt)), media = mediaFromEntries(inventory, files, limits);
  if (files.size !== media.length + 2) invalid('The archive contains undeclared media or additional files.');
  const expected = descriptor(metadata, metadataBytes, media, inventory, manifestValue.sourceRevision, manifestValue.exportId);
  const { keyProof, ...received } = manifestValue;
  if (canonicalJson(received) !== canonicalJson(expected)) invalid('The manifest schema, counts, references, sizes or checksums do not match the archive.');
  verifyKeyProof(expected, keyProof, exactSourceKey);
  const encryption = verifyEncryptedMetadata(metadata, exactSourceKey);
  // Authenticate every included cipher, even if its retention expires during transit.
  for (const file of media) authenticateMedia(file.ciphertext, file, exactSourceKey);
  const current = inventoryReferencedMedia(metadata, now), retained = new Set(current.entries.map(entry => entry.storagePath));
  const included = new Set(media.map(file => file.storagePath));
  if (current.entries.some(entry => !included.has(entry.storagePath))) {
    throw new PortableMediaError('RETENTION_CLOCK_MISMATCH', 'A currently retained OCR file was omitted by the source clock; synchronize clocks and create a new complete backup.');
  }
  const omissions = new Map([...inventory.omissions, ...current.omissions].map(item => [item.recordId, item]));
  return { manifest: { ...expected, keyProof: keyProof as PortableKeyProof }, metadata, media,
    mediaToRestore: media.filter(file => retained.has(file.storagePath)), omissions: [...omissions.values()], encryption };
}
