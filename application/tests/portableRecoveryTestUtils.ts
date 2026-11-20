import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { parsePortableSchema, type PortableSchemaRegistry } from '@/src/lib/portable-recovery/schema';
import { createPortableMetadata, type PortableScalar } from '@/src/lib/portable-recovery/metadata-codec';

export const metadataInstant = '2026-11-20T01:02:03.456Z';
export const metadataRegistry = parsePortableSchema(readFileSync('prisma/schema.prisma', 'utf8'));

export function migrateNativeSQLite(db: Database.Database): void {
  // This helper only constructs owned, empty test databases. One transaction avoids
  // hundreds of disk flushes; native foreign keys are enabled before any fixture row.
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    for (const directory of readdirSync('prisma/migrations').sort()) {
      if (directory === 'migration_lock.toml') continue;
      db.exec(readFileSync(path.join('prisma/migrations', directory, 'migration.sql'), 'utf8'));
    }
  })();
  db.pragma('foreign_keys = ON');
}

/** Every scalar receives a deliberate synthetic value; no production key, client or environment is loaded. */
export function completeMetadataFixture(registry: PortableSchemaRegistry = metadataRegistry) {
  const rows: Record<string, Record<string, PortableScalar>[]> = {};
  for (const model of registry.models) {
    const row: Record<string, PortableScalar> = {};
    for (const field of model.fields) {
      row[field.name] = field.type === 'String' ? `${model.name}-${field.name} café\nline 2` :
        field.type === 'DateTime' ? metadataInstant : field.type === 'Boolean' ? false :
        field.type === 'Int' ? 0 : field.type === 'Float' ? 1.25 : field.enumValues![0];
    }
    if (Object.hasOwn(row, 'id')) row.id = `synthetic-${model.name}`;
    rows[model.name] = [row];
  }
  for (const model of registry.models) for (const fk of model.foreignKeys) {
    fk.fields.forEach((field, index) => { rows[model.name][0][field] = rows[fk.referencedModel][0][fk.referencedFields[index]]; });
  }
  rows.Family[0].accountId = rows.Account[0].id;
  rows.Caretaker[0].accountId = rows.Account[0].id;
  rows.PhotoFavorite[0].accountId = rows.Account[0].id;
  rows.PhotoFavorite[0].caretakerId = rows.Caretaker[0].id;
  rows.PhotoLink[0].activityType = 'diaper';
  rows.PhotoLink[0].activityId = rows.DiaperLog[0].id;
  rows.FeedLog[0].sourcePumpId = rows.PumpLog[0].id;
  rows.DiaperLog[0].rashObserved = null;
  return createPortableMetadata(registry, { provider: 'sqlite', exportedAt: metadataInstant }, rows);
}

export function createMetadataTestDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), 'sat-portable-metadata-'));
  const file = path.join(directory, 'isolated.db');
  const native = new Database(file);
  migrateNativeSQLite(native);
  native.close();
  const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${file}` }) });
  return { db, file, directory, async close() { await db.$disconnect(); rmSync(directory, { recursive: true, force: true }); } };
}
