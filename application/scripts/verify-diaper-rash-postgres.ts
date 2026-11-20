/** Run only in the isolated PostgreSQL CI job, after generating its PG client. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { PrismaClient } from '@prisma/client';
import type { DiaperLogCreate } from '../app/api/types';
import { DIAPER_RASH_TEXT_LIMITS } from '../src/utils/diaperRash';

type Check = { name: string; status: 'PASS' | 'FAIL'; error?: string };
const report = {
  syntheticOnly: true,
  provider: 'postgresql',
  serverVersion: null as string | null,
  gitRevision: null as string | null,
  runId: randomUUID(),
  startedAt: new Date().toISOString(),
  completedAt: null as string | null,
  status: 'FAIL' as 'PASS' | 'FAIL',
  checks: [] as Check[],
  backupRestoreScope: 'Canonical JSON and SQLite-file import of four synthetic DiaperLog rows, two Baby rows, one Caretaker, one Family and one Note into this disposable PostgreSQL database; no full installation, pg_dump, media or production restore acceptance.',
  validationScope: 'Real production care-write scalar validation before Prisma writes; authenticated HTTP authorization is covered separately by route integration and browser tests.',
  cleanup: { attempted: false, ownedFixturesRemoved: false, errors: [] as string[] },
  errors: [] as string[],
};
const familyId = 'synthetic-diaper-rash-postgres', caretakerId = 'synthetic-rash-caretaker';
const childIds = ['synthetic-rash-child', 'synthetic-rash-sibling'];
const diaperIds = ['synthetic-rash-observed', 'synthetic-rash-negative', 'synthetic-rash-unknown', 'synthetic-rash-legacy'];
const birthDate = new Date('2026-01-01T06:07:08.123Z'), careTime = new Date('2026-01-02T09:10:11.456Z');
const rashFields = ['rashObserved', ...Object.keys(DIAPER_RASH_TEXT_LIMITS)];
const unknownRash = { rashObserved: null, rashLocation: null, rashDescription: null, rashProductsApplied: null, rashFollowUpNotes: null };
const rashText = {
  rashLocation: ' Synthetic location ', rashDescription: 'Synthetic caregiver wording\nOriginal observation — é',
  rashProductsApplied: '=Synthetic product record', rashFollowUpNotes: 'Synthetic follow-up\nSecond line',
};
const safeError = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/postgres(?:ql)?:\/\/[^\s"']+/g, 'postgresql://[synthetic URL redacted]');

async function check(name: string, work: () => unknown | Promise<unknown>) {
  try {
    await work();
    report.checks.push({ name, status: 'PASS' });
  } catch (error) {
    report.checks.push({ name, status: 'FAIL', error: safeError(error) });
    throw error;
  }
}

async function snapshot(db: PrismaClient) {
  return {
    Family: await db.family.findMany({ orderBy: { id: 'asc' } }),
    Caretaker: await db.caretaker.findMany({ orderBy: { id: 'asc' } }),
    Baby: await db.baby.findMany({ orderBy: { id: 'asc' } }),
    Note: await db.note.findMany({ orderBy: { id: 'asc' } }),
    // The current client must also read the pre-change schema, where the new
    // columns do not exist. SELECT * captures every old scalar for comparison.
    DiaperLog: await db.$queryRaw<Record<string, unknown>[]>`SELECT * FROM "DiaperLog" ORDER BY id`,
  };
}

async function removeOwnedFixtures(db: PrismaClient) {
  await db.$transaction([
    db.note.deleteMany({ where: { familyId } }),
    db.diaperLog.deleteMany({ where: { familyId } }),
    db.baby.deleteMany({ where: { familyId } }),
    db.caretaker.deleteMany({ where: { familyId } }),
    db.family.deleteMany({ where: { id: familyId } }),
  ]);
}

function sqliteBackup(directory: string, rows: Awaited<ReturnType<typeof snapshot>>) {
  const filename = path.join(directory, 'synthetic-rash-backup.db');
  const sqlite = new Database(filename);
  try {
    const migrationsPath = path.join(process.cwd(), 'prisma/migrations');
    for (const entry of readdirSync(migrationsPath, { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      sqlite.exec(readFileSync(path.join(migrationsPath, entry.name, 'migration.sql'), 'utf8'));
    }
    // This newly created synthetic file contains only the scoped records.
    // Remove migration lookup seeds so the test cannot restore unrelated data.
    sqlite.pragma('foreign_keys = OFF');
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    for (const { name } of tables) sqlite.exec(`DELETE FROM "${name.replaceAll('"', '""')}"`);
    for (const [table, records] of Object.entries(rows)) {
      for (const row of records) {
        const entries = Object.entries(row);
        const columns = entries.map(([key]) => `"${key.replaceAll('"', '""')}"`).join(', ');
        const values = entries.map(([, value]) => value instanceof Date ? value.toISOString() : typeof value === 'boolean' ? Number(value) : value);
        sqlite.prepare(`INSERT INTO "${table}" (${columns}) VALUES (${entries.map(() => '?').join(', ')})`).run(...values);
      }
    }
    assert.deepEqual(diaperIds.map(id => (sqlite.prepare('SELECT rashObserved FROM "DiaperLog" WHERE id = ?').get(id) as { rashObserved: number | null }).rashObserved), [1, 0, null, null]);
    assert.deepEqual(sqlite.pragma('foreign_key_check'), []);
  } finally { sqlite.close(); }
  return readFileSync(filename);
}

async function main() {
  let db: PrismaClient | undefined;
  let temporary: string | undefined;
  let ownsFixture = false;
  try {
    // Reject unsafe targets before importing the app DB or invoking Prisma.
    // The exact named database must also start with no public tables.
    assert.equal(process.env.SAT_TRACKER_SYNTHETIC_TEST, '1', 'Explicit synthetic-test flag is required');
    assert.equal(process.env.DATABASE_PROVIDER, 'postgresql', 'Use a separate PostgreSQL-generated client workspace');
    const url = new URL(process.env.DATABASE_URL ?? '');
    assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'PostgreSQL URL is required');
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Only the loopback CI PostgreSQL service is allowed');
    assert.equal(url.pathname, '/sat_tracker_rash_test', 'Only the named disposable test database is allowed');
    assert.ok(url.search === '' || url.search === '?schema=public', 'Only the disposable public schema is allowed');
    report.gitRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const schemaPath = path.join(process.cwd(), 'prisma/schema.prisma');
    const schema = readFileSync(schemaPath, 'utf8');
    assert.match(schema, /datasource\s+db\s*\{\s*provider\s*=\s*"postgresql"/, 'Generate PostgreSQL only in this isolated CI job');
    let baseline = schema;
    for (const name of rashFields) {
      const field = new RegExp(`^[ \\t]*${name}\\s+${name === 'rashObserved' ? 'Boolean' : 'String'}\\?[^\\n]*(?:\\r?\\n|$)`, 'gm');
      assert.equal([...baseline.matchAll(field)].length, 1, `Exactly one nullable ${name} field is expected`);
      baseline = baseline.replace(field, '');
    }
    temporary = mkdtempSync(path.join(tmpdir(), 'sat-rash-postgres-'));
    const baselinePath = path.join(temporary, 'baseline.prisma');
    writeFileSync(baselinePath, baseline);
    const push = (schemaFile: string) => execFileSync(process.execPath, [
      path.join(process.cwd(), 'node_modules/prisma/build/index.js'), 'db', 'push', '--schema', schemaFile,
    ], { cwd: process.cwd(), env: process.env, stdio: 'pipe', timeout: 60_000 });

    const { default: prisma } = await import('../app/api/db');
    db = prisma;
    await check('Disposable PostgreSQL target is empty and uses the intended database', async () => {
      const current = await prisma.$queryRaw<{ name: string; version: string }[]>`SELECT current_database() AS name, version() AS version`;
      assert.equal(current[0].name, 'sat_tracker_rash_test');
      report.serverVersion = current[0].version;
      const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
      assert.deepEqual(tables, []);
    });
    await check('Prisma 7 synchronizes the pre-change PostgreSQL schema without changing the generated client', () => { push(baselinePath); });
    await check('Pre-change schema stores every diaper type with synthetic ownership, history and millisecond timestamps', async () => {
      await prisma.family.create({ data: { id: familyId, slug: familyId, name: 'Synthetic rash PostgreSQL fixture' } });
      ownsFixture = true;
      await prisma.caretaker.create({ data: { id: caretakerId, familyId, loginId: 'synthetic-rash-login', name: 'Synthetic Caregiver', securityPin: '123456' } });
      for (const id of childIds) {
        await prisma.baby.create({ data: { id, familyId, firstName: 'Synthetic', lastName: 'Rash fixture', birthDate, gestationalAgeDays: 235 } });
      }
      await prisma.note.create({ data: { id: 'synthetic-rash-note', familyId, babyId: childIds[0], caretakerId, time: careTime, content: 'Synthetic preserved unrelated care' } });
      for (const [index, id] of diaperIds.entries()) {
        await prisma.diaperLog.create({
          data: {
            id, familyId, babyId: childIds[index % 2], caretakerId, time: careTime,
            type: (['WET', 'DIRTY', 'BOTH', 'DRY'] as const)[index], condition: 'Synthetic condition', color: 'Synthetic color',
            blowout: index % 2 === 1, creamApplied: true, notes: 'Legacy note mentions rash without a structured observation',
            deletedAt: index === 3 ? careTime : null,
          },
          select: { id: true }, // The new columns are intentionally absent yet.
        });
      }
    });
    const before = await snapshot(prisma);
    await check('Additive PostgreSQL schema sync preserves all existing scalars and adds only nullable fields without defaults', async () => {
      push(schemaPath);
      const after = await snapshot(prisma);
      assert.deepEqual({ ...after, DiaperLog: undefined }, { ...before, DiaperLog: undefined });
      assert.deepEqual(after.DiaperLog.map(row => {
        const old = { ...row };
        for (const name of rashFields) { assert.equal(old[name], null); delete old[name]; }
        return old;
      }), before.DiaperLog);
      const columns = await prisma.$queryRaw<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>`
        SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'DiaperLog' AND column_name LIKE 'rash%' ORDER BY column_name`;
      assert.deepEqual(columns, [...rashFields].sort().map(column_name => ({ column_name, data_type: column_name === 'rashObserved' ? 'boolean' : 'text', is_nullable: 'YES', column_default: null })));
    });
    const { readCareWrite, careFields, CareWriteError } = await import('../app/api/utils/care-write');
    const updateObservation = async (id: string, patch: Record<string, unknown>) => {
      const { babyId: _babyId, time, ...data } = await readCareWrite<Partial<DiaperLogCreate>>(new Request('http://localhost/api/diaper-log', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      }), careFields.diaper);
      return prisma.diaperLog.update({ where: { id, familyId }, data: { ...data, ...(time ? { time: new Date(time) } : {}) } });
    };
    await check('Production scalar validation and PostgreSQL retain true false null, exact text limits, omission and independent clears', async () => {
      for (const rashObserved of [true, false, null]) {
        const row = await updateObservation(diaperIds[0], { rashObserved, ...rashText });
        assert.equal(row.rashObserved, rashObserved);
        for (const [key, value] of Object.entries(rashText)) assert.equal(row[key as keyof typeof rashText], value);
        assert.equal(row.time.toISOString(), careTime.toISOString());
      }
      await updateObservation(diaperIds[0], { rashObserved: true });
      const unchanged = await updateObservation(diaperIds[0], { notes: 'Legacy-client notes correction' });
      assert.equal(unchanged.rashObserved, true);
      for (const [key, value] of Object.entries(rashText)) assert.equal(unchanged[key as keyof typeof rashText], value);
      const cleared = await updateObservation(diaperIds[0], { rashLocation: null });
      assert.equal(cleared.rashLocation, null);
      assert.equal(cleared.rashDescription, rashText.rashDescription);
      assert.equal(cleared.rashObserved, true);
      await updateObservation(diaperIds[0], rashText);
      await updateObservation(diaperIds[1], { rashObserved: false, ...rashText });
      for (const [key, maxLength] of Object.entries(DIAPER_RASH_TEXT_LIMITS)) {
        const value = ' ' + 'é'.repeat(maxLength - 3) + '\n ';
        const row = await updateObservation(diaperIds[2], { [key]: value });
        assert.equal(row[key as keyof typeof DIAPER_RASH_TEXT_LIMITS], value);
      }
      await updateObservation(diaperIds[2], unknownRash);
      const after = await snapshot(prisma);
      assert.deepEqual({ ...after, DiaperLog: undefined }, { ...before, DiaperLog: undefined });
      for (const row of after.DiaperLog) {
        const original = before.DiaperLog.find(value => value.id === row.id)!;
        const old = { ...row };
        for (const key of rashFields) delete old[key];
        assert.deepEqual({ ...old, updatedAt: original.updatedAt }, { ...original, notes: row.id === diaperIds[0] ? 'Legacy-client notes correction' : original.notes });
      }
    });
    await check('Rejected production scalar inputs cannot coerce types, exceed text limits or partially change PostgreSQL rows', async () => {
      const prior = await snapshot(prisma);
      const invalid = [
        ...['true', 'false', '', 0, 1, [], { set: true }].map(rashObserved => ({ rashObserved })),
        ...Object.entries(DIAPER_RASH_TEXT_LIMITS).flatMap(([key, maxLength]) => [
          'x'.repeat(maxLength + 1), 1, false, [], { set: 'Synthetic' },
        ].map(value => ({ [key]: value }))),
        { familyId: 'unowned-family' }, { baby: { connect: { id: childIds[1] } } },
      ];
      for (const patch of invalid) {
        await assert.rejects(updateObservation(diaperIds[0], { notes: 'Must not save', ...patch }),
          error => error instanceof CareWriteError && error.status === 400);
        assert.deepEqual(await snapshot(prisma), prior);
      }
    });
    const { exportToJSON, importFromJSON, importFromSQLiteFile } = await import('../app/api/utils/db-backup');
    await check('Canonical JSON restores true false null and legacy-omitted observations with every old scalar preserved', async () => {
      const expected = await snapshot(prisma);
      const data = JSON.parse(JSON.stringify(await exportToJSON()));
      assert.equal(data.DiaperLog.find((row: { id: string }) => row.id === diaperIds[0]).rashObserved, true);
      assert.equal(data.DiaperLog.find((row: { id: string }) => row.id === diaperIds[1]).rashObserved, false);
      for (const key of rashFields) {
        assert.equal(data.DiaperLog.find((row: { id: string }) => row.id === diaperIds[2])[key], null);
        delete data.DiaperLog.find((row: { id: string }) => row.id === diaperIds[3])[key];
      }
      await removeOwnedFixtures(prisma);
      assert.equal(await prisma.diaperLog.count(), 0);
      await importFromJSON(data);
      // Persisted rows, not import attempt counters, establish success.
      assert.deepEqual(await snapshot(prisma), expected);
    });
    await check('Canonical SQLite-file import converts raw 1 0 null observations and restores exact scalar history into PostgreSQL', async () => {
      const expected = await snapshot(prisma);
      const backup = sqliteBackup(temporary!, expected);
      await removeOwnedFixtures(prisma);
      assert.equal(await prisma.diaperLog.count(), 0);
      await importFromSQLiteFile(backup);
      assert.deepEqual(await snapshot(prisma), expected);
    });
    report.status = 'PASS';
  } catch (error) {
    report.errors.push(safeError(error));
  } finally {
    if (db && ownsFixture) {
      report.cleanup.attempted = true;
      try {
        await removeOwnedFixtures(db);
        assert.equal(await db.family.count({ where: { id: familyId } }), 0);
        assert.equal(await db.caretaker.count({ where: { familyId } }), 0);
        assert.equal(await db.baby.count({ where: { familyId } }), 0);
        assert.equal(await db.note.count({ where: { familyId } }), 0);
        assert.equal(await db.diaperLog.count({ where: { familyId } }), 0);
        report.cleanup.ownedFixturesRemoved = true;
      } catch (error) { report.cleanup.errors.push(safeError(error)); }
    }
    if (db) {
      try { await db.$disconnect(); } catch (error) { report.cleanup.errors.push(safeError(error)); }
    }
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    if (report.cleanup.errors.length) report.status = 'FAIL';
    report.completedAt = new Date().toISOString();
    const reportPath = path.join(process.cwd(), 'test-results/diaper-rash-postgres-report.json');
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'PASS') process.exitCode = 1;
  }
}

void main();
