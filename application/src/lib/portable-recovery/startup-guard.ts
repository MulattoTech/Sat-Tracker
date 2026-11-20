import Database from 'better-sqlite3';
import { Client } from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RecoveryConfiguration } from './configuration';
import type { PortableSchemaRegistry } from './schema';
import { assertPhysicalMetadataSchema, inspectSQLiteMetadataSchema, inspectPostgreSQLMetadataSchema } from './schema-native';
import { assertDirectoryChain, assertEmptyMediaRoot } from './storage';
import { RecoveryError } from './types';

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';

/** Inspect natively before generating clients or running any DDL/defaults/seed code. */
async function inspectNativeDestination(config: RecoveryConfiguration, registry: PortableSchemaRegistry, completed: boolean): Promise<'fresh' | 'current-empty' | 'current-restored'> {
  if (completed) {
    await assertDirectoryChain(config.filesRoot);
    if (!(await fs.stat(config.filesRoot)).isDirectory()) {
      throw new RecoveryError('UNSAFE_DESTINATION_PATH', 'The recovered media directory must exist and be a real directory.', 409);
    }
  } else {
    await assertEmptyMediaRoot(config.filesRoot);
  }
  const allowed = new Set([...registry.models.map(model => model.name), '_prisma_migrations']);
  if (config.provider === 'sqlite') {
    const filename = config.databasePath!;
    await assertDirectoryChain(path.dirname(filename), true);
    const stat = await fs.lstat(filename).catch(error => { if (missing(error)) return null; throw error; });
    if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw new RecoveryError('UNSAFE_DATABASE_FILE', 'The recovery database must be a regular file.', 409);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (await fs.lstat(filename + suffix).then(() => true, error => { if (missing(error)) return false; throw error; })) {
        throw new RecoveryError('DATABASE_IN_USE', 'The SQLite destination has live or unresolved journal files.', 409);
      }
    }
    if (!stat || stat.size === 0) {
      if (completed) throw new RecoveryError('RECOVERY_DATA_MISSING', 'The recovered database is absent.', 409);
      return 'fresh';
    }
    let db: Database.Database | undefined;
    try {
      db = new Database(filename, { readonly: true, fileMustExist: true, timeout: 5000 });
      const objects = db.prepare("SELECT name, type, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as { name: string; type: string; sql: string }[];
      for (const object of objects) {
        if (object.type === 'view' || object.type === 'trigger' || /^CREATE\s+VIRTUAL/i.test(object.sql ?? '')) {
          throw new RecoveryError('UNEXPECTED_DESTINATION_SCHEMA', 'The destination contains unsupported schema objects.', 409);
        }
        if (object.type !== 'table') continue;
        if (!allowed.has(object.name)) throw new RecoveryError('UNEXPECTED_DESTINATION_SCHEMA', 'The destination contains tables outside the application schema.', 409);
        if (!completed && object.name !== '_prisma_migrations' && (db.prepare(`SELECT 1 AS occupied FROM ${quote(object.name)} LIMIT 1`).get())) {
          throw new RecoveryError('DESTINATION_NOT_EMPTY', 'The recovery database is not empty.', 409);
        }
      }
      const applicationTables = objects.filter(object => object.type === 'table' && object.name !== '_prisma_migrations');
      if (!applicationTables.length) {
        if (completed) throw new RecoveryError('RECOVERY_DATA_MISSING', 'The recovered application tables are absent.', 409);
        if (objects.some(object => object.name === '_prisma_migrations') && db.prepare('SELECT 1 FROM "_prisma_migrations" LIMIT 1').get()) {
          throw new RecoveryError('UNEXPECTED_DESTINATION_SCHEMA', 'An incomplete migration history is not a fresh recovery destination.', 409);
        }
        return 'fresh';
      }
      try { assertPhysicalMetadataSchema(inspectSQLiteMetadataSchema(db, registry), { provider: 'sqlite', registry }); }
      catch { throw new RecoveryError('UNEXPECTED_DESTINATION_SCHEMA', 'An existing recovery schema must be complete, compatible and empty. Partial schema synchronization is unavailable.', 409); }
      return completed ? 'current-restored' : 'current-empty';
    } catch (error) {
      if (error instanceof RecoveryError) throw error;
      throw new RecoveryError('DESTINATION_INSPECTION_FAILED', 'The SQLite destination could not be safely inspected.', 409);
    } finally { db?.close(); }
  }
  const client = new Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 5000,
    query_timeout: 5000, options: `-c search_path=${config.databaseSchema}` });
  try {
    await client.connect();
    const identity = await client.query<{ database: string; schema: string }>('SELECT current_database() AS database, current_schema() AS schema');
    if (identity.rows[0]?.database !== config.databaseName || identity.rows[0]?.schema !== config.databaseSchema) {
      throw new RecoveryError('DESTINATION_IDENTITY_MISMATCH', 'The configured empty PostgreSQL schema must already exist.', 409);
    }
    const objects = await client.query<{ name: string; kind: string }>(
      "SELECT c.relname AS name, c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','S','f')", [config.databaseSchema]);
    for (const object of objects.rows) {
      if (object.kind !== 'r' || !allowed.has(object.name)) throw new RecoveryError('UNEXPECTED_DESTINATION_SCHEMA', 'The destination contains unsupported schema objects.', 409);
      if (!completed && object.name !== '_prisma_migrations') {
        const result = await client.query(`SELECT 1 FROM ${quote(config.databaseSchema!)}.${quote(object.name)} LIMIT 1`);
        if (result.rowCount) throw new RecoveryError('DESTINATION_NOT_EMPTY', 'The recovery database is not empty.', 409);
      }
    }
    const triggers = await client.query(
      'SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal LIMIT 1', [config.databaseSchema]);
    if (triggers.rowCount) throw new RecoveryError('UNEXPECTED_DESTINATION_SCHEMA', 'The destination contains custom database triggers.', 409);
    const applicationTables = objects.rows.filter(object => object.name !== '_prisma_migrations');
    if (!applicationTables.length) {
      if (completed) throw new RecoveryError('RECOVERY_DATA_MISSING', 'The recovered application tables are absent.', 409);
      if (objects.rows.some(object => object.name === '_prisma_migrations')) {
        const history = await client.query(`SELECT 1 FROM ${quote(config.databaseSchema!)}."_prisma_migrations" LIMIT 1`);
        if (history.rowCount) throw new RecoveryError('UNEXPECTED_DESTINATION_SCHEMA', 'An incomplete migration history is not a fresh recovery destination.', 409);
      }
      const types = await client.query('SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1 AND t.typtype IN (\'e\',\'d\',\'c\') LIMIT 1', [config.databaseSchema]);
      if (types.rowCount) throw new RecoveryError('UNEXPECTED_DESTINATION_SCHEMA', 'A fresh recovery schema cannot contain preexisting application types.', 409);
      return 'fresh';
    }
    const physical = await inspectPostgreSQLMetadataSchema(async sql => (await client.query(sql)).rows);
    try { assertPhysicalMetadataSchema(physical, { provider: 'postgresql', registry }); }
    catch { throw new RecoveryError('UNEXPECTED_DESTINATION_SCHEMA', 'An existing recovery schema must be complete, compatible and empty. Partial schema synchronization is unavailable.', 409); }
    return completed ? 'current-restored' : 'current-empty';
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    throw new RecoveryError('DESTINATION_INSPECTION_FAILED', 'The PostgreSQL destination could not be safely inspected.', 409);
  } finally { await client.end().catch(() => {}); }
}

/** Fresh startup must be empty, while completed recovery may be nonempty but must have an exact compatible schema. */
export async function assertNativeEmptyDestination(config: RecoveryConfiguration, registry: PortableSchemaRegistry): Promise<'fresh' | 'current-empty'> {
  return inspectNativeDestination(config, registry, false) as Promise<'fresh' | 'current-empty'>;
}

export async function assertNativeRestoredDestination(config: RecoveryConfiguration, registry: PortableSchemaRegistry): Promise<void> {
  if (await inspectNativeDestination(config, registry, true) !== 'current-restored') {
    throw new RecoveryError('RECOVERY_DATA_MISSING', 'The recovered database has no compatible schema.', 409);
  }
}
