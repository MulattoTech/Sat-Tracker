import Database from 'better-sqlite3';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalStringify, type PortableModel, type PortableSchemaRegistry } from './schema';
import { assertPhysicalMetadataSchema, inspectSQLiteMetadataSchema, loadDiagnosticLogTableName } from './schema-native';
import {
  createPortableMetadata, encodePortableRow, isCanonicalPortableDate, MAX_PORTABLE_METADATA_BYTES,
  PortableMetadataError, type MetadataDiagnostic, type PortableMetadataV1, type PortableRow,
} from './metadata-codec';

export const MAX_LEGACY_SQLITE_BYTES = 128 * 1024 * 1024;
export interface LegacySQLiteMetadataResult {
  metadata: PortableMetadataV1;
  diagnostics: readonly MetadataDiagnostic[];
  snapshot: { kind: 'supplied-sqlite-file'; latestLiveStateVerified: false };
}

/** Explicit integer Unix milliseconds or ISO with an explicit offset, never an inferred local timezone. */
export function normalizeLegacySQLiteDate(value: unknown): string {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new PortableMetadataError('INVALID_LEGACY_DATETIME');
    value = Number(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new PortableMetadataError('INVALID_LEGACY_DATETIME');
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new PortableMetadataError('INVALID_LEGACY_DATETIME');
    return date.toISOString();
  }
  if (isCanonicalPortableDate(value)) return value;
  if (typeof value !== 'string') throw new PortableMetadataError('INVALID_LEGACY_DATETIME');
  const match = /^((?:\d{4}|[+-]\d{6})-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new PortableMetadataError('INVALID_LEGACY_DATETIME');
  const base = `${match[1]}T${match[2]}.${(match[3] ?? '').padEnd(3, '0')}`;
  if (!isCanonicalPortableDate(`${base}Z`)) throw new PortableMetadataError('INVALID_LEGACY_DATETIME');
  if (match[4] !== 'Z' && (Number(match[4].slice(1, 3)) > 23 || Number(match[4].slice(4, 6)) > 59)) throw new PortableMetadataError('INVALID_LEGACY_DATETIME');
  const date = new Date(`${base}${match[4]}`);
  if (!Number.isFinite(date.getTime())) throw new PortableMetadataError('INVALID_LEGACY_DATETIME');
  return date.toISOString();
}

function convertRow(model: PortableModel, source: Record<string, unknown>, index: number): PortableRow {
  const row = { ...source };
  for (const field of model.fields) {
    const value = row[field.name];
    if (value === null) continue;
    if (field.type === 'Boolean') {
      if (value === 0 || value === BigInt(0)) row[field.name] = false;
      else if (value === 1 || value === BigInt(1)) row[field.name] = true;
    } else if (field.type === 'DateTime') {
      try { row[field.name] = normalizeLegacySQLiteDate(value); }
      catch { throw new PortableMetadataError('INVALID_LEGACY_DATETIME', [{ code: 'INVALID_LEGACY_DATETIME', model: model.name, row: index, field: field.name }]); }
    } else if ((field.type === 'Int' || field.type === 'Float') && typeof value === 'bigint' && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      row[field.name] = Number(value);
    }
  }
  return encodePortableRow(model, row, index);
}

/** A supplied .db proves its own contents, not whether a live source's WAL/latest writes were included. */
export async function readLegacySQLiteMetadata(
  buffer: Buffer, registry: PortableSchemaRegistry, options: { exportedAt?: string } = {},
): Promise<LegacySQLiteMetadataResult> {
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) throw new PortableMetadataError('INVALID_LEGACY_SQLITE');
  if (buffer.length > MAX_LEGACY_SQLITE_BYTES) throw new PortableMetadataError('LEGACY_SQLITE_SIZE_LIMIT');
  await loadDiagnosticLogTableName();
  const directory = await mkdtemp(join(tmpdir(), 'sat-portable-legacy-'));
  let db: Database.Database | undefined;
  try {
    const file = join(directory, 'source.db');
    await writeFile(file, buffer, { mode: 0o600 });
    db = new Database(file, { readonly: true, fileMustExist: true });
    db.pragma('trusted_schema = OFF'); db.pragma('query_only = ON'); db.defaultSafeIntegers(true);
    const native = db;
    const metadata = native.transaction(() => {
      const integrity = native.pragma('integrity_check') as Array<{ integrity_check: string }>;
      if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new PortableMetadataError('INVALID_LEGACY_SQLITE');
      assertPhysicalMetadataSchema(inspectSQLiteMetadataSchema(native, registry), { provider: 'sqlite', registry });
      const rows: Record<string, PortableRow[]> = {};
      let bytes = Buffer.byteLength(canonicalStringify(registry), 'utf8');
      for (const model of registry.models) {
        rows[model.name] = [];
        const columns = model.fields.map(field => `"${field.name}"`).join(', ');
        for (const value of native.prepare(`SELECT ${columns} FROM "${model.name}"`).iterate()) {
          const row = convertRow(model, value as Record<string, unknown>, rows[model.name].length);
          bytes += Buffer.byteLength(canonicalStringify(row), 'utf8') + 1;
          if (bytes > MAX_PORTABLE_METADATA_BYTES) throw new PortableMetadataError('METADATA_SIZE_LIMIT');
          rows[model.name].push(row);
        }
      }
      return createPortableMetadata(registry, { provider: 'sqlite', exportedAt: options.exportedAt ?? new Date().toISOString() }, rows);
    })();
    return { metadata, diagnostics: [{ code: 'LEGACY_LIVE_STATE_NOT_PROVEN' }], snapshot: { kind: 'supplied-sqlite-file', latestLiveStateVerified: false } };
  } catch (error) {
    if (error instanceof PortableMetadataError) throw error;
    throw new PortableMetadataError('LEGACY_SQLITE_READ_FAILED');
  } finally {
    let cleanupFailed = false;
    try { db?.close(); } catch { cleanupFailed = true; }
    try { await rm(directory, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    if (cleanupFailed) throw new PortableMetadataError('LEGACY_SQLITE_CLEANUP_FAILED');
  }
}
