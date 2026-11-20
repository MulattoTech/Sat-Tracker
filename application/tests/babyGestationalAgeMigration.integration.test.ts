import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PrismaClient } from '@prisma/client';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
vi.mock('../app/api/db', () => ({ get default() { return state.db; } }));
import { exportToJSON, importFromJSON, importFromSQLiteFile } from '../app/api/utils/db-backup';

const migration = '20261120060000_add_baby_gestational_age';
const migrationsPath = path.join(process.cwd(), 'prisma/migrations');
const migrationSql = readFileSync(path.join(migrationsPath, migration, 'migration.sql'), 'utf8');
const familyId = 'synthetic-gestation-family';
const childIds = ['synthetic-gestation-known', 'synthetic-gestation-unknown', 'synthetic-gestation-legacy'];
const birthDate = '2026-01-01T06:07:08.123Z';
const careTime = '2026-01-02T09:10:11.456Z';
let directory: string;
const clients: PrismaClient[] = [];

/** Apply the actual migration history, not a simplified copy of the Baby table. */
function migratedFile(name: string, legacy = false) {
  const filename = path.join(directory, name + '.db');
  const db = new Database(filename);
  for (const entry of readdirSync(migrationsPath, { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    if (legacy && entry.name >= migration) continue;
    db.exec(readFileSync(path.join(migrationsPath, entry.name, 'migration.sql'), 'utf8'));
  }
  return { filename, db };
}

function legacyFixture(name: string) {
  const result = migratedFile(name, true);
  result.db.prepare('INSERT INTO "Family" (id, slug, name, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)')
    .run(familyId, familyId, 'Synthetic gestation family', birthDate, birthDate);
  const insertBaby = result.db.prepare('INSERT INTO "Baby" (id, firstName, lastName, birthDate, createdAt, updatedAt, familyId) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const id of childIds) insertBaby.run(id, 'Synthetic', 'Migration fixture', birthDate, birthDate, birthDate, familyId);
  result.db.prepare('INSERT INTO "Note" (id, time, content, createdAt, updatedAt, familyId, babyId) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('synthetic-gestation-note', careTime, 'Synthetic preserved care', careTime, careTime, familyId, childIds[0]);
  return result;
}

function client(filename: string) {
  const db = new PrismaClient({ adapter: createPrismaAdapter('file:' + filename) });
  clients.push(db);
  return db;
}

async function snapshot(db: PrismaClient) {
  return {
    families: await db.family.findMany({ orderBy: { id: 'asc' } }),
    babies: await db.baby.findMany({ orderBy: { id: 'asc' } }),
    notes: await db.note.findMany({ orderBy: { id: 'asc' } }),
  };
}

async function upgradedFixture(name: string) {
  const { filename, db: raw } = legacyFixture(name);
  raw.close();
  const legacyBackup = readFileSync(filename);
  const upgrade = new Database(filename);
  upgrade.exec(migrationSql);
  upgrade.close();
  const db = client(filename);
  const legacyState = await snapshot(db);
  await db.baby.update({ where: { id: childIds[0] }, data: { gestationalAgeDays: 235 } });
  return { filename, db, legacyBackup, legacyState };
}

function emptyRestoreTarget(name: string) {
  const { filename, db: raw } = migratedFile(name);
  // Only this newly created synthetic destination is emptied. Migration-seeded
  // lookup rows must also be absent so the actual importer can restore them.
  raw.pragma('foreign_keys = OFF');
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  for (const { name: table } of tables) raw.exec(`DELETE FROM "${table.replaceAll('"', '""')}"`);
  raw.close();
  return client(filename);
}

beforeAll(() => { directory = mkdtempSync(path.join(tmpdir(), 'sat-gestation-migration-')); });
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  await Promise.all(clients.map(db => db.$disconnect()));
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('nullable gestational age migration and actual backup utilities', () => {
  it('adds unknown gestation without rewriting existing baby, family, or care rows', () => {
    const { db } = legacyFixture('upgrade');
    try {
      const babies = db.prepare('SELECT * FROM "Baby" ORDER BY id').all();
      const families = db.prepare('SELECT * FROM "Family" ORDER BY id').all();
      const notes = db.prepare('SELECT * FROM "Note" ORDER BY id').all();
      expect(db.prepare('PRAGMA table_info("Baby")').all()).not.toContainEqual(expect.objectContaining({ name: 'gestationalAgeDays' }));
      db.exec(migrationSql);
      expect(db.prepare('SELECT * FROM "Baby" ORDER BY id').all()).toEqual(babies.map(baby => ({ ...(baby as object), gestationalAgeDays: null })));
      expect(db.prepare('SELECT * FROM "Family" ORDER BY id').all()).toEqual(families);
      expect(db.prepare('SELECT * FROM "Note" ORDER BY id').all()).toEqual(notes);
      expect(db.prepare('PRAGMA table_info("Baby")').all()).toContainEqual(expect.objectContaining({ name: 'gestationalAgeDays', type: 'INTEGER', notnull: 0, dflt_value: null }));
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { db.close(); }
  });

  it('exports and restores known, null, and legacy-omitted gestation through serialized JSON', async () => {
    const source = await upgradedFixture('json-source');
    const expected = await snapshot(source.db);
    state.db = source.db;
    const exported = JSON.parse(JSON.stringify(await exportToJSON()));
    expect(exported.Baby.find((baby: { id: string }) => baby.id === childIds[0]).gestationalAgeDays).toBe(235);
    expect(exported.Baby.find((baby: { id: string }) => baby.id === childIds[1]).gestationalAgeDays).toBeNull();
    delete exported.Baby.find((baby: { id: string }) => baby.id === childIds[2]).gestationalAgeDays;
    state.db = emptyRestoreTarget('json-target');
    await importFromJSON(exported);
    expect(await snapshot(state.db)).toEqual(expected);
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('Skipping row'), expect.anything());
  });

  it.each(['legacy', 'current'] as const)('restores a real %s SQLite file with exact birth and care timestamps', async format => {
    const source = await upgradedFixture(format + '-source');
    const expected = format === 'legacy' ? source.legacyState : await snapshot(source.db);
    await source.db.$disconnect();
    const backup = format === 'legacy' ? source.legacyBackup : readFileSync(source.filename);
    state.db = emptyRestoreTarget(format + '-target');
    await importFromSQLiteFile(backup);
    expect(await snapshot(state.db)).toEqual(expected);
    expect((await state.db.baby.findUniqueOrThrow({ where: { id: childIds[0] } })).birthDate.toISOString()).toBe(birthDate);
    expect((await state.db.note.findUniqueOrThrow({ where: { id: 'synthetic-gestation-note' } })).time.toISOString()).toBe(careTime);
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('Skipping row'), expect.anything());
  });
});
