import type { Prisma } from '@prisma/client';
import type Database from 'better-sqlite3';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PortableField, PortableSchemaRegistry } from './schema';
import { PortableMetadataError, type MetadataDiagnostic, type PortableProvider } from './metadata-codec';

export interface PhysicalMetadataColumn {
  name: string;
  type: string;
  nullable: boolean;
  enumName?: string;
  enumValues?: readonly string[];
  enumSchemaCurrent?: boolean;
  precision?: number | null;
  generated?: boolean;
}
export interface PhysicalMetadataTable {
  name: string;
  kind: string;
  columns: readonly PhysicalMetadataColumn[];
}
export interface PhysicalMetadataOptions {
  provider: PortableProvider;
  registry: PortableSchemaRegistry;
}
export const DIAGNOSTIC_LOG_TABLE = 'api_logs';

/** The one operational log table is explicitly excluded; never take its name from an archive. */
export async function loadDiagnosticLogTableName(schemaPath = resolve(process.cwd(), 'prisma/log-schema.prisma')): Promise<string> {
  const source = await readFile(schemaPath, 'utf8');
  const models = [...source.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];
  const mapped = models.length === 1 && models[0][1] === 'ApiLog' ? /@@map\("([A-Za-z_]\w*)"\)/.exec(models[0][2]) : null;
  if (!mapped || mapped[1] !== DIAGNOSTIC_LOG_TABLE) throw new PortableMetadataError('UNSUPPORTED_DIAGNOSTIC_LOG_SCHEMA');
  return mapped[1];
}

function supportedType(column: PhysicalMetadataColumn, field: PortableField, provider: PortableProvider): boolean {
  if (provider === 'sqlite') {
    const expected = { String: 'TEXT', Boolean: 'BOOLEAN', DateTime: 'DATETIME', Int: 'INTEGER', Float: 'REAL', Enum: 'TEXT' };
    return column.type.toUpperCase() === expected[field.type];
  }
  const expected = { String: 'text', Boolean: 'boolean', DateTime: 'timestamp without time zone', Int: 'integer', Float: 'double precision', Enum: 'USER-DEFINED' };
  return column.type === expected[field.type] &&
    (field.type !== 'Enum' || (column.enumName === field.enumName && column.enumSchemaCurrent === true &&
      column.enumValues?.length === field.enumValues?.length && column.enumValues?.every((value, index) => value === field.enumValues![index]) === true)) &&
    (field.type !== 'DateTime' || column.precision === 3);
}

export function assertPhysicalMetadataSchema(
  tables: readonly PhysicalMetadataTable[], options: PhysicalMetadataOptions,
): void {
  const diagnostics: MetadataDiagnostic[] = [];
  const actual = new Map(tables.map(table => [table.name, table]));
  const expected = new Set(options.registry.models.map(model => model.name));
  for (const table of tables) {
    const internal = table.name === '_prisma_migrations' || (options.provider === 'sqlite' && table.name.startsWith('sqlite_'));
    if (!expected.has(table.name) && !internal && table.name !== DIAGNOSTIC_LOG_TABLE) {
      diagnostics.push({ code: 'UNKNOWN_PHYSICAL_TABLE', ...(/^[A-Za-z_]\w{0,127}$/.test(table.name) ? { model: table.name } : {}) });
    }
  }
  for (const model of options.registry.models) {
    const table = actual.get(model.name);
    if (!table) { diagnostics.push({ code: 'MISSING_PHYSICAL_TABLE', model: model.name }); continue; }
    if (table.kind !== 'table') diagnostics.push({ code: 'UNSUPPORTED_PHYSICAL_TABLE', model: model.name });
    const columns = new Map(table.columns.map(column => [column.name, column]));
    for (const field of model.fields) {
      const column = columns.get(field.name);
      if (!column) diagnostics.push({ code: 'MISSING_PHYSICAL_COLUMN', model: model.name, field: field.name });
      else if (!supportedType(column, field, options.provider) || column.nullable !== field.nullable || column.generated) {
        diagnostics.push({ code: 'INCOMPATIBLE_PHYSICAL_COLUMN', model: model.name, field: field.name });
      }
    }
    for (const column of table.columns) if (!model.fields.some(field => field.name === column.name)) {
      diagnostics.push({ code: 'UNKNOWN_PHYSICAL_COLUMN', model: model.name,
        ...(/^[A-Za-z_]\w{0,127}$/.test(column.name) ? { field: column.name } : {}) });
    }
  }
  if (diagnostics.length) throw new PortableMetadataError('PHYSICAL_SCHEMA_MISMATCH', diagnostics);
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
type SQLiteTableRow = { name: string; type: string; sql: string | null };
type SQLiteColumnRow = { name: string; type: string; notnull: number | bigint; hidden: number | bigint };
function sqliteTable(row: SQLiteTableRow, columns: readonly SQLiteColumnRow[]): PhysicalMetadataTable {
  return { name: row.name, kind: row.type === 'table' && !/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql ?? '') ? 'table' : row.type === 'view' ? 'view' : 'virtual',
    columns: columns.map(column => ({ name: column.name, type: column.type, nullable: Number(column.notnull) === 0, generated: Number(column.hidden) !== 0 })) };
}

/** Read-only native catalog adapter, including generated/hidden columns that table_info omits. */
export function inspectSQLiteMetadataSchema(db: Database.Database, registry: PortableSchemaRegistry): PhysicalMetadataTable[] {
  const tables = db.prepare("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name").all() as SQLiteTableRow[];
  const trustedNames = new Set(registry.models.map(model => model.name));
  return tables.map(table => sqliteTable(table, trustedNames.has(table.name)
    ? db.prepare(`PRAGMA table_xinfo(${quote(table.name)})`).all() as SQLiteColumnRow[] : []));
}

/** Shared by startup's native pg client and the already-locked Prisma transaction. */
export async function inspectPostgreSQLMetadataSchema(query: (sql: string) => Promise<unknown[]>): Promise<PhysicalMetadataTable[]> {
  const schemas = await query('SELECT current_schema() AS schema') as Array<{ schema: string | null }>;
  const schema = schemas[0]?.schema;
  if (typeof schema !== 'string' || !schema.length) throw new PortableMetadataError('PHYSICAL_SCHEMA_READ_FAILED');
  const tables = await query("SELECT c.relname AS name, c.relkind::text AS kind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname") as Array<{ name: string; kind: string }>;
  const columns = await query('SELECT table_name, column_name, data_type, udt_name, udt_schema, is_nullable, datetime_precision, is_identity, is_generated, column_default FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position') as Array<{
    table_name: string; column_name: string; data_type: string; udt_name: string; udt_schema: string; is_nullable: string;
    datetime_precision: number | null; is_identity: string; is_generated: string; column_default: string | null;
  }>;
  const enums = await query("SELECT t.typname AS name, e.enumlabel AS value FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid WHERE n.nspname=current_schema() ORDER BY t.typname,e.enumsortorder") as Array<{ name: string; value: string }>;
  return tables.map(table => ({ name: table.name, kind: table.kind === 'r' ? 'table' : table.kind,
    columns: columns.filter(column => column.table_name === table.name).map(column => ({ name: column.column_name, type: column.data_type,
      nullable: column.is_nullable === 'YES', enumName: column.udt_name, enumSchemaCurrent: column.udt_schema === schema,
      enumValues: enums.filter(value => value.name === column.udt_name).map(value => value.value), precision: column.datetime_precision,
      generated: column.is_identity === 'YES' || column.is_generated !== 'NEVER' || /^nextval\(/.test(column.column_default ?? ''),
    })) }));
}

export async function assertTransactionMetadataSchema(tx: Prisma.TransactionClient, options: PhysicalMetadataOptions): Promise<void> {
  await loadDiagnosticLogTableName();
  let tables: PhysicalMetadataTable[];
  try {
    if (options.provider === 'sqlite') {
      const rows = await tx.$queryRawUnsafe<SQLiteTableRow[]>("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name");
      tables = [];
      const trustedNames = new Set(options.registry.models.map(model => model.name));
      for (const row of rows) tables.push(sqliteTable(row, trustedNames.has(row.name)
        ? await tx.$queryRawUnsafe<SQLiteColumnRow[]>(`PRAGMA table_xinfo(${quote(row.name)})`) : []));
    } else {
      tables = await inspectPostgreSQLMetadataSchema(sql => tx.$queryRawUnsafe<unknown[]>(sql));
    }
  } catch { throw new PortableMetadataError('PHYSICAL_SCHEMA_READ_FAILED'); }
  assertPhysicalMetadataSchema(tables, options);
}
