/** Errors contain codes and record identifiers, never plaintext or source keys. */
export class PortableMediaError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'PortableMediaError'; }
}

export interface PortableLimits {
  readonly archiveBytes: number; readonly expandedBytes: number; readonly entryBytes: number;
  readonly metadataBytes: number; readonly manifestBytes: number; readonly mediaEntries: number;
}
export const PORTABLE_LIMITS: PortableLimits = Object.freeze({
  archiveBytes: 512 * 1024 * 1024,
  expandedBytes: 512 * 1024 * 1024,
  entryBytes: 64 * 1024 * 1024,
  metadataBytes: 32 * 1024 * 1024,
  manifestBytes: 8 * 1024 * 1024,
  mediaEntries: 20_000,
});
/** Callers/tests may lower limits; no override may raise the approved ceiling. */
export function portableLimits(lower: Partial<PortableLimits> = {}): PortableLimits {
  const value = { ...PORTABLE_LIMITS };
  for (const [key, limit] of Object.entries(lower)) {
    if (!(key in value) || !Number.isSafeInteger(limit) || limit! < 1 || limit! > value[key as keyof PortableLimits]) {
      throw new PortableMediaError('INVALID_LIMIT', 'Portable recovery limits may only be lowered.');
    }
    value[key as keyof PortableLimits] = limit!;
  }
  return Object.freeze(value);
}

export type MediaRole = 'photo-display' | 'photo-thumbnail' | 'vaccine-document' | 'feedback-attachment' | 'ocr-source' | 'ocr-preview';
export interface MediaReference {
  readonly model: 'Photo' | 'VaccineDocument' | 'FeedbackAttachment' | 'OcrDocument';
  readonly recordId: string;
  readonly field: string;
  readonly role: MediaRole;
  readonly plaintextBytes?: number;
  readonly plaintextSha256?: string;
  readonly sourceExpiresAt?: string;
}
export interface MediaInventoryEntry {
  readonly storagePath: string;
  readonly references: readonly MediaReference[];
}
export interface MediaOmission {
  readonly model: 'OcrDocument';
  readonly recordId: string;
  readonly reason: 'ocr-expired' | 'ocr-purged';
  readonly sourceExpiresAt: string;
  readonly storagePaths: readonly string[];
}
export interface MediaInventory {
  readonly entries: readonly MediaInventoryEntry[];
  readonly omissions: readonly MediaOmission[];
}
export interface VerifiedMedia extends MediaInventoryEntry {
  readonly ciphertext: Buffer;
  readonly byteLength: number;
  readonly sha256: string;
}
export interface MediaMetadata {
  readonly tables: Readonly<Record<string, { readonly rowCount: number; readonly rows: readonly Readonly<Record<string, unknown>>[] }>>;
}
export function mediaRows(metadata: MediaMetadata, name: string): readonly Readonly<Record<string, unknown>>[] {
  const table = Object.hasOwn(metadata.tables, name) ? metadata.tables[name] : undefined;
  if (!table || !Array.isArray(table.rows) || table.rowCount !== table.rows.length) {
    throw new PortableMediaError('MISSING_MEDIA_TABLE', `Complete metadata must include the ${name} table, including when empty.`);
  }
  return table.rows;
}
export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.length) throw new PortableMediaError('INVALID_MEDIA_REFERENCE', `Invalid ${label}.`);
  return value;
}
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 32) throw new PortableMediaError('INVALID_DESCRIPTOR', 'Portable recovery JSON nesting exceeds its supported limit.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(item => canonicalJson(item, depth + 1)).join(',') + ']';
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key], depth + 1)).join(',') + '}';
  }
  throw new PortableMediaError('INVALID_DESCRIPTOR', 'Portable recovery descriptors must contain plain JSON values.');
}
