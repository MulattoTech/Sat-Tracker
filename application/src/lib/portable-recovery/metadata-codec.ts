import { createHash } from 'node:crypto';
import { canonicalStringify, type PortableField, type PortableModel, type PortableSchemaRegistry } from './schema';

export type PortableProvider = 'sqlite' | 'postgresql';
export const MAX_PORTABLE_METADATA_BYTES = 32 * 1024 * 1024;
export type PortableScalar = string | number | boolean | null;
export type PortableRow = Readonly<Record<string, PortableScalar>>;
export interface PortableMetadataV1 {
  readonly format: 'sat-tracker.application-metadata';
  readonly version: 1;
  readonly source: { readonly provider: PortableProvider; readonly exportedAt: string };
  readonly schema: PortableSchemaRegistry;
  readonly tables: Readonly<Record<string, { readonly rowCount: number; readonly rows: readonly PortableRow[] }>>;
}
export interface MetadataDiagnostic {
  readonly code: string;
  readonly model?: string;
  readonly row?: number;
  readonly field?: string;
}
export class PortableMetadataError extends Error {
  constructor(readonly code: string, readonly diagnostics: readonly MetadataDiagnostic[] = [{ code }]) {
    super(`Portable metadata recovery rejected: ${code}`);
    this.name = 'PortableMetadataError';
  }
}
export interface ValidatedPortableMetadata {
  readonly metadata: PortableMetadataV1;
  readonly totalRows: number;
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly tableHashes: Readonly<Record<string, string>>;
  readonly insertOrder: readonly string[];
}

const validatedObjects = new WeakSet<object>();
function reject(code: string, model?: string, row?: number, field?: string): never {
  throw new PortableMetadataError(code, [{ code, ...(model === undefined ? {} : { model }), ...(row === undefined ? {} : { row }), ...(field === undefined ? {} : { field }) }]);
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
};

export function isCanonicalPortableDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function validScalar(value: unknown, field: PortableField): value is PortableScalar {
  if (value === null) return field.nullable;
  switch (field.type) {
    case 'String': return typeof value === 'string' && Buffer.from(value, 'utf8').toString('utf8') === value;
    case 'Boolean': return typeof value === 'boolean';
    case 'Int': return typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
    case 'Float': return typeof value === 'number' && Number.isFinite(value);
    case 'Enum': return typeof value === 'string' && field.enumValues?.includes(value) === true;
    case 'DateTime': return isCanonicalPortableDate(value);
  }
}

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const keyOf = (row: PortableRow, fields: readonly string[]) => canonicalStringify(fields.map(field => row[field]));

/** Row order is not data identity. Composite keys are encoded without separator collisions. */
export function portableTableHash(model: PortableModel, rows: readonly PortableRow[]): string {
  const ordered = rows.map(row => ({ key: keyOf(row, model.primaryKey), row }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(entry => entry.row);
  return `sha256:${createHash('sha256').update(canonicalStringify(ordered)).digest('hex')}`;
}

function insertionOrder(registry: PortableSchemaRegistry): string[] {
  const dependencies = new Map(registry.models.map(model => [model.name, new Set(model.foreignKeys
    .filter(fk => !fk.fields.some(name => model.fields.find(field => field.name === name)!.nullable))
    .map(fk => fk.referencedModel))]));
  const result: string[] = [];
  while (dependencies.size) {
    const ready = [...dependencies].filter(([, parents]) => parents.size === 0).map(([name]) => name).sort();
    if (!ready.length) reject('REQUIRED_FOREIGN_KEY_CYCLE');
    result.push(...ready);
    for (const name of ready) dependencies.delete(name);
    for (const parents of dependencies.values()) for (const name of ready) parents.delete(name);
  }
  return result;
}

/** Strict, complete preflight. It never fills defaults, resolves ownership or repairs references. */
export function validatePortableMetadata(value: unknown, registry: PortableSchemaRegistry): ValidatedPortableMetadata {
  if (!record(value) || !exactKeys(value, ['format', 'version', 'source', 'schema', 'tables']) ||
      value.format !== 'sat-tracker.application-metadata' || value.version !== 1) reject('UNSUPPORTED_METADATA_FORMAT');
  if (!record(value.source) || !exactKeys(value.source, ['provider', 'exportedAt']) ||
      !['sqlite', 'postgresql'].includes(value.source.provider as string) || !isCanonicalPortableDate(value.source.exportedAt)) reject('INVALID_SOURCE_DESCRIPTION');
  if (!record(value.schema) || !exactKeys(value.schema, ['fingerprint', 'models'])) reject('SCHEMA_MISMATCH');
  let sameSchema = false;
  try { sameSchema = canonicalStringify(value.schema) === canonicalStringify(registry); } catch { /* fail closed below */ }
  if (!sameSchema) reject('SCHEMA_MISMATCH');
  if (!record(value.tables) || !exactKeys(value.tables, registry.models.map(model => model.name))) reject('INCOMPLETE_TABLE_INVENTORY');
  const tables = value.tables as Record<string, unknown>;
  const rowsByModel = new Map<string, readonly PortableRow[]>();
  const rowCounts: Record<string, number> = {}, tableHashes: Record<string, string> = {};
  let totalRows = 0;
  for (const model of registry.models) {
    const table = tables[model.name];
    if (!record(table) || !exactKeys(table, ['rowCount', 'rows']) || !Array.isArray(table.rows) ||
        !Number.isSafeInteger(table.rowCount) || table.rowCount !== table.rows.length) reject('INVALID_TABLE_COUNT', model.name);
    const rows = table.rows as unknown[];
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (!record(row) || !exactKeys(row, model.fields.map(field => field.name))) reject('INVALID_ROW_FIELDS', model.name, index);
      for (const field of model.fields) if (!validScalar((row as Record<string, unknown>)[field.name], field)) reject('INVALID_SCALAR', model.name, index, field.name);
    }
    const typedRows = rows as PortableRow[];
    for (const fields of [model.primaryKey, ...model.uniqueConstraints]) {
      const seen = new Set<string>();
      for (let index = 0; index < typedRows.length; index++) {
        const row = typedRows[index];
        if (fields.some(field => row[field] === null)) continue; // SQL NULLs do not collide in these unique constraints.
        const key = keyOf(row, fields);
        if (seen.has(key)) reject('DUPLICATE_KEY', model.name, index);
        seen.add(key);
      }
    }
    rowsByModel.set(model.name, typedRows);
    rowCounts[model.name] = typedRows.length;
    tableHashes[model.name] = portableTableHash(model, typedRows);
    totalRows += typedRows.length;
    if (!Number.isSafeInteger(totalRows)) reject('INVALID_TOTAL_COUNT');
  }
  const referenceKeys = new Map<string, Set<string>>();
  for (const model of registry.models) for (const fk of model.foreignKeys) {
    const targetKey = `${fk.referencedModel}:${canonicalStringify(fk.referencedFields)}`;
    let keys = referenceKeys.get(targetKey);
    if (!keys) { keys = new Set(rowsByModel.get(fk.referencedModel)!.map(row => keyOf(row, fk.referencedFields))); referenceKeys.set(targetKey, keys); }
    for (const [index, row] of rowsByModel.get(model.name)!.entries()) {
      if (fk.fields.some(field => row[field] === null)) continue;
      if (!keys.has(keyOf(row, fk.fields))) reject('MISSING_REFERENCE', model.name, index, fk.fields[0]);
    }
  }
  // Clone before freezing so a caller cannot change an already-validated request during awaited I/O.
  const serialized = canonicalStringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PORTABLE_METADATA_BYTES) reject('METADATA_SIZE_LIMIT');
  const metadata = freeze(JSON.parse(serialized) as PortableMetadataV1);
  const result = freeze({ metadata, totalRows, rowCounts, tableHashes, insertOrder: insertionOrder(registry) });
  validatedObjects.add(result);
  return result;
}

export function assertValidatedPortableMetadata(value: ValidatedPortableMetadata): void {
  if (!validatedObjects.has(value)) reject('METADATA_NOT_VALIDATED');
}

export function encodePortableRow(model: PortableModel, sourceRow: unknown, index = 0): PortableRow {
  if (!record(sourceRow) || !exactKeys(sourceRow, model.fields.map(field => field.name))) reject('INVALID_ROW_FIELDS', model.name, index);
  const row: Record<string, unknown> = { ...sourceRow };
  for (const field of model.fields) {
    if (field.type === 'DateTime' && row[field.name] instanceof Date) {
      const date = row[field.name] as Date;
      if (!Number.isFinite(date.getTime())) reject('INVALID_SCALAR', model.name, index, field.name);
      row[field.name] = date.toISOString();
    }
    if (!validScalar(row[field.name], field)) reject('INVALID_SCALAR', model.name, index, field.name);
  }
  return row as PortableRow;
}

/** Source rows may contain Prisma Date objects; every other scalar remains exactly typed. */
export function createPortableMetadata(
  registry: PortableSchemaRegistry,
  source: PortableMetadataV1['source'],
  rows: Readonly<Record<string, readonly Record<string, unknown>[]>>,
): PortableMetadataV1 {
  if (!record(rows) || !exactKeys(rows, registry.models.map(model => model.name))) reject('INCOMPLETE_TABLE_INVENTORY');
  const tables: Record<string, { rowCount: number; rows: PortableRow[] }> = {};
  for (const model of registry.models) {
    if (!Array.isArray(rows[model.name])) reject('INVALID_TABLE_COUNT', model.name);
    const encoded = rows[model.name].map((sourceRow, index) => encodePortableRow(model, sourceRow, index));
    tables[model.name] = { rowCount: encoded.length, rows: encoded };
  }
  return validatePortableMetadata({ format: 'sat-tracker.application-metadata', version: 1, source, schema: registry, tables }, registry).metadata;
}

export function decodePortableRow(model: PortableModel, row: PortableRow): Record<string, PortableScalar | Date> {
  return Object.fromEntries(model.fields.map(field => [field.name,
    field.type === 'DateTime' && row[field.name] !== null ? new Date(row[field.name] as string) : row[field.name],
  ]));
}
