#!/usr/bin/env node
'use strict';
// Private operational verification. No SQL writes, application HTTP requests,
// plaintext row output, or live-volume mounts by another container.
// capture-restored: /restore/db -> /verification/live-preservation-baseline.json
// capture-live: /db -> /tmp/sat-tracker-preservation-<run-id>.json
// verify-live: /db compared with the private baseline supplied on stdin.
// Every original column and SQLite storage class must remain identical. Extra
// rows are allowed only when every baseline row still matches (multiset check).

const fs = require('node:fs');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const ALGORITHM = 'sha256-sorted-typed-row-hashes-v1';
const BASELINE_VERSION = 2;
const SEQUENCE_POLICY = 'existing-sqlite-sequences-must-not-decrease';
const MAX_TOTAL_ROWS = 500_000;
const MAX_BASELINE_BYTES = 64 * 1024 * 1024;
const MAX_DURATION_MS = 60_000;
const FILES = Object.freeze({ main: 'baby-tracker.db', logs: 'baby-tracker-logs.db' });
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const quote = identifier => '"' + identifier.replaceAll('"', '""') + '"';
class VerificationError extends Error {}
const ensure = (condition, code) => { if (!condition) throw new VerificationError(code); };

function requireDirectory(directory) {
  const stat = fs.lstatSync(directory);
  ensure(stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(directory) === directory, 'UNSAFE_DIRECTORY');
}
function requireRegularFile(file) {
  const stat = fs.lstatSync(file);
  ensure(stat.isFile() && !stat.isSymbolicLink() && fs.realpathSync(file) === file, 'UNSAFE_DATABASE_FILE');
}
function encodeCell(type, value) {
  if (type === 'null') return ['null'];
  if (type === 'integer') {
    ensure(typeof value === 'bigint' || Number.isSafeInteger(value), 'UNSAFE_INTEGER_READ');
    return ['integer', String(value)];
  }
  if (type === 'real') {
    ensure(typeof value === 'number', 'INVALID_REAL_READ');
    const bytes = Buffer.allocUnsafe(8); bytes.writeDoubleBE(value);
    return ['real', bytes.toString('hex')];
  }
  ensure((type === 'text' || type === 'blob') && typeof value === 'string' && /^(?:[A-F0-9]{2})*$/.test(value), 'INVALID_BYTE_READ');
  return [type, value];
}
function rowSetDigest(columns, hashes) {
  const digest = crypto.createHash('sha256').update(ALGORITHM + '\n').update(JSON.stringify(columns) + '\n').update(String(hashes.length) + '\n');
  for (const value of hashes) digest.update(Buffer.from(value, 'hex'));
  return digest.digest('hex');
}
function checkBudget(budget) {
  ensure(Date.now() <= budget.deadline, 'READ_ONLY_VERIFICATION_TIME_LIMIT');
  ensure(budget.rows <= MAX_TOTAL_ROWS, 'TOTAL_ROW_LIMIT_EXCEEDED');
}
function tableHashes(db, name, columns, budget) {
  ensure(columns.length > 0 && columns.length <= 1_000 && new Set(columns).size === columns.length, 'INVALID_COLUMN_SET');
  const projection = columns.flatMap((column, index) => {
    const q = quote(column);
    return [`typeof(${q}) AS ${quote('t' + index)}`, `CASE WHEN typeof(${q}) IN ('text', 'blob') THEN hex(CAST(${q} AS BLOB)) ELSE ${q} END AS ${quote('v' + index)}`];
  });
  const hashes = [];
  for (const row of db.prepare(`SELECT ${projection.join(', ')} FROM ${quote(name)}`).raw().safeIntegers().iterate()) {
    budget.rows++; checkBudget(budget);
    const cells = columns.map((_, index) => encodeCell(row[index * 2], row[index * 2 + 1]));
    hashes.push(sha256(JSON.stringify(cells)));
  }
  hashes.sort();
  return hashes;
}
function multisetMatch(previous, current) {
  let oldIndex = 0, currentIndex = 0, matched = 0;
  while (oldIndex < previous.length && currentIndex < current.length) {
    if (previous[oldIndex] === current[currentIndex]) { matched++; oldIndex++; currentIndex++; }
    else if (previous[oldIndex] < current[currentIndex]) oldIndex++;
    else currentIndex++;
  }
  return { matched, missingOrChanged: previous.length - matched, additionalOrChanged: current.length - matched };
}

function sequenceState(db, tableNames) {
  const values = db.prepare('SELECT name, typeof(name), seq, typeof(seq) FROM sqlite_sequence ORDER BY name COLLATE BINARY').raw().safeIntegers().all();
  const result = values.map(([name, nameType, sequence, sequenceType]) => {
    ensure(nameType === 'text' && typeof name === 'string' && name.length > 0 && name.length <= 1024 && tableNames.includes(name), 'SQLITE_SEQUENCE_NAME_INVALID');
    ensure(sequenceType === 'integer' && typeof sequence === 'bigint' && sequence >= 0n, 'SQLITE_SEQUENCE_VALUE_INVALID');
    return { tableName: name, sequence: String(sequence) };
  });
  ensure(new Set(result.map(value => value.tableName)).size === result.length, 'DUPLICATE_SQLITE_SEQUENCE');
  return result;
}
function compareSequences(previous, current) {
  const byName = new Map(current.map(value => [value.tableName, BigInt(value.sequence)]));
  let advancedEntries = 0;
  for (const value of previous) {
    const now = byName.get(value.tableName), before = BigInt(value.sequence);
    ensure(now !== undefined && now >= before, 'SQLITE_SEQUENCE_DECREASED_OR_MISSING');
    if (now > before) advancedEntries++;
  }
  return { baselineEntries: previous.length, currentEntries: current.length, advancedEntries, addedEntries: current.length - previous.length };
}

function snapshotDatabase(Database, file, previous, budget) {
  requireRegularFile(file);
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 2_000 });
  const startedAt = new Date().toISOString();
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -8192; BEGIN;');
    const integrity = db.prepare('PRAGMA integrity_check').raw().all();
    ensure(integrity.length === 1 && integrity[0][0] === 'ok', 'SQLITE_INTEGRITY_FAILED');
    checkBudget(budget);
    const names = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name <> '_prisma_migrations' ORDER BY name COLLATE BINARY").all().map(row => row.name);
    const requested = previous?.tables || names.map(name => ({ name }));
    const tables = [];
    const summary = { integrity: 'ok', tablesChecked: requested.length, baselineRows: 0, currentRows: 0, matchedPreexistingRows: 0, missingOrChangedRows: 0, additionalOrChangedRows: 0, addedColumns: 0, addedTables: previous ? names.length - requested.length : 0, rowCountsExcludeSqliteSequence: true, sqliteSequenceMetadata: { baselineEntries: 0, currentEntries: 0, advancedEntries: 0, addedEntries: 0 } };
    for (const old of requested) {
      checkBudget(budget);
      ensure(names.includes(old.name), 'PREEXISTING_TABLE_MISSING');
      const actualColumns = db.prepare(`PRAGMA table_xinfo(${quote(old.name)})`).all().map(column => column.name);
      const columns = old.columns || actualColumns;
      ensure(columns.every(column => actualColumns.includes(column)), 'PREEXISTING_COLUMN_MISSING');
      const hashes = tableHashes(db, old.name, columns, budget);
      const table = { name: old.name, columns, count: hashes.length, sha256: rowSetDigest(columns, hashes) };
      if (old.name === 'sqlite_sequence') {
        ensure(JSON.stringify(columns) === '["name","seq"]', 'SQLITE_SEQUENCE_COLUMNS_INVALID');
        const state = sequenceState(db, names);
        if (previous) summary.sqliteSequenceMetadata = compareSequences(old.sequenceState, state);
        else { table.sequenceState = state; table.rowHashes = hashes; summary.sqliteSequenceMetadata.currentEntries = state.length; }
      } else if (previous) {
        summary.currentRows += table.count;
        const result = multisetMatch(old.rowHashes, hashes);
        summary.baselineRows += old.count;
        summary.matchedPreexistingRows += result.matched;
        summary.missingOrChangedRows += result.missingOrChanged;
        summary.additionalOrChangedRows += result.additionalOrChanged;
        summary.addedColumns += actualColumns.length - columns.length;
      } else { summary.currentRows += table.count; table.rowHashes = hashes; }
      tables.push(table);
    }
    const finishedAt = new Date().toISOString();
    summary.sha256 = sha256(JSON.stringify(tables.map(({ name, columns, count, sha256: digest }) => ({ name, columns, count, sha256: digest }))));
    summary.readStartedAt = startedAt;
    summary.readFinishedAt = finishedAt;
    return { tables, summary, readStartedAt: startedAt, readFinishedAt: finishedAt };
  } finally { db.close(); }
}

function validateBaseline(baseline) {
  ensure(baseline.version === BASELINE_VERSION && baseline.algorithm === ALGORITHM && baseline.kind === 'preexisting-row-multiset' && baseline.sequencePolicy === SEQUENCE_POLICY, 'BASELINE_FORMAT_REFUSED');
  ensure(['restored-backup', 'live-readonly'].includes(baseline.source?.kind) && typeof baseline.runId === 'string' && /^[a-f0-9]{32}$/.test(baseline.runId), 'BASELINE_PROVENANCE_INVALID');
  ensure(typeof baseline.createdAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(baseline.createdAt) && Number.isFinite(Date.parse(baseline.createdAt)) && new Date(baseline.createdAt).toISOString() === baseline.createdAt, 'BASELINE_TIME_INVALID');
  if (baseline.source.kind === 'restored-backup') ensure(typeof baseline.source.backupSha256 === 'string' && /^[a-f0-9]{64}$/.test(baseline.source.backupSha256), 'BACKUP_DIGEST_REQUIRED');
  if (baseline.source.kind === 'live-readonly') ensure(typeof baseline.source.imageId === 'string' && /^sha256:[a-f0-9]{64}$/.test(baseline.source.imageId), 'IMAGE_DIGEST_REQUIRED');
  let total = 0;
  for (const alias of Object.keys(FILES)) {
    const tables = baseline.databases?.[alias]?.tables;
    ensure(Array.isArray(tables) && tables.length > 0 && tables.length <= 10_000, 'BASELINE_TABLES_INVALID');
    ensure(new Set(tables.map(table => table.name)).size === tables.length, 'BASELINE_TABLES_INVALID');
    for (const table of tables) {
      ensure(typeof table.name === 'string' && table.name.length <= 1024 && table.name !== '_prisma_migrations', 'BASELINE_TABLE_INVALID');
      ensure(Array.isArray(table.columns) && table.columns.length > 0 && table.columns.length <= 1_000 && table.columns.every(column => typeof column === 'string' && column.length <= 1024) && new Set(table.columns).size === table.columns.length, 'BASELINE_COLUMNS_INVALID');
      ensure(Number.isSafeInteger(table.count) && table.count >= 0 && Array.isArray(table.rowHashes) && table.rowHashes.length === table.count, 'BASELINE_COUNT_INVALID');
      total += table.count; ensure(total <= MAX_TOTAL_ROWS, 'TOTAL_ROW_LIMIT_EXCEEDED');
      ensure(table.rowHashes.every((hash, index) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) && (index === 0 || table.rowHashes[index - 1] <= hash)), 'BASELINE_HASHES_INVALID');
      ensure(table.sha256 === rowSetDigest(table.columns, table.rowHashes), 'BASELINE_TABLE_DIGEST_INVALID');
      if (table.name === 'sqlite_sequence') {
        ensure(JSON.stringify(table.columns) === '["name","seq"]' && Array.isArray(table.sequenceState) && table.sequenceState.length === table.count, 'BASELINE_SEQUENCE_STATE_INVALID');
        const names = new Set();
        const sequenceHashes = table.sequenceState.map(value => {
          ensure(typeof value.tableName === 'string' && value.tableName.length > 0 && value.tableName.length <= 1024 && tables.some(existing => existing.name === value.tableName) && !names.has(value.tableName), 'BASELINE_SEQUENCE_STATE_INVALID');
          names.add(value.tableName);
          ensure(typeof value.sequence === 'string' && /^(0|[1-9]\d{0,18})$/.test(value.sequence) && BigInt(value.sequence) <= 9223372036854775807n, 'BASELINE_SEQUENCE_STATE_INVALID');
          return sha256(JSON.stringify([encodeCell('text', Buffer.from(value.tableName).toString('hex').toUpperCase()), encodeCell('integer', BigInt(value.sequence))]));
        }).sort();
        ensure(sequenceHashes.every((hash, index) => hash === table.rowHashes[index]), 'BASELINE_SEQUENCE_DIGEST_MISMATCH');
      }
    }
  }
}

function publicBaselineSource(source) {
  // A malformed input manifest may contain arbitrary private extra metadata.
  // Never reflect its source object or timestamps without projecting/validating.
  return source.kind === 'restored-backup'
    ? { kind: 'restored-backup', backupSha256: source.backupSha256 }
    : { kind: 'live-readonly', imageId: source.imageId };
}

function readBoundedStdin() {
  const blocks = []; const buffer = Buffer.allocUnsafe(64 * 1024); let total = 0;
  for (;;) {
    const count = fs.readSync(0, buffer, 0, buffer.length, null);
    if (count === 0) break;
    total += count; ensure(total <= MAX_BASELINE_BYTES, 'BASELINE_SIZE_LIMIT_EXCEEDED');
    blocks.push(Buffer.from(buffer.subarray(0, count)));
  }
  ensure(total > 0, 'BASELINE_STDIN_REQUIRED');
  return Buffer.concat(blocks).toString('utf8');
}
function writePrivateBaseline(file, value) {
  const serialized = JSON.stringify(value) + '\n';
  ensure(Buffer.byteLength(serialized) <= MAX_BASELINE_BYTES, 'BASELINE_SIZE_LIMIT_EXCEEDED');
  const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fs.fstatSync(descriptor);
    ensure(stat.isFile() && stat.nlink === 1, 'UNSAFE_BASELINE_OUTPUT');
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, serialized); fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  return sha256(serialized);
}

function main() {
  let phase = 'preflight';
  const mode = process.argv[2];
  const report = { version: 1, status: 'FAIL', mode: ['capture-restored', 'capture-live', 'verify-live'].includes(mode) ? mode : 'invalid', readOnlyDatabaseAccess: true, plaintextRowsEmitted: false, sqliteSequencePolicy: SEQUENCE_POLICY };
  try {
    ensure(process.platform === 'linux' && process.argv.length === 3 && report.mode !== 'invalid', 'MODE_OR_PLATFORM_REFUSED');
    const restored = mode === 'capture-restored';
    const verify = mode === 'verify-live';
    ensure(process.env[restored ? 'SAT_TRACKER_ISOLATED_MIGRATION_QA' : 'SAT_TRACKER_READONLY_LIVE_QA'] === 'true', 'EXPLICIT_READ_ONLY_QA_FLAG_REQUIRED');
    const directory = restored ? '/restore/db' : '/db';
    requireDirectory(directory);
    let baseline, baselineText;
    const runId = process.env.SAT_TRACKER_QA_RUN_ID;
    if (verify) {
      phase = 'read-private-baseline'; baselineText = readBoundedStdin(); baseline = JSON.parse(baselineText); validateBaseline(baseline);
      report.baselineManifestSha256 = sha256(baselineText);
      report.baselineCreatedAt = baseline.createdAt;
      report.baselineSource = publicBaselineSource(baseline.source);
      report.runId = baseline.runId;
    } else {
      ensure(/^[a-f0-9]{32}$/.test(runId), 'UNIQUE_RUN_ID_REQUIRED');
      report.runId = runId;
    }
    const imageId = process.env.SAT_TRACKER_QA_IMAGE_ID;
    const backupSha256 = process.env.SAT_TRACKER_QA_BACKUP_SHA256;
    if (restored) ensure(/^[a-f0-9]{64}$/.test(backupSha256), 'BACKUP_DIGEST_REQUIRED');
    else ensure(/^sha256:[a-f0-9]{64}$/.test(imageId), 'IMAGE_DIGEST_REQUIRED');
    if (!restored) report.observedImageId = imageId; // Caller binds this to docker inspect .Image.
    const Database = createRequire('/app/package.json')('better-sqlite3');
    const budget = { rows: 0, deadline: Date.now() + MAX_DURATION_MS };
    const databases = {};
    report.databases = {};
    for (const [alias, filename] of Object.entries(FILES)) {
      phase = 'database-' + alias;
      const result = snapshotDatabase(Database, directory + '/' + filename, baseline?.databases[alias], budget);
      databases[alias] = { tables: result.tables, readStartedAt: result.readStartedAt, readFinishedAt: result.readFinishedAt };
      report.databases[alias] = result.summary;
    }
    if (verify) {
      ensure(Object.values(report.databases).every(database => database.missingOrChangedRows === 0), 'PREEXISTING_ROWS_MISSING_OR_CHANGED');
      report.allBaselineRowsPreserved = true;
      report.newRowsAllowed = true;
      report.coverage = 'Only rows present in each baseline read snapshot; later writes are outside that baseline.';
    } else {
      phase = 'write-private-baseline';
      const outputDirectory = restored ? '/verification' : '/tmp';
      requireDirectory(outputDirectory);
      const file = restored ? '/verification/live-preservation-baseline.json' : '/tmp/sat-tracker-preservation-' + runId + '.json';
      const source = restored ? { kind: 'restored-backup', backupSha256 } : { kind: 'live-readonly', imageId };
      const captured = { version: BASELINE_VERSION, kind: 'preexisting-row-multiset', algorithm: ALGORITHM, sequencePolicy: SEQUENCE_POLICY, runId, source, createdAt: new Date().toISOString(), databases };
      validateBaseline(captured);
      report.baselineManifestSha256 = writePrivateBaseline(file, captured);
      report.baselineFile = file;
      report.baselineSource = source;
      report.coverage = 'Separate read snapshots of main and logs; no global write freeze was requested.';
    }
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.failedPhase = phase;
    report.error = error instanceof VerificationError ? error.message : 'VERIFICATION_FAILED_NO_PRIVATE_DETAILS_PRINTED';
    process.exitCode = 1;
  }
  console.log(JSON.stringify(report));
}

if (require.main === module) main();
module.exports = { encodeCell, rowSetDigest, multisetMatch, snapshotDatabase, validateBaseline, publicBaselineSource, compareSequences };
