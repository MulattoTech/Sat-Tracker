import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeLegacySQLiteDate, readLegacySQLiteMetadata } from '@/src/lib/portable-recovery/legacy-metadata';
import { importMetadata, validatePortableMetadata } from '@/src/lib/portable-recovery/metadata';
import { completeMetadataFixture, createMetadataTestDatabase, metadataInstant, metadataRegistry, migrateNativeSQLite } from './portableRecoveryTestUtils';

const owned: ReturnType<typeof createMetadataTestDatabase>[] = [];
afterEach(async () => { for (const fixture of owned.splice(0)) await fixture.close(); });
function rawDatabase(change?: (db: Database.Database) => void): Buffer {
  const db = new Database(':memory:');
  try { migrateNativeSQLite(db); change?.(db); return db.serialize(); } finally { db.close(); }
}

describe('read-only legacy SQLite metadata adapter', () => {
  it('reads all 66 current tables and exact scalars while explicitly not proving latest live WAL state', async () => {
    const fixture = createMetadataTestDatabase(); owned.push(fixture);
    const metadata = completeMetadataFixture();
    await importMetadata(fixture.db, metadata, { provider: 'sqlite', registry: metadataRegistry });
    const native = new Database(fixture.file);
    let buffer: Buffer;
    try {
      native.prepare('UPDATE "Family" SET "createdAt" = ?').run(Date.parse(metadataInstant));
      native.prepare('UPDATE "Baby" SET "birthDate" = ?').run('2026-11-19T19:02:03.456-06:00');
      native.prepare('UPDATE "Feedback" SET "updatedAt" = ?').run(BigInt(Date.parse(metadataInstant)));
      buffer = native.serialize();
    } finally { native.close(); }
    const before = Buffer.from(buffer);
    const result = await readLegacySQLiteMetadata(buffer, metadataRegistry, { exportedAt: metadataInstant });
    expect(result.snapshot).toEqual({ kind: 'supplied-sqlite-file', latestLiveStateVerified: false });
    expect(result.diagnostics).toEqual([{ code: 'LEGACY_LIVE_STATE_NOT_PROVEN' }]);
    expect(validatePortableMetadata(result.metadata, metadataRegistry).tableHashes).toEqual(validatePortableMetadata(metadata, metadataRegistry).tableHashes);
    expect(buffer.equals(before)).toBe(true);
    expect(result.metadata.tables.DiaperLog.rows[0]).toMatchObject({ rashObserved: null, creamApplied: false });
  });

  it('keeps every empty table and allows only the explicit diagnostic log exclusion', async () => {
    const buffer = rawDatabase(db => db.exec('CREATE TABLE api_logs (id INTEGER PRIMARY KEY AUTOINCREMENT); INSERT INTO api_logs DEFAULT VALUES'));
    const result = await readLegacySQLiteMetadata(buffer, metadataRegistry);
    expect(Object.keys(result.metadata.tables)).toHaveLength(66);
    expect(Object.values(result.metadata.tables).every(table => table.rowCount === 0 && table.rows.length === 0)).toBe(true);
    expect(result.metadata.tables).not.toHaveProperty('api_logs');
  });

  it.each([
    ['missing table', 'DROP TABLE "Pageview"', 'MISSING_PHYSICAL_TABLE'],
    ['missing field', 'ALTER TABLE "Baby" DROP COLUMN "gestationalAgeDays"', 'MISSING_PHYSICAL_COLUMN'],
    ['unknown table', 'CREATE TABLE old_private_records (id TEXT)', 'UNKNOWN_PHYSICAL_TABLE'],
    ['unknown field', 'ALTER TABLE "Baby" ADD COLUMN old_detail TEXT', 'UNKNOWN_PHYSICAL_COLUMN'],
  ])('diagnoses %s without defaulting, repairing or discarding it', async (_label, sql, code) => {
    const buffer = rawDatabase(db => db.exec(sql));
    await expect(readLegacySQLiteMetadata(buffer, metadataRegistry)).rejects.toMatchObject({
      code: 'PHYSICAL_SCHEMA_MISMATCH', diagnostics: expect.arrayContaining([expect.objectContaining({ code })]),
    });
  });

  it('rejects an invalid legacy Boolean instead of coercing a nonzero value', async () => {
    const buffer = rawDatabase(db => db.prepare('INSERT INTO "AppConfig" ("id", "adminPass", "rootDomain", "enablePhotos", "updatedAt") VALUES (?, ?, ?, ?, ?)')
      .run('synthetic-config', 'synthetic-unused', 'synthetic.invalid', 2, metadataInstant));
    await expect(readLegacySQLiteMetadata(buffer, metadataRegistry)).rejects.toMatchObject({ code: 'INVALID_SCALAR' });
  });

  it('reports an ambiguous timestamp by model and field without exposing stored values', async () => {
    const buffer = rawDatabase(db => db.prepare('INSERT INTO "Unit" ("id", "unitAbbr", "unitName", "activityTypes", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)')
      .run('synthetic-unit', 'SYN', 'Synthetic', 'feed', '2026-11-20T01:02:03', metadataInstant));
    await expect(readLegacySQLiteMetadata(buffer, metadataRegistry)).rejects.toMatchObject({
      code: 'INVALID_LEGACY_DATETIME', diagnostics: [{ code: 'INVALID_LEGACY_DATETIME', model: 'Unit', row: 0, field: 'createdAt' }],
    });
  });

  it.each([Buffer.from('not a database'), Buffer.from('SQLite format 3\0truncated')])('rejects invalid or truncated native files', async buffer => {
    await expect(readLegacySQLiteMetadata(buffer, metadataRegistry)).rejects.toMatchObject({ code: expect.stringMatching(/^INVALID_LEGACY_SQLITE$|^LEGACY_SQLITE_READ_FAILED$/) });
  });
});

describe('legacy timestamp normalization', () => {
  it.each([
    [0, '1970-01-01T00:00:00.000Z'],
    [-1, '1969-12-31T23:59:59.999Z'],
    [BigInt(Date.parse(metadataInstant)), metadataInstant],
    ['2026-11-19T19:02:03.456-06:00', metadataInstant],
    ['2026-11-20T06:32:03.456+05:30', metadataInstant],
    ['2026-11-20T01:02:03Z', '2026-11-20T01:02:03.000Z'],
    ['2026-11-20T01:02:03.4Z', '2026-11-20T01:02:03.400Z'],
    ['2026-11-20T01:02:03.45Z', '2026-11-20T01:02:03.450Z'],
  ])('normalizes an explicitly encoded instant %#', (input, expected) => {
    expect(normalizeLegacySQLiteDate(input)).toBe(expected);
  });

  it.each([
    NaN, Infinity, 0.5, BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1), null,
    '2026-11-20T01:02:03', '2026-02-30T01:02:03Z', '2026-11-20T24:00:00Z',
    '2026-11-20T01:02:03.4567Z', '2026-11-20T01:02:03+24:00', '2026-11-20T01:02:03+00:60',
    '1795136523456',
  ])('rejects ambiguous, lossy or invalid timestamps %#', input => {
    expect(() => normalizeLegacySQLiteDate(input)).toThrowError('INVALID_LEGACY_DATETIME');
  });
});
