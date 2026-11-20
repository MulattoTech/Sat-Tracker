import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  exportMetadata, exportMetadataFromTransaction, importMetadata, importMetadataInTransaction,
  lockAndAssertEmptyMetadataDestination, lockMetadataSnapshot, validatePortableMetadata,
} from '@/src/lib/portable-recovery/metadata';
import { completeMetadataFixture, createMetadataTestDatabase, metadataInstant, metadataRegistry } from './portableRecoveryTestUtils';

const owned: ReturnType<typeof createMetadataTestDatabase>[] = [];
const open = () => { const fixture = createMetadataTestDatabase(); owned.push(fixture); return fixture; };
const options = { provider: 'sqlite' as const, registry: metadataRegistry };
afterEach(async () => { for (const fixture of owned.splice(0)) await fixture.close(); });

describe('portable metadata isolated SQLite transaction boundary', () => {
  it('restores all 66 models and 766 fields with exact dates, relationships, null, false and zero', async () => {
    const { db } = open(); const metadata = completeMetadataFixture();
    const result = await importMetadata(db, metadata, options);
    expect(result.tablesImported).toBe(66); expect(result.recordsImported).toBe(66);
    const restored = validatePortableMetadata(await exportMetadata(db, { ...options, exportedAt: metadataInstant }), metadataRegistry);
    expect(restored.tableHashes).toEqual(validatePortableMetadata(metadata, metadataRegistry).tableHashes);
    expect(await db.feedback.findUnique({ where: { id: 'synthetic-Feedback' } })).toMatchObject({ parentId: 'synthetic-Feedback', updatedAt: new Date(metadataInstant) });
    expect(await db.account.findUnique({ where: { id: 'synthetic-Account' } })).toMatchObject({ caretakerId: 'synthetic-Caretaker', familyId: 'synthetic-Family', updatedAt: new Date(metadataInstant) });
    expect(await db.diaperLog.findUnique({ where: { id: 'synthetic-DiaperLog' } })).toMatchObject({ rashObserved: null, creamApplied: false });
  });

  it('rejects even one pre-existing reference/seed row without changing the destination', async () => {
    const { db } = open();
    await db.unit.create({ data: { id: 'existing', unitAbbr: 'ML', unitName: 'Existing', activityTypes: 'feed' } });
    const before = await db.unit.findMany();
    await expect(importMetadata(db, completeMetadataFixture(), options)).rejects.toMatchObject({ code: 'DESTINATION_NOT_EMPTY' });
    expect(await db.unit.findMany()).toEqual(before); expect(await db.family.count()).toBe(0);
  });

  it('rolls back every earlier table when a late insert fails', async () => {
    const { db, file } = open(); const native = new Database(file);
    native.exec('CREATE TRIGGER synthetic_reject_ocr_audit BEFORE INSERT ON "OcrAudit" BEGIN SELECT RAISE(ABORT, \'synthetic rejection\'); END'); native.close();
    await expect(importMetadata(db, completeMetadataFixture(), options)).rejects.toMatchObject({ code: 'METADATA_INSERT_FAILED' });
    const after = await exportMetadata(db, options);
    expect(Object.values(after.tables).every(table => table.rowCount === 0)).toBe(true);
  });

  it('rolls back if a trigger changes persisted scalar data without throwing', async () => {
    const { db, file } = open(); const native = new Database(file);
    native.exec('CREATE TRIGGER synthetic_change_caption AFTER INSERT ON "Photo" BEGIN UPDATE "Photo" SET "caption" = \'changed by trigger\' WHERE "id" = NEW."id"; END'); native.close();
    await expect(importMetadata(db, completeMetadataFixture(), options)).rejects.toMatchObject({ code: 'READBACK_MISMATCH' });
    expect(await db.photo.count()).toBe(0); expect(await db.family.count()).toBe(0);
  });

  it('rejects physical extra tables or columns before claiming a complete snapshot', async () => {
    const { db, file } = open(); const native = new Database(file);
    native.exec('CREATE TABLE "UnknownHistory" ("id" TEXT); ALTER TABLE "Baby" ADD COLUMN "unreviewed" TEXT'); native.close();
    await expect(exportMetadata(db, options)).rejects.toMatchObject({ code: 'PHYSICAL_SCHEMA_MISMATCH' });
    await expect(importMetadata(db, completeMetadataFixture(), options)).rejects.toMatchObject({ code: 'PHYSICAL_SCHEMA_MISMATCH' });
    expect(await db.family.count()).toBe(0);
  });

  it('permits only the named diagnostic log table as an explicit application-metadata exclusion', async () => {
    const { db, file } = open(); const native = new Database(file);
    native.exec('CREATE TABLE "api_logs" ("id" INTEGER PRIMARY KEY AUTOINCREMENT); INSERT INTO "api_logs" DEFAULT VALUES'); native.close();
    const result = await importMetadata(db, completeMetadataFixture(), options);
    expect(result.recordsImported).toBe(66);
    const inspection = new Database(file, { readonly: true }); expect(inspection.prepare('SELECT COUNT(*) n FROM "api_logs"').get()).toEqual({ n: 1 }); inspection.close();
  });

  it('requires real transaction and lock capabilities for low-level import/export', async () => {
    const { db } = open(), valid = validatePortableMetadata(completeMetadataFixture(), metadataRegistry);
    await expect(lockMetadataSnapshot(db, options)).rejects.toMatchObject({ code: 'TRANSACTION_REQUIRED' });
    await db.$transaction(async tx => {
      await expect(exportMetadataFromTransaction(tx, options)).rejects.toMatchObject({ code: 'SNAPSHOT_NOT_LOCKED' });
      await expect(importMetadataInTransaction(tx, valid)).rejects.toMatchObject({ code: 'EMPTY_DESTINATION_NOT_LOCKED' });
      await lockAndAssertEmptyMetadataDestination(tx, options);
      expect((await importMetadataInTransaction(tx, valid)).recordsImported).toBe(66);
    }, { timeout: 30_000 });
  });

  it('captures every row across bounded source and readback pages', async () => {
    const { db } = open(); const source = completeMetadataFixture();
    const first = source.tables.Unit.rows[0];
    const rows = Array.from({ length: 257 }, (_, index) => index === 0 ? first : { ...first, id: `page-unit-${index}`, unitAbbr: `SYN${index}` });
    const metadata = { ...source, tables: { ...source.tables, Unit: { rowCount: rows.length, rows } } };
    expect((await importMetadata(db, metadata, options)).recordsImported).toBe(322);
    const actual = validatePortableMetadata(await exportMetadata(db, options), metadataRegistry);
    expect(actual.rowCounts.Unit).toBe(257);
    expect(actual.tableHashes).toEqual(validatePortableMetadata(metadata, metadataRegistry).tableHashes);
  });
});
