/** Run only in the isolated PostgreSQL CI job, after generating its PG client. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';

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
  backupRestoreScope: 'Canonical JSON export/import of three synthetic Baby rows, one Family and one Note in this disposable database; no full installation or production restore acceptance.',
  cleanup: { attempted: false, ownedFixturesRemoved: false, errors: [] as string[] },
  errors: [] as string[],
};
const familyId = 'synthetic-gestational-age-postgres';
const childIds = ['synthetic-gestation-known', 'synthetic-gestation-unknown', 'synthetic-gestation-legacy'];
const birthDate = new Date('2026-01-01T06:07:08.123Z');
const careTime = new Date('2026-01-02T09:10:11.456Z');
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
    families: await db.family.findMany({ orderBy: { id: 'asc' } }),
    babies: await db.$queryRaw<Record<string, unknown>[]>`SELECT * FROM "Baby" ORDER BY id`,
    notes: await db.note.findMany({ orderBy: { id: 'asc' } }),
  };
}

async function removeOwnedFixtures(db: PrismaClient) {
  await db.$transaction([
    db.note.deleteMany({ where: { familyId } }),
    db.baby.deleteMany({ where: { familyId } }),
    db.family.deleteMany({ where: { id: familyId } }),
  ]);
}

async function main() {
  let db: PrismaClient | undefined;
  let temporary: string | undefined;
  let ownsFixture = false;
  try {
    // Reject unsafe targets before importing the application DB singleton or
    // invoking any Prisma command. The service must also start with no tables.
    assert.equal(process.env.SAT_TRACKER_SYNTHETIC_TEST, '1', 'Explicit synthetic-test flag is required');
    assert.equal(process.env.DATABASE_PROVIDER, 'postgresql', 'Use a separate PostgreSQL-generated client workspace');
    const url = new URL(process.env.DATABASE_URL ?? '');
    assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'PostgreSQL URL is required');
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Only the loopback CI PostgreSQL service is allowed');
    assert.equal(url.pathname, '/sat_tracker_gestation_test', 'Only the named disposable test database is allowed');
    assert.ok(url.search === '' || url.search === '?schema=public', 'Only the disposable public schema is allowed');
    report.gitRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const schemaPath = path.join(process.cwd(), 'prisma/schema.prisma');
    const schema = readFileSync(schemaPath, 'utf8');
    assert.match(schema, /datasource\s+db\s*\{\s*provider\s*=\s*"postgresql"/, 'Generate PostgreSQL only in this isolated CI job');
    const field = /^[ \t]*gestationalAgeDays\s+Int\?[^\n]*(?:\r?\n|$)/gm;
    assert.equal([...schema.matchAll(field)].length, 1, 'Exactly one nullable gestational age field is expected');
    temporary = mkdtempSync(path.join(tmpdir(), 'sat-gestation-postgres-'));
    const baselinePath = path.join(temporary, 'baseline.prisma');
    writeFileSync(baselinePath, schema.replace(field, ''));
    const push = (schemaFile: string) => execFileSync(process.execPath, [
      path.join(process.cwd(), 'node_modules/prisma/build/index.js'), 'db', 'push', '--schema', schemaFile,
    ], { cwd: process.cwd(), env: process.env, stdio: 'pipe', timeout: 60_000 });

    const { default: prisma } = await import('../app/api/db');
    db = prisma;
    await check('Disposable PostgreSQL target is empty and uses the intended database', async () => {
      const current = await prisma.$queryRaw<{ name: string; version: string }[]>`SELECT current_database() AS name, version() AS version`;
      assert.equal(current[0].name, 'sat_tracker_gestation_test');
      report.serverVersion = current[0].version;
      const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
      assert.deepEqual(tables, []);
    });
    await check('Prisma 7 synchronizes the pre-change PostgreSQL schema without generating or rewriting the client', () => { push(baselinePath); });
    await check('Pre-change schema stores synthetic millisecond birth timestamps and linked care', async () => {
      await prisma.family.create({ data: { id: familyId, slug: familyId, name: 'Synthetic PostgreSQL fixture' } });
      ownsFixture = true;
      for (const id of childIds) {
        // The current generated client is also used against the baseline: do
        // not select the newly added column until the additive sync completes.
        await prisma.baby.create({
          data: { id, familyId, firstName: 'Synthetic', lastName: 'Gestation fixture', birthDate },
          select: { id: true },
        });
      }
      await prisma.note.create({ data: { id: 'synthetic-gestation-note', familyId, babyId: childIds[0], time: careTime, content: 'Synthetic preserved care' } });
    });
    const before = await snapshot(prisma);
    await check('Additive PostgreSQL schema sync preserves every existing birth, profile, family and care value', async () => {
      push(schemaPath);
      const after = await snapshot(prisma);
      assert.deepEqual(after.families, before.families);
      assert.deepEqual(after.notes, before.notes);
      assert.deepEqual(after.babies.map(({ gestationalAgeDays, ...baby }) => {
        assert.equal(gestationalAgeDays, null);
        return baby;
      }), before.babies);
      const columns = await prisma.$queryRaw<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
        SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'Baby' AND column_name = 'gestationalAgeDays'`;
      assert.deepEqual(columns, [{ data_type: 'integer', is_nullable: 'YES', column_default: null }]);
    });
    await check('Prisma PostgreSQL writes retain whole days, preserve omission and clear only on explicit null', async () => {
      for (const gestationalAgeDays of [1, 315, 235]) {
        const baby = await prisma.baby.update({ where: { id: childIds[0] }, data: { gestationalAgeDays } });
        assert.equal(baby.gestationalAgeDays, gestationalAgeDays);
        assert.equal(baby.birthDate.toISOString(), birthDate.toISOString());
      }
      const unchanged = await prisma.baby.update({ where: { id: childIds[0] }, data: { firstName: 'Corrected synthetic name' } });
      assert.equal(unchanged.gestationalAgeDays, 235);
      const prior = await snapshot(prisma);
      await assert.rejects(prisma.baby.update({ where: { id: childIds[0] }, data: { gestationalAgeDays: 234.5 } }));
      assert.deepEqual(await snapshot(prisma), prior);
      const cleared = await prisma.baby.update({ where: { id: childIds[0] }, data: { gestationalAgeDays: null } });
      assert.equal(cleared.gestationalAgeDays, null);
      assert.equal(cleared.birthDate.toISOString(), birthDate.toISOString());
      assert.deepEqual((await snapshot(prisma)).notes, before.notes);
      await prisma.baby.update({ where: { id: childIds[0] }, data: { gestationalAgeDays: 235 } });
    });
    await check('Canonical JSON backup restores known, null and legacy-omitted gestation with exact birth and care values', async () => {
      const { exportToJSON, importFromJSON } = await import('../app/api/utils/db-backup');
      const expected = await snapshot(prisma);
      const data = JSON.parse(JSON.stringify(await exportToJSON()));
      assert.equal(data.Baby.find((baby: { id: string }) => baby.id === childIds[0]).gestationalAgeDays, 235);
      assert.equal(data.Baby.find((baby: { id: string }) => baby.id === childIds[1]).gestationalAgeDays, null);
      delete data.Baby.find((baby: { id: string }) => baby.id === childIds[2]).gestationalAgeDays;
      await removeOwnedFixtures(prisma);
      assert.equal(await prisma.baby.count(), 0);
      await importFromJSON(data);
      // Import counters count attempted rows. The persisted records are the
      // acceptance oracle, including original identifiers and timestamps.
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
        assert.equal(await db.baby.count({ where: { familyId } }), 0);
        assert.equal(await db.note.count({ where: { familyId } }), 0);
        report.cleanup.ownedFixturesRemoved = true;
      } catch (error) { report.cleanup.errors.push(safeError(error)); }
    }
    if (db) {
      try { await db.$disconnect(); } catch (error) { report.cleanup.errors.push(safeError(error)); }
    }
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    if (report.cleanup.errors.length) report.status = 'FAIL';
    report.completedAt = new Date().toISOString();
    const reportPath = path.join(process.cwd(), 'test-results/gestational-age-postgres-report.json');
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'PASS') process.exitCode = 1;
  }
}

void main();
