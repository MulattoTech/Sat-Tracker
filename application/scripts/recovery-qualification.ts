/** Real provider matrix on owned, disposable databases. No application singleton, live URL, key or files. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Client } from 'pg';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaPg } from '@prisma/adapter-pg';
import type { PrismaClient, Prisma } from '@prisma/client';
import JSZip from 'jszip';
import { parsePortableSchema } from '../src/lib/portable-recovery/schema';
import { exportMetadata, importMetadata, validatePortableMetadata, type PortableMetadataV1, type PortableProvider } from '../src/lib/portable-recovery/metadata';
import { archiveDigest, createPortableBackup, preparePortableRecovery, recoverPortableArchive } from '../src/lib/portable-recovery/engine';
import { recoveryConfiguration } from '../src/lib/portable-recovery/configuration';
import { assertNativeEmptyDestination } from '../src/lib/portable-recovery/startup-guard';
import { initializeRecoveryInstance, readRecoveryReceipt } from '../src/lib/portable-recovery/storage';
import { readBoundedZip } from '../src/lib/portable-recovery/archive';
import { verifyEncryptedMetadata } from '../src/lib/portable-recovery/crypto';
import { decryptFixtureFile, exportedAt, restoredAt, recoveryFixture, sha256 } from './recovery-qualification-fixtures';

const appRoot = process.cwd(), resultPath = path.join(appRoot, 'test-results/portable-recovery-report.json');
const requireGenerated = createRequire(path.join(appRoot, 'package.json'));
const runId = randomUUID().replaceAll('-', '');
const registry = parsePortableSchema(readFileSync(path.join(appRoot, 'prisma/schema.prisma'), 'utf8'));
const directionChecks = ['archive_preflight', 'bad_key_no_writes', 'wrong_case_no_writes', 'tamper_no_writes', 'changed_digest_no_writes',
  'occupied_database_no_changes', 'occupied_media_no_changes', 'late_failure_rollback', 'strict_restore', 'exact_metadata',
  'retention_and_ciphertext', 'production_readers', 'replay_refused'] as const;
const readerChecks = ['production_auth', 'photo_full_owner', 'photo_thumbnail_owner', 'photo_foreign_denied', 'photo_trash_restricted',
  'vaccine_owner', 'vaccine_foreign_denied', 'feedback_owner', 'feedback_foreign_admin_denied', 'ocr_source_owner', 'ocr_preview_owner',
  'ocr_foreign_denied', 'ocr_expired_unavailable', 'anonymous_denied', 'read_side_effects_bounded'];
type Check = { id: string; status: 'PASS' | 'FAIL'; durationMs: number };
type Direction = { source: PortableProvider; destination: PortableProvider; checks: Check[]; status: 'PASS' | 'FAIL';
  archiveSha256?: string; tableCount?: number; recordCount?: number; filesRestored?: number; ocrOmissions?: number; authenticatedMetadataValues?: number;
  readers?: { artifact: string; checkCount: number; status: 'PASS'; cleanupVerified: true } };
const report = {
  format: 'sat-tracker.portable-recovery-qualification', version: 1, syntheticOnly: true,
  gitRevision: '', workflowSha: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null, startedAt: new Date().toISOString(), completedAt: '',
  nodeVersion: process.version, postgresVersion: '', sqliteVersion: '', schemaFingerprint: registry.fingerprint,
  status: 'FAIL' as 'PASS' | 'FAIL' | 'PARTIAL', mode: 'full-matrix' as 'full-matrix' | 'sqlite-only',
  clientProviders: [] as PortableProvider[], directions: [] as Direction[], errors: [] as { phase: string; name: string; code: string; diagnostics?: unknown }[],
  cleanup: { attempted: false, clientsClosed: false, ownedSchemasRemoved: false, ownedFilesRemoved: false, canonicalClientUnchanged: false, errors: [] as string[] },
};
let phase = 'synthetic guard', temporary = '', admin: Client | undefined;
const clients: PrismaClient[] = [], ownedSchemas: string[] = [];
const constructors = new Map<PortableProvider, new (options: unknown) => PrismaClient>();
const configs = new Map<PortableProvider, string>();
const initialSchema = readFileSync(path.join(appRoot, 'prisma/schema.prisma'));
const canonicalClientSchemaPath = path.join(appRoot, 'node_modules/.prisma/client/schema.prisma');
const initialClientSchema = existsSync(canonicalClientSchemaPath) ? readFileSync(canonicalClientSchemaPath) : null;

function filesSnapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!existsSync(root)) return result;
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const filename = path.join(directory, name), stat = lstatSync(filename), relative = path.relative(root, filename).split(path.sep).join('/');
      assert.ok(!stat.isSymbolicLink(), 'Owned fixture unexpectedly contains a symlink');
      if (stat.isDirectory()) { result[relative + '/'] = 'directory'; visit(filename); }
      else { assert.ok(stat.isFile()); result[relative] = sha256(readFileSync(filename)); }
    }
  };
  visit(root); return result;
}

function orderedTables(metadata: PortableMetadataV1) {
  return Object.fromEntries(registry.models.map(model => [model.name, {
    rowCount: metadata.tables[model.name].rowCount,
    rows: [...metadata.tables[model.name].rows].sort((a, b) => {
      const left = JSON.stringify(model.primaryKey.map(field => a[field])), right = JSON.stringify(model.primaryKey.map(field => b[field]));
      return left < right ? -1 : left > right ? 1 : 0;
    }),
  }]));
}

function prismaCommand(args: string[], config: string, databaseUrl: string) {
  execFileSync(process.execPath, [path.join(appRoot, 'node_modules/prisma/build/index.js'), ...args, '--config', config], {
    cwd: appRoot, env: { ...process.env, DATABASE_URL: databaseUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' }, stdio: 'pipe', timeout: 90_000,
  });
}
async function generate(provider: PortableProvider, databaseUrl: string) {
  phase = `generate isolated ${provider} client`;
  const directory = path.join(temporary, provider); mkdirSync(directory);
  const schemaPath = path.join(directory, 'schema.prisma'), output = path.join(directory, 'client');
  const source = initialSchema.toString('utf8')
    .replace(/(datasource\s+db\s*\{\s*provider\s*=\s*")[^"]+("\s*\})/, `$1${provider}$2`)
    .replace(/(generator\s+client\s*\{)/, `$1\n  output = ${JSON.stringify(output)}`);
  writeFileSync(schemaPath, source);
  const config = path.join(directory, 'prisma.config.ts');
  writeFileSync(config, `export default { schema: ${JSON.stringify(schemaPath)}, datasource: { url: process.env.DATABASE_URL } };\n`);
  prismaCommand(['generate', '--no-hints'], config, databaseUrl);
  const generated = requireGenerated(path.join(output, 'index.js')) as { PrismaClient: new (options: unknown) => PrismaClient };
  assert.match(readFileSync(path.join(output, 'schema.prisma'), 'utf8'), new RegExp(`provider\\s*=\\s*"${provider}"`));
  constructors.set(provider, generated.PrismaClient); configs.set(provider, config); report.clientProviders.push(provider);
}

async function main() {
  assert.equal(process.env.SAT_TRACKER_SYNTHETIC_TEST, '1', 'Explicit synthetic-test opt-in is required');
  const sqliteOnly = process.argv.includes('--sqlite-only');
  assert.ok(process.argv.slice(2).every(argument => argument === '--sqlite-only'), 'Unknown qualification option');
  assert.ok(!sqliteOnly || (!process.env.GITHUB_ACTIONS && process.env.CI !== 'true'), 'CI must exercise all four provider directions');
  report.mode = sqliteOnly ? 'sqlite-only' : 'full-matrix';
  report.gitRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: appRoot, encoding: 'utf8', timeout: 10_000 }).trim();
  let postgresUrl: URL | undefined;
  if (!sqliteOnly) {
    postgresUrl = new URL(process.env.SAT_TRACKER_RECOVERY_TEST_DATABASE_URL ?? '');
    assert.ok(['postgres:', 'postgresql:'].includes(postgresUrl.protocol));
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(postgresUrl.hostname), 'PostgreSQL fixture must use loopback');
    assert.equal(postgresUrl.pathname, '/sat_tracker_recovery_test', 'PostgreSQL fixture must use the dedicated synthetic database');
    assert.ok(postgresUrl.search === '' || postgresUrl.search === '?schema=public', 'Do not supply an existing PostgreSQL schema');
    assert.equal(postgresUrl.hash, '');
    admin = new Client({ connectionString: postgresUrl.toString(), connectionTimeoutMillis: 5_000, query_timeout: 15_000 });
    await admin.connect();
    const identity = await admin.query<{ database: string; version: string }>('SELECT current_database() AS database, version() AS version');
    assert.equal(identity.rows[0].database, 'sat_tracker_recovery_test'); report.postgresVersion = identity.rows[0].version;
  }
  temporary = mkdtempSync(path.join(tmpdir(), 'sat-recovery-qualification-'));
  symlinkSync(path.join(appRoot, 'node_modules'), path.join(temporary, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const sqliteTemplate = path.join(temporary, 'template.db'), native = new Database(sqliteTemplate);
  try {
    for (const directory of readdirSync(path.join(appRoot, 'prisma/migrations')).sort()) {
      if (directory !== 'migration_lock.toml') native.exec(readFileSync(path.join(appRoot, 'prisma/migrations', directory, 'migration.sql'), 'utf8'));
    }
    native.pragma('foreign_keys = ON'); report.sqliteVersion = (native.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version;
  } finally { native.close(); }
  await generate('sqlite', 'file:' + sqliteTemplate);
  if (postgresUrl) await generate('postgresql', postgresUrl.toString());
  const open = async (provider: PortableProvider, label: string) => {
    const directory = path.join(temporary, label); mkdirSync(directory);
    let url: string, adapter: PrismaBetterSqlite3 | PrismaPg;
    if (provider === 'sqlite') {
      const file = path.join(directory, 'application.db'); copyFileSync(sqliteTemplate, file);
      url = 'file:' + file; adapter = new PrismaBetterSqlite3({ url });
    } else {
      const schema = `sat_recovery_${runId}_${label.replaceAll('-', '_')}`;
      assert.match(schema, /^sat_recovery_[a-f0-9]{32}_(?:source_postgresql|destination_[0-3])$/);
      assert.ok(schema.length <= 63);
      await admin!.query(`CREATE SCHEMA "${schema}"`); ownedSchemas.push(schema);
      const scoped = new URL(postgresUrl!.toString()); scoped.searchParams.set('schema', schema); url = scoped.toString();
      prismaCommand(['db', 'push'], configs.get(provider)!, url);
      adapter = new PrismaPg({ connectionString: url, options: `-c search_path=${schema}` }, { schema });
    }
    const Constructor = constructors.get(provider)!; const client = new Constructor({ adapter }); clients.push(client);
    const observedProvider = (client as unknown as { _engineConfig: { activeProvider: string } })._engineConfig.activeProvider;
    assert.equal(observedProvider, provider, 'The provider-generated client must match its real adapter');
    return { client, directory, url, provider, filesRoot: path.join(directory, 'Files') };
  };
  const exactSourceKey = 'aB' + randomBytes(31).toString('hex');
  const fixture = await recoveryFixture(registry, exactSourceKey);
  const providers: PortableProvider[] = sqliteOnly ? ['sqlite'] : ['sqlite', 'postgresql'];
  const sources = new Map<PortableProvider, { bytes: Buffer; client: PrismaClient; filesRoot: string; before: Record<string, string> }>();
  for (const provider of providers) {
    phase = `create ${provider} synthetic source`;
    const source = await open(provider, 'source-' + provider);
    for (const [storagePath, file] of fixture.files) {
      const target = path.join(source.filesRoot, ...storagePath.split('/')); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, file.ciphertext);
    }
    const imported = await importMetadata(source.client, fixture.metadata(provider), { provider, registry });
    assert.equal(imported.tablesImported, 66); assert.equal(imported.recordsImported, 77);
    const before = filesSnapshot(source.filesRoot);
    const bytes = await createPortableBackup({ ...source, registry, exactSourceKey, sourceRevision: report.gitRevision, now: new Date(exportedAt) });
    assert.deepEqual(filesSnapshot(source.filesRoot), before, 'Backup must not mutate source files');
    sources.set(provider, { bytes, client: source.client, filesRoot: source.filesRoot, before });
  }
  let index = 0;
  for (const sourceProvider of providers) for (const destinationProvider of providers) {
    phase = `create ${sourceProvider}->${destinationProvider} synthetic destination`;
    const source = sources.get(sourceProvider)!, destination = await open(destinationProvider, `destination-${index++}`);
    const config = recoveryConfiguration({ NODE_ENV: 'test', SAT_TRACKER_RECOVERY_MODE: '1', SAT_TRACKER_RECOVERY_TOKEN: randomBytes(32).toString('hex'),
      SAT_TRACKER_RECOVERY_DATABASE_URL: destination.url, SAT_TRACKER_RECOVERY_STATE_DIR: path.join(destination.directory, 'private-state') }, destination.directory);
    await assertNativeEmptyDestination(config, registry); await initializeRecoveryInstance(config);
    const direction: Direction = { source: sourceProvider, destination: destinationProvider, checks: [], status: 'FAIL' }; report.directions.push(direction);
    const check = async (id: typeof directionChecks[number], body: () => unknown | Promise<unknown>) => {
      phase = `${sourceProvider}->${destinationProvider}: ${id}`; const started = Date.now();
      try { await body(); direction.checks.push({ id, status: 'PASS', durationMs: Date.now() - started }); }
      catch (error) { direction.checks.push({ id, status: 'FAIL', durationMs: Date.now() - started }); throw error; }
    };
    const metadataSnapshot = async () => validatePortableMetadata(await exportMetadata(destination.client, { provider: destinationProvider, registry, exportedAt }), registry).tableHashes;
    const diskSnapshot = () => ({ files: filesSnapshot(config.filesRoot), state: filesSnapshot(config.stateDir) });
    const emptyTables = await metadataSnapshot(), emptyDisk = diskSnapshot();
    const options = { client: destination.client, config, registry, bytes: source.bytes, exactSourceKey, expectedArchiveSha256: archiveDigest(source.bytes), now: new Date(restoredAt) };
    const assertUnchanged = async (tables = emptyTables, disk = emptyDisk) => {
      assert.deepEqual(await metadataSnapshot(), tables, 'Rejected recovery changed table content'); assert.deepEqual(diskSnapshot(), disk, 'Rejected recovery changed destination files/state');
    };
    const rejectBeforeAccess = async (overrides: Partial<typeof options>) => {
      let calls = 0;
      const observed = new Proxy(destination.client, { get(target, property) {
        if (property === '$transaction') return (...args: unknown[]) => { calls++; return Reflect.apply(target.$transaction, target, args); };
        const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
      await assert.rejects(recoverPortableArchive({ ...options, ...overrides, client: observed }));
      assert.equal(calls, 0, 'Invalid archive/key must fail before destination database access'); await assertUnchanged();
    };
    const prepared = preparePortableRecovery(source.bytes, exactSourceKey, registry, new Date(restoredAt));
    await check('archive_preflight', () => {
      assert.equal(prepared.summary.coverage, 'complete'); assert.equal(prepared.summary.modelCount, 66); assert.equal(prepared.summary.recordCount, 77);
      assert.equal(prepared.archive.media.length, 10); assert.equal(prepared.archive.mediaToRestore.length, 8); assert.equal(prepared.archive.omissions.length, 3);
      assert.equal(prepared.summary.sourceProvider, sourceProvider); assert.equal(prepared.summary.sourceRevision, report.gitRevision);
      assert.deepEqual(prepared.validated.tableHashes, validatePortableMetadata(fixture.metadata(sourceProvider), registry).tableHashes);
      assert.equal(source.bytes.includes(Buffer.from(exactSourceKey)), false, 'Source key must remain outside the archive');
      assert.deepEqual(prepared.archive.manifest.exclusions, { separateApiLogDatabase: true, diagnosticApiLogs: 'separate-or-colocated', environment: true, sourceEncryptionKey: true, unreferencedFiles: true, applicationAndModelAssets: true });
      direction.archiveSha256 = prepared.summary.archiveSha256;
    });
    await check('bad_key_no_writes', () => rejectBeforeAccess({ exactSourceKey: randomBytes(32).toString('hex') }));
    await check('wrong_case_no_writes', () => rejectBeforeAccess({ exactSourceKey: exactSourceKey.toLowerCase() }));
    await check('tamper_no_writes', async () => {
      const entries = readBoundedZip(source.bytes), zip = new JSZip();
      for (const [name, content] of entries) {
        const bytes = Buffer.from(content); if (name === 'metadata.json') bytes[Math.floor(bytes.length / 2)] ^= 1;
        zip.file(name, bytes, { createFolders: false, unixPermissions: 0o100600, date: new Date('1980-01-02T00:00:00.000Z') });
      }
      const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE', platform: 'UNIX', streamFiles: false });
      await rejectBeforeAccess({ bytes, expectedArchiveSha256: archiveDigest(bytes) });
    });
    await check('changed_digest_no_writes', () => rejectBeforeAccess({ expectedArchiveSha256: '0'.repeat(64) }));
    await check('occupied_database_no_changes', async () => {
      await destination.client.unit.create({ data: { id: 'synthetic-existing-unit', unitAbbr: 'SYNTHETIC', unitName: 'Synthetic occupied destination' } });
      const before = await metadataSnapshot(); await assert.rejects(recoverPortableArchive(options), { code: 'DESTINATION_NOT_EMPTY' });
      await assertUnchanged(before); await destination.client.unit.delete({ where: { id: 'synthetic-existing-unit' } }); await assertUnchanged();
    });
    await check('occupied_media_no_changes', async () => {
      mkdirSync(config.filesRoot); const marker = path.join(config.filesRoot, 'synthetic-existing.txt'); writeFileSync(marker, 'Synthetic media must not be overwritten');
      const before = diskSnapshot(); await assert.rejects(recoverPortableArchive(options), { code: 'DESTINATION_NOT_EMPTY' }); await assertUnchanged(emptyTables, before);
      rmSync(marker); rmdirSync(config.filesRoot); await assertUnchanged();
    });
    await check('late_failure_rollback', async () => {
      let injected = false;
      const failAfterPublication = new Proxy(destination.client, { get(target, property) {
        if (property !== '$transaction') { const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value; }
        return (body: (tx: Prisma.TransactionClient) => Promise<unknown>, transactionOptions: unknown) => target.$transaction(async tx => {
          const wrapped = new Proxy(tx, { get(transaction, member) {
            if (member === 'ocrAudit') return new Proxy(transaction.ocrAudit, { get(delegate, method) {
              if (method === 'findMany') return async (...args: unknown[]) => {
                if (existsSync(path.join(config.stateDir, 'recovery.env'))) {
                  assert.equal(injected, false); injected = true;
                  assert.equal(await transaction.photo.count(), 2, 'Late failure must follow real metadata writes');
                  assert.equal(Object.values(filesSnapshot(config.filesRoot)).filter(value => value !== 'directory').length, 8, 'Late failure must follow real media publication');
                  throw new Error('Synthetic readback failure after publication');
                }
                return Reflect.apply(delegate.findMany, delegate, args);
              };
              const value = Reflect.get(delegate, method, delegate); return typeof value === 'function' ? value.bind(delegate) : value;
            } });
            const value = Reflect.get(transaction, member, transaction); return typeof value === 'function' ? value.bind(transaction) : value;
          } });
          return body(wrapped);
        }, transactionOptions as Parameters<PrismaClient['$transaction']>[1]);
      } });
      await assert.rejects(recoverPortableArchive({ ...options, client: failAfterPublication }), { code: 'METADATA_READ_FAILED' });
      assert.equal(injected, true, 'The injected failure must occur after media publication'); await assertUnchanged();
    });
    await check('strict_restore', async () => {
      const receipt = await recoverPortableArchive(options);
      assert.equal(receipt.status, 'RECOVERED'); assert.equal(receipt.destinationProvider, destinationProvider);
      assert.equal(receipt.tablesRestored, 66); assert.equal(receipt.recordsRestored, 77); assert.equal(receipt.filesRestored, 8);
      assert.equal(receipt.verified, true); assert.equal(receipt.activationRequired, true); assert.deepEqual(await readRecoveryReceipt(config), receipt);
      assert.deepEqual(readdirSync(config.stateDir).sort(), ['instance.json', 'receipt.json', 'recovery.env']);
      assert.ok(readFileSync(path.join(config.stateDir, 'recovery.env'), 'utf8') === `ENC_HASH="${exactSourceKey}"\n`, 'Recovered protected configuration must preserve exact source key text');
      if (process.platform !== 'win32') assert.equal(statSync(path.join(config.stateDir, 'recovery.env')).mode & 0o777, 0o600);
      direction.tableCount = receipt.tablesRestored; direction.recordCount = receipt.recordsRestored; direction.filesRestored = receipt.filesRestored;
    });
    await check('exact_metadata', async () => {
      const restored = await exportMetadata(destination.client, { provider: destinationProvider, registry, exportedAt });
      assert.deepEqual(validatePortableMetadata(restored, registry).tableHashes, prepared.validated.tableHashes, 'All scalars, timestamps and relationships must match across providers');
      assert.deepEqual(orderedTables(restored), orderedTables(prepared.validated.metadata), 'Provider row order cannot change exact record identity');
      assert.equal(restored.tables.Feedback.rows[0].parentId, 'synthetic-Feedback');
      assert.equal(restored.tables.Account.rows[0].caretakerId, 'synthetic-Caretaker');
      assert.equal(restored.tables.DiaperLog.rows[0].rashObserved, null); assert.equal(restored.tables.DiaperLog.rows[0].creamApplied, false);
      const encrypted = verifyEncryptedMetadata(restored, exactSourceKey); assert.equal(encrypted.authenticatedValues, 17); assert.equal(encrypted.legacyPlaintextValues, 0);
      direction.authenticatedMetadataValues = encrypted.authenticatedValues;
    });
    await check('retention_and_ciphertext', async () => {
      const actual = filesSnapshot(config.filesRoot), expectedFiles = prepared.archive.mediaToRestore.map(item => item.storagePath).sort();
      assert.deepEqual(Object.keys(actual).filter(name => !name.endsWith('/')).sort(), expectedFiles);
      for (const item of prepared.archive.mediaToRestore) {
        const restored = readFileSync(path.join(config.filesRoot, ...item.storagePath.split('/'))), expected = fixture.files.get(item.storagePath)!;
        assert.deepEqual(restored, expected.ciphertext, 'Ciphertext must remain byte-identical');
        const plaintext = decryptFixtureFile(restored, exactSourceKey); assert.deepEqual(plaintext, expected.plaintext, 'Restored file must actually decrypt to the original media'); plaintext.fill(0);
      }
      for (const omission of prepared.archive.omissions) for (const name of omission.storagePaths) assert.equal(existsSync(path.join(config.filesRoot, ...name.split('/'))), false);
      assert.deepEqual(filesSnapshot(source.filesRoot), source.before, 'Recovery must never alter the source files');
      const unchangedSource = await exportMetadata(source.client, { provider: sourceProvider, registry, exportedAt });
      assert.deepEqual(validatePortableMetadata(unchangedSource, registry).tableHashes, prepared.validated.tableHashes, 'Recovery must never alter source metadata');
      direction.ocrOmissions = prepared.archive.omissions.length;
    });
    await check('production_readers', async () => {
      const inputPath = path.join(destination.directory, 'reader-input.json');
      const childReportPath = path.join(destination.directory, 'reader-report.json');
      const artifact = `portable-recovery-readers-${sourceProvider}-to-${destinationProvider}.json`;
      const input = { format: 'sat-tracker.recovery-reader-input', version: 1, syntheticOnly: true, qualificationId: runId,
        gitRevision: report.gitRevision, provider: destinationProvider, databaseUrl: destination.url,
        generatedClientPath: path.join(temporary, destinationProvider, 'client/index.js'), applicationRoot: appRoot,
        destinationRoot: destination.directory, sourceKey: exactSourceKey, clockInstant: restoredAt, ocrIds: fixture.ocrIds,
        media: prepared.archive.mediaToRestore.map(item => ({ storagePath: item.storagePath,
          plaintextSha256: sha256(fixture.files.get(item.storagePath)!.plaintext), plaintextBytes: fixture.files.get(item.storagePath)!.plaintext.length })) };
      writeFileSync(inputPath, JSON.stringify(input), { flag: 'wx', mode: 0o600 });
      let childError: unknown;
      try {
        execFileSync(process.execPath, ['--import', 'tsx', path.join(appRoot, 'scripts/recovery-read-qualification.ts'), inputPath], {
          cwd: appRoot, env: { ...process.env, TSX_TSCONFIG_PATH: path.join(appRoot, 'tsconfig.json'), SAT_TRACKER_SYNTHETIC_TEST: '1' },
          timeout: 60_000, stdio: 'pipe', maxBuffer: 2 * 1024 * 1024,
        });
      } catch (error) { childError = error; }
      finally {
        rmSync(inputPath, { force: true });
        if (existsSync(childReportPath)) {
          const raw = readFileSync(childReportPath, 'utf8');
          assert.equal(raw.includes(exactSourceKey), false, 'Reader evidence must never contain the source key');
          mkdirSync(path.dirname(resultPath), { recursive: true }); writeFileSync(path.join(path.dirname(resultPath), artifact), raw);
        }
      }
      if (childError) throw childError;
      const reader = JSON.parse(readFileSync(childReportPath, 'utf8'));
      assert.equal(reader.format, 'sat-tracker.recovery-reader-qualification'); assert.equal(reader.version, 1);
      assert.equal(reader.syntheticOnly, true); assert.equal(reader.qualificationId, runId);
      assert.equal(reader.gitRevision, report.gitRevision); assert.equal(reader.provider, destinationProvider); assert.equal(reader.clockInstant, restoredAt);
      assert.equal(reader.status, 'PASS'); assert.deepEqual(reader.checks.map((item: Check) => item.id), readerChecks);
      assert.ok(reader.checks.every((item: Check) => item.status === 'PASS')); assert.deepEqual(reader.errors, []); assert.deepEqual(reader.cleanup.errors, []);
      assert.equal(reader.normalStartupUsed, false); assert.equal(reader.recoveryModeRetained, true);
      assert.deepEqual(reader.retention, { purgedDocumentCount: 2, addedAuditCount: 2, unchangedModelCount: 64, filesUnchanged: true });
      for (const key of ['clientClosed', 'clockRestored', 'syntheticSecretsCleared']) assert.equal(reader.cleanup[key], true);
      direction.readers = { artifact, checkCount: reader.checks.length, status: 'PASS', cleanupVerified: true };
    });
    await check('replay_refused', async () => {
      const beforeTables = await metadataSnapshot(), beforeDisk = diskSnapshot();
      await assert.rejects(recoverPortableArchive(options), { code: 'RECOVERY_ALREADY_STARTED' }); await assertUnchanged(beforeTables, beforeDisk);
    });
    assert.deepEqual(direction.checks.map(check => check.id), directionChecks); direction.status = 'PASS';
    console.log(`${sourceProvider} -> ${destinationProvider}: ${direction.checks.length} checks PASS; 66 tables, 77 records, 8 authenticated files`);
  }
  assert.equal(report.directions.length, sqliteOnly ? 1 : 4);
  report.status = sqliteOnly ? 'PARTIAL' : 'PASS';
}

main().catch(error => {
  report.errors.push({ phase, name: error?.name ?? 'Error', code: error?.code ?? 'QUALIFICATION_FAILED', ...(Array.isArray(error?.diagnostics) ? { diagnostics: error.diagnostics } : {}) });
  console.error(`Portable recovery qualification failed during ${phase}: ${error?.code ?? error?.name ?? 'Error'}`);
  // Stack locations aid diagnosis without printing assertion values, connection URLs or keys.
  console.error(String(error?.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 5).join('\n'));
  process.exitCode = 1;
}).finally(async () => {
  report.cleanup.attempted = true;
  const closed = await Promise.allSettled(clients.map(client => client.$disconnect()));
  report.cleanup.clientsClosed = closed.every(result => result.status === 'fulfilled');
  if (!report.cleanup.clientsClosed) report.cleanup.errors.push('CLIENT_DISCONNECT_FAILED');
  try {
    for (const schema of [...ownedSchemas].reverse()) {
      assert.ok(schema.startsWith(`sat_recovery_${runId}_`));
      await admin!.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
    if (admin && ownedSchemas.length) {
      const remaining = await admin.query('SELECT nspname FROM pg_namespace WHERE nspname = ANY($1::text[])', [ownedSchemas]); assert.equal(remaining.rowCount, 0);
    }
    report.cleanup.ownedSchemasRemoved = true;
  } catch { report.cleanup.errors.push('OWNED_SCHEMA_CLEANUP_FAILED'); }
  if (admin) await admin.end().catch(() => { report.cleanup.errors.push('POSTGRES_ADMIN_DISCONNECT_FAILED'); });
  try {
    if (temporary) { assert.ok(path.basename(temporary).startsWith('sat-recovery-qualification-')); rmSync(temporary, { recursive: true, force: true }); assert.equal(existsSync(temporary), false); }
    report.cleanup.ownedFilesRemoved = true;
  } catch { report.cleanup.errors.push('OWNED_FILE_CLEANUP_FAILED'); }
  try {
    assert.deepEqual(readFileSync(path.join(appRoot, 'prisma/schema.prisma')), initialSchema);
    assert.deepEqual(existsSync(canonicalClientSchemaPath) ? readFileSync(canonicalClientSchemaPath) : null, initialClientSchema);
    report.cleanup.canonicalClientUnchanged = true;
  } catch { report.cleanup.errors.push('CANONICAL_PROVIDER_CHANGED'); }
  if (report.cleanup.errors.length) { report.status = 'FAIL'; process.exitCode = 1; }
  report.completedAt = new Date().toISOString(); mkdirSync(path.dirname(resultPath), { recursive: true }); writeFileSync(resultPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`Portable recovery ${report.status}; synthetic receipt: test-results/portable-recovery-report.json`);
});
