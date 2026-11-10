'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { snapshotDatabase, multisetMatch, validateBaseline, publicBaselineSource } = require('./verify-live-preservation.cjs');

class Adapter {
  constructor(file, options) { this.db = new DatabaseSync(file, { readOnly: options.readonly }); }
  exec(sql) { this.db.exec(sql); }
  close() { this.db.close(); }
  prepare(sql) {
    const statement = this.db.prepare(sql); let raw = false;
    return {
      raw() { raw = true; return this; },
      safeIntegers() { statement.setReadBigInts(true); return this; },
      all() { return statement.all().map(value => raw ? Object.values(value) : value); },
      *iterate() { for (const value of statement.iterate()) yield raw ? Object.values(value) : value; },
    };
  }
}
const budget = () => ({ rows: 0, deadline: Date.now() + 30_000 });
function fixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sat-live-preservation-'));
  const file = path.join(directory, 'synthetic.db');
  const change = sql => { const db = new DatabaseSync(file); try { db.exec(sql); } finally { db.close(); } };
  try {
    change("CREATE TABLE Care(id TEXT PRIMARY KEY, amount REAL, raw BLOB, note TEXT); CREATE TABLE _prisma_migrations(id TEXT); INSERT INTO Care VALUES ('a', 95, X'80FF', 'PRIVATE_SYNTHETIC_LABEL'), ('b', 70, NULL, NULL)");
    run(file, change);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('appends and additive schema changes preserve every original row; reads do not modify bytes', () => fixture((file, change) => {
  const bytes = fs.readFileSync(file);
  const before = snapshotDatabase(Adapter, file, undefined, budget());
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(before.tables.length, 1);
  assert.ok(!JSON.stringify(before).includes('PRIVATE_SYNTHETIC_LABEL'));
  assert.ok(!JSON.stringify(before).includes('80FF'));
  change("ALTER TABLE Care ADD COLUMN offered REAL; INSERT INTO Care(id, amount) VALUES('new', 30); CREATE TABLE Added(value TEXT); INSERT INTO Added VALUES('new-only'); INSERT INTO _prisma_migrations VALUES('candidate')");
  const migratedBytes = fs.readFileSync(file);
  const after = snapshotDatabase(Adapter, file, before, budget());
  assert.equal(after.summary.baselineRows, 2);
  assert.equal(after.summary.currentRows, 3);
  assert.equal(after.summary.matchedPreexistingRows, 2);
  assert.equal(after.summary.missingOrChangedRows, 0);
  assert.equal(after.summary.additionalOrChangedRows, 1);
  assert.equal(after.summary.addedColumns, 1);
  assert.equal(after.summary.addedTables, 1);
  assert.deepEqual(fs.readFileSync(file), migratedBytes);
}));

test('a changed or deleted old row cannot hide behind increased counts', () => fixture((file, change) => {
  const before = snapshotDatabase(Adapter, file, undefined, budget());
  change("UPDATE Care SET amount=96 WHERE id='a'; INSERT INTO Care(id, amount) VALUES('new1', 20),('new2', 30)");
  let after = snapshotDatabase(Adapter, file, before, budget());
  assert.equal(after.summary.missingOrChangedRows, 1);
  assert.equal(after.summary.additionalOrChangedRows, 3);
  change("DELETE FROM Care WHERE id='b'");
  after = snapshotDatabase(Adapter, file, before, budget());
  assert.equal(after.summary.missingOrChangedRows, 2);
  assert.equal(after.summary.matchedPreexistingRows, 0);
}));

test('duplicate multiplicity, missing columns, missing tables and deadlines are enforced', () => fixture((file, change) => {
  assert.deepEqual(multisetMatch(['a', 'a', 'b'], ['a', 'b', 'c']), { matched: 2, missingOrChanged: 1, additionalOrChanged: 1 });
  const before = snapshotDatabase(Adapter, file, undefined, budget());
  assert.throws(() => snapshotDatabase(Adapter, file, before, { rows: 0, deadline: 0 }), /TIME_LIMIT/);
  change('ALTER TABLE Care RENAME COLUMN amount TO replacement');
  assert.throws(() => snapshotDatabase(Adapter, file, before, budget()), /COLUMN_MISSING/);
  change('DROP TABLE Care');
  assert.throws(() => snapshotDatabase(Adapter, file, before, budget()), /TABLE_MISSING/);
}));

test('baseline validates counts and aggregate digests rather than trusting a permissive manifest', () => fixture(file => {
  const snapshot = snapshotDatabase(Adapter, file, undefined, budget());
  const baseline = { version: 2, algorithm: 'sha256-sorted-typed-row-hashes-v1', kind: 'preexisting-row-multiset', sequencePolicy: 'existing-sqlite-sequences-must-not-decrease',
    runId: 'a'.repeat(32), source: { kind: 'live-readonly', imageId: 'sha256:' + 'b'.repeat(64) },
    createdAt: new Date().toISOString(), databases: { main: snapshot, logs: structuredClone(snapshot) } };
  validateBaseline(baseline);
  const changedCount = structuredClone(baseline); changedCount.databases.main.tables[0].count++;
  assert.throws(() => validateBaseline(changedCount), /COUNT_INVALID/);
  const changedHash = structuredClone(baseline); changedHash.databases.main.tables[0].rowHashes[0] = '0'.repeat(64);
  assert.throws(() => validateBaseline(changedHash), /DIGEST_INVALID/);
  const omittedTables = structuredClone(baseline); omittedTables.databases.main.tables = [];
  assert.throws(() => validateBaseline(omittedTables), /TABLES_INVALID/);
  const extraPrivateMetadata = structuredClone(baseline); extraPrivateMetadata.source.privateNote = 'PRIVATE_DO_NOT_ECHO';
  validateBaseline(extraPrivateMetadata);
  assert.ok(!JSON.stringify(publicBaselineSource(extraPrivateMetadata.source)).includes('PRIVATE_DO_NOT_ECHO'));
  const unboundedDate = structuredClone(baseline); unboundedDate.createdAt += ' '.repeat(1000);
  assert.throws(() => validateBaseline(unboundedDate), /TIME_INVALID/);
}));

test('AUTOINCREMENT metadata may advance, but cannot decrease or hide an edited old log row', () => fixture((file, change) => {
  change("CREATE TABLE ApiLog(id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT); INSERT INTO ApiLog(message) VALUES('synthetic original')");
  const before = snapshotDatabase(Adapter, file, undefined, budget());
  const baseline = { version: 2, algorithm: 'sha256-sorted-typed-row-hashes-v1', kind: 'preexisting-row-multiset', sequencePolicy: 'existing-sqlite-sequences-must-not-decrease',
    runId: 'a'.repeat(32), source: { kind: 'live-readonly', imageId: 'sha256:' + 'b'.repeat(64) },
    createdAt: new Date().toISOString(), databases: { main: before, logs: structuredClone(before) } };
  validateBaseline(baseline);
  const badMetadata = structuredClone(baseline);
  badMetadata.databases.main.tables.find(table => table.name === 'sqlite_sequence').sequenceState[0].sequence = '2';
  assert.throws(() => validateBaseline(badMetadata), /SEQUENCE_DIGEST_MISMATCH/);
  change("INSERT INTO ApiLog(message) VALUES('synthetic append'); CREATE TABLE NewLog(id INTEGER PRIMARY KEY AUTOINCREMENT); INSERT INTO NewLog DEFAULT VALUES");
  let after = snapshotDatabase(Adapter, file, before, budget());
  assert.equal(after.summary.missingOrChangedRows, 0);
  assert.equal(after.summary.matchedPreexistingRows, 3);
  assert.equal(after.summary.additionalOrChangedRows, 1);
  assert.deepEqual(after.summary.sqliteSequenceMetadata, { baselineEntries: 1, currentEntries: 2, advancedEntries: 1, addedEntries: 1 });
  change("UPDATE sqlite_sequence SET seq=0 WHERE name='ApiLog'");
  assert.throws(() => snapshotDatabase(Adapter, file, before, budget()), /SEQUENCE_DECREASED_OR_MISSING/);
  change("UPDATE sqlite_sequence SET seq=2 WHERE name='ApiLog'; UPDATE ApiLog SET message='changed original' WHERE id=1");
  after = snapshotDatabase(Adapter, file, before, budget());
  assert.equal(after.summary.missingOrChangedRows, 1);
  change("DELETE FROM sqlite_sequence WHERE name='ApiLog'");
  assert.throws(() => snapshotDatabase(Adapter, file, before, budget()), /SEQUENCE_DECREASED_OR_MISSING/);
}));
