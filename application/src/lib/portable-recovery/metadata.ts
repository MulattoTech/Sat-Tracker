import type { Prisma, PrismaClient } from '@prisma/client';
import { canonicalStringify, type PortableModel, type PortableSchemaRegistry } from './schema';
import { assertTransactionMetadataSchema } from './schema-native';
import {
  assertValidatedPortableMetadata, createPortableMetadata, decodePortableRow, encodePortableRow, MAX_PORTABLE_METADATA_BYTES, PortableMetadataError,
  validatePortableMetadata, type PortableMetadataV1, type PortableProvider, type PortableScalar,
  type ValidatedPortableMetadata,
} from './metadata-codec';

export * from './metadata-codec';
export type MetadataTransaction = Prisma.TransactionClient;
export interface MetadataDatabaseOptions {
  provider: PortableProvider;
  registry: PortableSchemaRegistry;
}
export interface MetadataExportOptions extends MetadataDatabaseOptions {
  exportedAt?: string;
}
export interface MetadataImportResult {
  tablesImported: number;
  recordsImported: number;
  rowCounts: Readonly<Record<string, number>>;
  tableHashes: Readonly<Record<string, string>>;
}
interface Delegate {
  count(): Promise<number>;
  findMany(args: { select: Record<string, true>; take: number; skip: number; orderBy: Record<string, 'asc'>[] }): Promise<Record<string, unknown>[]>;
  createMany(args: { data: Record<string, PortableScalar | Date>[] }): Promise<{ count: number }>;
  updateMany(args: { where: Record<string, PortableScalar>; data: Record<string, PortableScalar | Date> }): Promise<{ count: number }>;
}

const sourceLocks = new WeakMap<object, string>();
const destinationLocks = new WeakMap<object, string>();
const transactionProviders = new WeakMap<object, PortableProvider>();
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
function fail(code: string, model?: string): never {
  throw new PortableMetadataError(code, [{ code, ...(model === undefined ? {} : { model }) }]);
}
function transactionOnly(tx: MetadataTransaction): void {
  // Prisma 7 supports nested $transaction, including on transaction clients. Pin its
  // actual scope capability and fail closed if a future runtime changes the marker.
  const scope = (tx as unknown as Record<symbol, unknown>)[Symbol.for('prisma.client.transaction.scope_context')] as
    { kind?: string; txId?: string; scopeId?: string; scopeState?: { stack?: unknown[] } } | undefined;
  if (scope?.kind !== 'nested' || typeof scope.txId !== 'string' || typeof scope.scopeId !== 'string' ||
      !Array.isArray(scope.scopeState?.stack) || !scope.scopeState.stack.includes(scope.scopeId)) fail('TRANSACTION_REQUIRED');
}
function delegate(tx: MetadataTransaction, model: PortableModel): Delegate {
  const value = (tx as unknown as Record<string, Delegate>)[model.name[0].toLowerCase() + model.name.slice(1)];
  if (!value || typeof value.findMany !== 'function' || typeof value.createMany !== 'function') fail('MODEL_UNAVAILABLE', model.name);
  return value;
}

async function lockTables(tx: MetadataTransaction, options: MetadataDatabaseOptions, mode: 'SHARE' | 'ACCESS EXCLUSIVE'): Promise<void> {
  transactionOnly(tx);
  if (!['sqlite', 'postgresql'].includes(options.provider) || !options.registry.models.length) fail('UNSUPPORTED_DATABASE');
  try {
    if (options.provider === 'postgresql') {
      const tables = options.registry.models.map(model => quote(model.name)).sort().join(', ');
      await tx.$executeRawUnsafe(`LOCK TABLE ${tables} IN ${mode} MODE`);
    } else {
      if (!options.registry.models.some(model => model.name === 'Family')) fail('MODEL_UNAVAILABLE', 'Family');
      // A zero-row write obtains SQLite's writer reservation without changing a scalar.
      await tx.$executeRawUnsafe('UPDATE "Family" SET "id" = "id" WHERE 1 = 0');
    }
  } catch (error) {
    if (error instanceof PortableMetadataError) throw error;
    fail('METADATA_LOCK_FAILED');
  }
  transactionProviders.set(tx, options.provider);
}

/** Must be the first source transaction operation; media bytes are captured before this transaction ends. */
export async function lockMetadataSnapshot(tx: MetadataTransaction, options: MetadataDatabaseOptions): Promise<void> {
  await lockTables(tx, options, 'SHARE');
  await assertTransactionMetadataSchema(tx, options);
  sourceLocks.set(tx, options.registry.fingerprint);
}

async function emptyCounts(tx: MetadataTransaction, registry: PortableSchemaRegistry): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const model of registry.models) {
    let count: number;
    try { count = await delegate(tx, model).count(); } catch (error) {
      if (error instanceof PortableMetadataError) throw error;
      fail('METADATA_READ_FAILED', model.name);
    }
    if (count !== 0) fail('DESTINATION_NOT_EMPTY', model.name);
    counts[model.name] = count;
  }
  return counts;
}

/** Includes configuration, units and growth tables. No seed/bootstrap row exception is permitted. */
export async function lockAndAssertEmptyMetadataDestination(tx: MetadataTransaction, options: MetadataDatabaseOptions): Promise<Record<string, number>> {
  await lockTables(tx, options, 'ACCESS EXCLUSIVE');
  await assertTransactionMetadataSchema(tx, options);
  const counts = await emptyCounts(tx, options.registry);
  destinationLocks.set(tx, options.registry.fingerprint);
  return counts;
}

async function readRows(tx: MetadataTransaction, registry: PortableSchemaRegistry): Promise<Record<string, Record<string, unknown>[]>> {
  const rows: Record<string, Record<string, unknown>[]> = {};
  const provider = transactionProviders.get(tx);
  if (!provider) fail('SNAPSHOT_NOT_LOCKED');
  let bytes = Buffer.byteLength(canonicalStringify(registry), 'utf8') + 1000;
  let nativeLowerBound = BigInt(0);
  for (const model of registry.models) {
    try {
      // Reject a large source before materializing its text, then enforce the exact
      // canonical size while reading bounded pages. Every table, including empty ones, remains represented.
      const sizes = model.fields.filter(field => field.type === 'String').map(field => provider === 'sqlite'
        ? `COALESCE(length(CAST(${quote(field.name)} AS BLOB)), 0)` : `COALESCE(octet_length(${quote(field.name)}), 0)`);
      const measured = await tx.$queryRawUnsafe<Array<{ rows: number | bigint | string; bytes: number | bigint | string }>>(
        `SELECT COUNT(*) AS "rows", COALESCE(SUM(${sizes.join(' + ') || '0'}), 0) AS "bytes" FROM ${quote(model.name)}`);
      nativeLowerBound += BigInt(measured[0].bytes) + BigInt(measured[0].rows) * BigInt(2);
      if (nativeLowerBound > BigInt(MAX_PORTABLE_METADATA_BYTES)) fail('METADATA_SIZE_LIMIT', model.name);
      const select = Object.fromEntries(model.fields.map(field => [field.name, true as const]));
      const orderBy = model.primaryKey.map(field => ({ [field]: 'asc' as const }));
      rows[model.name] = [];
      for (let skip = 0; ; skip += 128) {
        const page = await delegate(tx, model).findMany({ select, take: 128, skip, orderBy });
        for (const value of page) {
          const row = encodePortableRow(model, value, rows[model.name].length);
          bytes += Buffer.byteLength(canonicalStringify(row), 'utf8') + 1;
          if (bytes > MAX_PORTABLE_METADATA_BYTES) fail('METADATA_SIZE_LIMIT', model.name);
          rows[model.name].push(row);
        }
        if (page.length < 128) break;
      }
      if (BigInt(rows[model.name].length) !== BigInt(measured[0].rows)) fail('SOURCE_COUNT_MISMATCH', model.name);
    }
    catch (error) {
      if (error instanceof PortableMetadataError) throw error;
      fail('METADATA_READ_FAILED', model.name);
    }
  }
  return rows;
}

export async function exportMetadataFromTransaction(tx: MetadataTransaction, options: MetadataExportOptions): Promise<PortableMetadataV1> {
  transactionOnly(tx);
  if (sourceLocks.get(tx) !== options.registry.fingerprint) fail('SNAPSHOT_NOT_LOCKED');
  return createPortableMetadata(options.registry,
    { provider: options.provider, exportedAt: options.exportedAt ?? new Date().toISOString() },
    await readRows(tx, options.registry));
}

/** Metadata-only convenience wrapper. Archive orchestration uses the transaction helpers to include files. */
export async function exportMetadata(client: PrismaClient, options: MetadataExportOptions): Promise<PortableMetadataV1> {
  return client.$transaction(async tx => {
    await lockMetadataSnapshot(tx, options);
    return exportMetadataFromTransaction(tx, options);
  }, { isolationLevel: 'Serializable', maxWait: 120_000, timeout: 120_000 });
}

export async function assertRestoredMetadataMatches(tx: MetadataTransaction, expected: ValidatedPortableMetadata): Promise<MetadataImportResult> {
  transactionOnly(tx);
  assertValidatedPortableMetadata(expected);
  const actual = validatePortableMetadata(createPortableMetadata(expected.metadata.schema, expected.metadata.source,
    await readRows(tx, expected.metadata.schema)), expected.metadata.schema);
  for (const model of expected.metadata.schema.models) {
    if (actual.rowCounts[model.name] !== expected.rowCounts[model.name] || actual.tableHashes[model.name] !== expected.tableHashes[model.name]) fail('READBACK_MISMATCH', model.name);
  }
  return { tablesImported: expected.metadata.schema.models.length, recordsImported: actual.totalRows, rowCounts: actual.rowCounts, tableHashes: actual.tableHashes };
}

/** Caller owns the transaction. Any error must escape it; there are no skip, merge or retry paths. */
export async function importMetadataInTransaction(tx: MetadataTransaction, validated: ValidatedPortableMetadata): Promise<MetadataImportResult> {
  transactionOnly(tx);
  assertValidatedPortableMetadata(validated);
  const registry = validated.metadata.schema;
  if (destinationLocks.get(tx) !== registry.fingerprint) fail('EMPTY_DESTINATION_NOT_LOCKED');
  await emptyCounts(tx, registry); // Also reject caller-side writes between the lock and import.
  destinationLocks.delete(tx);
  for (const name of validated.insertOrder) {
    const model = registry.models.find(model => model.name === name)!;
    const nullableLinks = new Set(model.foreignKeys.flatMap(fk => fk.fields.filter(name => model.fields.find(field => field.name === name)!.nullable)));
    const rows = validated.metadata.tables[name].rows.map(row => {
      const decoded = decodePortableRow(model, row);
      for (const field of nullableLinks) decoded[field] = null;
      return decoded;
    });
    const batchSize = Math.max(1, Math.floor(900 / model.fields.length));
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      const batch = rows.slice(offset, offset + batchSize);
      try {
        const inserted = await delegate(tx, model).createMany({ data: batch });
        if (inserted.count !== batch.length) fail('INSERT_COUNT_MISMATCH', name);
      } catch (error) {
        if (error instanceof PortableMetadataError) throw error;
        fail('METADATA_INSERT_FAILED', name);
      }
    }
  }
  // Nullable relationships are restored only after every target exists, including self/cyclic edges.
  for (const model of registry.models) {
    const nullableLinks = [...new Set(model.foreignKeys.flatMap(fk => fk.fields.filter(name => model.fields.find(field => field.name === name)!.nullable)))];
    for (const row of validated.metadata.tables[model.name].rows) {
      const changed = nullableLinks.filter(field => row[field] !== null);
      if (!changed.length) continue;
      const data: Record<string, PortableScalar | Date> = Object.fromEntries(changed.map(field => [field, row[field]]));
      for (const field of model.fields) if (field.updatedAt) data[field.name] = row[field.name] === null ? null : new Date(row[field.name] as string);
      try {
        const updated = await delegate(tx, model).updateMany({ where: Object.fromEntries(model.primaryKey.map(field => [field, row[field]])), data });
        if (updated.count !== 1) fail('LINK_COUNT_MISMATCH', model.name);
      } catch (error) {
        if (error instanceof PortableMetadataError) throw error;
        fail('METADATA_LINK_FAILED', model.name);
      }
    }
  }
  return assertRestoredMetadataMatches(tx, validated);
}

export async function importMetadata(client: PrismaClient, value: unknown, options: MetadataDatabaseOptions): Promise<MetadataImportResult> {
  const validated = validatePortableMetadata(value, options.registry);
  return client.$transaction(async tx => {
    await lockAndAssertEmptyMetadataDestination(tx, options);
    return importMetadataInTransaction(tx, validated);
  }, { isolationLevel: 'Serializable', maxWait: 120_000, timeout: 120_000 });
}
