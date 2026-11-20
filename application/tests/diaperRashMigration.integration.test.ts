import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { constants, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PrismaClient } from '@prisma/client';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
vi.mock('../app/api/db', () => ({ get default() { return state.db; } }));
import { exportToJSON, importFromJSON, importFromSQLiteFile } from '../app/api/utils/db-backup';

const migration = '20261120100000_add_diaper_rash_observations';
const migrationsPath = path.join(process.cwd(), 'prisma/migrations');
const migrationSql = readFileSync(path.join(migrationsPath, migration, 'migration.sql'), 'utf8');
const familyId = 'synthetic-rash-family', caretakerId = 'synthetic-rash-caretaker';
const childIds = ['synthetic-rash-child', 'synthetic-rash-sibling'];
const diaperIds = ['synthetic-rash-observed', 'synthetic-rash-negative', 'synthetic-rash-unknown', 'synthetic-rash-legacy'];
const birthDate = '2026-01-01T06:07:08.123Z', careTime = '2026-01-02T09:10:11.456Z';
const rashFields = ['rashObserved', 'rashLocation', 'rashDescription', 'rashProductsApplied', 'rashFollowUpNotes'] as const;
const unknownRash = { rashObserved: null, rashLocation: null, rashDescription: null, rashProductsApplied: null, rashFollowUpNotes: null };
const rashText = {
  rashLocation: ' Synthetic location ', rashDescription: 'Caregiver wording\nSynthetic observation — é',
  rashProductsApplied: '=Synthetic recorded product', rashFollowUpNotes: 'Synthetic follow-up\nSecond line',
};
let directory: string, legacyTemplate: string, restoreTemplate: string;
const clients: PrismaClient[] = [];

/** Build each complete real migration history once, then close before copying. */
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
  const filename = path.join(directory, name + '.db');
  copyFileSync(legacyTemplate, filename, constants.COPYFILE_EXCL);
  const db = new Database(filename);
  db.prepare('INSERT INTO "Family" (id, slug, name, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)')
    .run(familyId, familyId, 'Synthetic rash migration family', birthDate, birthDate);
  db.prepare('INSERT INTO "Caretaker" (id, loginId, name, securityPin, createdAt, updatedAt, familyId) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(caretakerId, 'synthetic-rash-login', 'Synthetic Caregiver', '123456', birthDate, birthDate, familyId);
  const baby = db.prepare('INSERT INTO "Baby" (id, firstName, lastName, birthDate, gestationalAgeDays, createdAt, updatedAt, familyId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  childIds.forEach(id => baby.run(id, 'Synthetic', 'Rash migration fixture', birthDate, 235, birthDate, birthDate, familyId));
  db.prepare('INSERT INTO "Note" (id, time, content, createdAt, updatedAt, familyId, babyId, caretakerId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('synthetic-rash-note', careTime, 'Synthetic preserved unrelated care', careTime, careTime, familyId, childIds[0], caretakerId);
  const diaper = db.prepare('INSERT INTO "DiaperLog" (id, time, type, condition, color, blowout, creamApplied, notes, createdAt, updatedAt, deletedAt, familyId, babyId, caretakerId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  diaperIds.forEach((id, index) => diaper.run(id, careTime, ['WET', 'DIRTY', 'BOTH', 'DRY'][index], 'Synthetic condition', 'Synthetic color', index % 2, 1,
    'Legacy note mentions rash but is not a structured observation', careTime, careTime, index === 3 ? careTime : null, familyId, childIds[index % 2], caretakerId));
  return { filename, db };
}

function client(filename: string) {
  const db = new PrismaClient({ adapter: createPrismaAdapter('file:' + filename) });
  clients.push(db);
  return db;
}

async function snapshot(db: PrismaClient) {
  return {
    families: await db.family.findMany({ orderBy: { id: 'asc' } }),
    caretakers: await db.caretaker.findMany({ orderBy: { id: 'asc' } }),
    babies: await db.baby.findMany({ orderBy: { id: 'asc' } }),
    notes: await db.note.findMany({ orderBy: { id: 'asc' } }),
    diapers: await db.diaperLog.findMany({ orderBy: { id: 'asc' } }),
  };
}

async function upgradedFixture(name: string) {
  const { filename, db: raw } = legacyFixture(name);
  raw.close();
  const legacyBackup = readFileSync(filename);
  const upgrade = new Database(filename);
  try { upgrade.exec(migrationSql); } finally { upgrade.close(); }
  const db = client(filename);
  const legacyState = await snapshot(db);
  await db.diaperLog.update({ where: { id: diaperIds[0] }, data: { rashObserved: true, ...rashText } });
  await db.diaperLog.update({ where: { id: diaperIds[1] }, data: { rashObserved: false, ...rashText } });
  return { filename, db, legacyBackup, legacyState };
}

function emptyRestoreTarget(name: string) {
  const filename = path.join(directory, name + '.db');
  copyFileSync(restoreTemplate, filename, constants.COPYFILE_EXCL);
  const raw = new Database(filename);
  try {
    for (const table of ['Family', 'Caretaker', 'Baby', 'Note', 'DiaperLog']) {
      expect(raw.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get()).toEqual({ count: 0 });
    }
  } finally { raw.close(); }
  return client(filename);
}

beforeAll(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-rash-migration-'));
  const legacy = migratedFile('legacy-template', true);
  legacyTemplate = legacy.filename;
  legacy.db.close();
  const current = migratedFile('restore-template');
  restoreTemplate = current.filename;
  try {
    // Empty only this new synthetic restore template, including lookup seeds.
    current.db.pragma('foreign_keys = OFF');
    const tables = current.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    for (const { name } of tables) current.db.exec(`DELETE FROM "${name.replaceAll('"', '""')}"`);
  } finally { current.db.close(); }
}, 60_000);
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  await Promise.all(clients.map(db => db.$disconnect()));
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('nullable diaper rash migration and actual backup utilities', () => {
  it('adds unknown nullable columns without backfilling or changing any existing diaper, profile, or care value', () => {
    const { db } = legacyFixture('upgrade');
    const { db: independent } = legacyFixture('independent-upgrade');
    const tables = ['Family', 'Caretaker', 'Baby', 'Note', 'DiaperLog'];
    try {
      const before = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY id`).all()]));
      for (const name of rashFields) expect(db.prepare('PRAGMA table_info("DiaperLog")').all()).not.toContainEqual(expect.objectContaining({ name }));
      db.exec(migrationSql);
      expect(db.prepare('SELECT * FROM "DiaperLog" ORDER BY id').all()).toEqual(before.DiaperLog.map(row => ({ ...(row as object), ...unknownRash })));
      for (const table of tables.filter(table => table !== 'DiaperLog')) {
        expect(db.prepare(`SELECT * FROM "${table}" ORDER BY id`).all()).toEqual(before[table]);
      }
      for (const name of rashFields) {
        expect(db.prepare('PRAGMA table_info("DiaperLog")').all()).toContainEqual(expect.objectContaining({ name, type: name === 'rashObserved' ? 'BOOLEAN' : 'TEXT', notnull: 0, dflt_value: null }));
        expect(independent.prepare('PRAGMA table_info("DiaperLog")').all()).not.toContainEqual(expect.objectContaining({ name }));
      }
      db.prepare('UPDATE "DiaperLog" SET rashObserved = 1, notes = ? WHERE id = ?').run('Changed only in this copy', diaperIds[0]);
      for (const table of tables) expect(independent.prepare(`SELECT * FROM "${table}" ORDER BY id`).all()).toEqual(before[table]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { db.close(); independent.close(); }
  });

  it('exports and restores true, false, null, and legacy-omitted rash observations through serialized JSON', async () => {
    const source = await upgradedFixture('json-source');
    const expected = await snapshot(source.db);
    state.db = source.db;
    const exported = JSON.parse(JSON.stringify(await exportToJSON()));
    expect(exported.DiaperLog.find((row: { id: string }) => row.id === diaperIds[0])).toMatchObject({ rashObserved: true, ...rashText });
    expect(exported.DiaperLog.find((row: { id: string }) => row.id === diaperIds[1])).toMatchObject({ rashObserved: false, ...rashText });
    expect(exported.DiaperLog.find((row: { id: string }) => row.id === diaperIds[2])).toMatchObject(unknownRash);
    for (const field of rashFields) delete exported.DiaperLog.find((row: { id: string }) => row.id === diaperIds[3])[field];
    state.db = emptyRestoreTarget('json-target');
    await importFromJSON(exported);
    expect(await snapshot(state.db)).toEqual(expected);
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('Skipping row'), expect.anything());
  });

  it.each(['legacy', 'current'] as const)('restores a real %s SQLite file with exact tri-state, caregiver text, ownership, and timestamps', async format => {
    const source = await upgradedFixture(format + '-source');
    const expected = format === 'legacy' ? source.legacyState : await snapshot(source.db);
    await source.db.$disconnect();
    const backup = format === 'legacy' ? source.legacyBackup : readFileSync(source.filename);
    if (format === 'current') {
      const raw = new Database(source.filename, { readonly: true });
      try {
        expect(diaperIds.map(id => (raw.prepare('SELECT rashObserved FROM "DiaperLog" WHERE id = ?').get(id) as { rashObserved: number | null }).rashObserved)).toEqual([1, 0, null, null]);
      } finally { raw.close(); }
    }
    state.db = emptyRestoreTarget(format + '-target');
    await importFromSQLiteFile(backup);
    expect(await snapshot(state.db)).toEqual(expected);
    expect((await state.db.baby.findUniqueOrThrow({ where: { id: childIds[0] } })).birthDate.toISOString()).toBe(birthDate);
    for (const id of diaperIds) {
      expect((await state.db.diaperLog.findUniqueOrThrow({ where: { id } })).time.toISOString()).toBe(careTime);
    }
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('Skipping row'), expect.anything());
  });
});
