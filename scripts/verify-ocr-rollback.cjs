'use strict';
// Read-only database inspection. HTTP mode authenticates only against this
// container's loopback server, using the fixed synthetic fixture's private PIN.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const requireApp = createRequire('/app/package.json');
const Database = requireApp('better-sqlite3');
const fixture = Object.freeze({ familyId: 'ocr-staging-family', babyId: 'ocr-staging-child', caretakerId: 'ocr-staging-caretaker', familySlug: 'ocr-staging', loginId: '01' });
const fail = code => { const error = new Error(code); error.safeCode = code; throw error; };
const check = (value, code) => { if (!value) fail(code); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const iso = value => new Date(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value).toISOString();
const quoted = name => '"' + name.replace(/"/g, '""') + '"';

function inspectFixtureIdentity(db, tables) {
  const families = db.prepare('SELECT * FROM Family').all();
  const babies = db.prepare('SELECT id, familyId FROM Baby').all();
  const caretakers = db.prepare('SELECT * FROM Caretaker').all();
  const settings = db.prepare('SELECT * FROM Settings').all();
  const seedFamilies = families.filter(row => row.id !== fixture.familyId);
  const seedCaretakers = caretakers.filter(row => row.id !== fixture.caretakerId);
  const seedSettings = settings.filter(row => row.familyId !== fixture.familyId);
  check(families.filter(row => row.id === fixture.familyId).length === 1 && seedFamilies.length <= 1, 'NONFIXTURE_FAMILY_REFUSED');
  check(babies.length === 1 && babies[0].id === fixture.babyId && babies[0].familyId === fixture.familyId, 'NONFIXTURE_CHILD_REFUSED');
  check(caretakers.filter(row => row.id === fixture.caretakerId && row.familyId === fixture.familyId).length === 1 && seedCaretakers.length === seedFamilies.length, 'NONFIXTURE_CARETAKER_REFUSED');
  check(settings.filter(row => row.familyId === fixture.familyId).length === 1 && seedSettings.length === seedFamilies.length, 'NONFIXTURE_SETTINGS_REFUSED');

  // Docker's stock seed runs before the synthetic fixture is created. Permit
  // only its exact untouched defaults from prisma/seed.ts and schema.prisma;
  // names alone never establish that a family contains no real user data.
  const exactDefaults = (row, expected) => Object.entries(expected).every(([key, value]) => row[key] === value) &&
    Object.keys(row).every(key => ['id', 'createdAt', 'updatedAt'].includes(key) || Object.hasOwn(expected, key));
  const seedFamily = seedFamilies[0];
  const seedCaretaker = seedCaretakers[0];
  if (seedFamily) {
    check(exactDefaults(seedFamily, { name: 'My Family', slug: 'my-family', isActive: 1, setupStage: 0, accountId: null }), 'NONFIXTURE_FAMILY_REFUSED');
    check(exactDefaults(seedCaretaker, { familyId: seedFamily.id, loginId: '00', name: 'system', type: 'System Administrator', role: 'ADMIN',
      securityPin: '111222', inactive: 0, deletedAt: null, accountId: null, language: 'en', badgeColor: null, lastSeenVersion: null }), 'NONFIXTURE_CARETAKER_REFUSED');
    check(exactDefaults(seedSettings[0], { familyId: seedFamily.id, familyName: 'My Family', securityPin: '111222', authType: null,
      defaultBottleUnit: 'OZ', defaultSolidsUnit: 'TBSP', defaultHeightUnit: 'IN', defaultWeightUnit: 'LB', defaultTempUnit: 'F',
      activitySettings: null, sleepLocationSettings: null, bathTypeSettings: null, nurseryModeSettings: null,
      enableDebugTimer: 0, enableDebugTimezone: 0, enableBreastMilkTracking: 1, includeSolidsInFeedTimer: 1,
      photoQuotaMB: null, dateFormat: 'MM/DD/YYYY', timeFormat: '12h', growthChartStandard: 'CDC' }), 'NONFIXTURE_SETTINGS_REFUSED');
  }
  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_info(${quoted(table)})`).all().map(row => row.name);
    if (columns.includes('familyId') && !['Caretaker', 'Settings'].includes(table)) {
      check(db.prepare(`SELECT COUNT(*) AS n FROM ${quoted(table)} WHERE familyId IS NOT ?`).get(fixture.familyId).n === 0, 'NONFIXTURE_FAMILY_RECORD_REFUSED');
    }
    if (seedCaretaker) {
      for (const column of ['caretakerId', 'createdBy'].filter(column => columns.includes(column))) {
        check(db.prepare(`SELECT COUNT(*) AS n FROM ${quoted(table)} WHERE ${quoted(column)} = ?`).get(seedCaretaker.id).n === 0, 'STOCK_SEED_CARETAKER_USED');
      }
    }
  }
  return { stockSeedPresent: !!seedFamily };
}

function inspectSourceFiles(documents) {
  // This drill only permits the cloned /app/Files volume. Do not decrypt files
  // or follow a database reference or environment override outside that mount.
  const directory = path.resolve(process.env.BABYTRACKER_OCR_FILES_DIR || '/app/Files/ocr');
  check(directory === '/app/Files/ocr' && fs.realpathSync(directory) === directory, 'SOURCE_DIRECTORY_REFUSED');
  const entries = [];
  for (const document of documents) {
    const previews = JSON.parse(document.previewFiles);
    check(typeof document.sourceFile === 'string' && Array.isArray(previews) && previews.length === document.pageCount && previews.length > 0, 'SOURCE_REFERENCES_MISSING');
    const references = [{ kind: 'original', file: document.sourceFile }, ...previews.map(preview => {
      check(Number.isInteger(preview.page) && preview.page >= 1 && preview.page <= document.pageCount, 'SOURCE_PAGE_INVALID');
      return { kind: `preview:${preview.page}`, file: preview.file };
    })];
    check(new Set(references.map(reference => reference.kind)).size === references.length, 'SOURCE_PAGE_DUPLICATED');
    for (const reference of references) {
      check(typeof reference.file === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\.enc$/i.test(reference.file), 'SOURCE_FILENAME_REFUSED');
      const descriptor = fs.openSync(path.join(directory, reference.file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(descriptor);
        check(stat.isFile() && stat.size > 32 && stat.size <= 64 * 1024 * 1024, 'SOURCE_FILE_INVALID');
        const digest = createHash('sha256');
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let read = 0, size = 0;
        while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
          size += read;
          check(size <= 64 * 1024 * 1024, 'SOURCE_FILE_TOO_LARGE');
          digest.update(buffer.subarray(0, read));
        }
        check(size === stat.size, 'SOURCE_FILE_CHANGED_DURING_READ');
        entries.push({ documentId: document.id, ...reference, size, sha256: digest.digest('hex') });
      } finally { fs.closeSync(descriptor); }
    }
  }
  entries.sort((left, right) => `${left.documentId}:${left.kind}`.localeCompare(`${right.documentId}:${right.kind}`));
  return { encryptedSourceFiles: entries.length, encryptedSourceDigest: hash(entries) };
}

function inspect() {
  check(process.env.BABYTRACKER_SYNTHETIC_STAGING === 'true', 'SYNTHETIC_FLAG_REQUIRED');
  const db = new Database('/db/baby-tracker.db', { readonly: true, fileMustExist: true });
  try {
    db.pragma('query_only = ON');
    check(db.pragma('integrity_check', { simple: true }) === 'ok', 'DATABASE_INTEGRITY_FAILED');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
    const identity = inspectFixtureIdentity(db, tables);
    for (const table of tables) {
      const columns = db.prepare(`PRAGMA table_info(${quoted(table)})`).all().map(row => row.name);
      // Scope every child-bearing table, including deleted historical rows.
      if (columns.includes('babyId')) {
        check(db.prepare(`SELECT COUNT(*) AS n FROM ${quoted(table)} WHERE babyId IS NOT ?`).get(fixture.babyId).n === 0, 'NONFIXTURE_RECORD_REFUSED');
      }
    }
    const feeds = db.prepare('SELECT * FROM FeedLog ORDER BY id').all();
    const diapers = db.prepare('SELECT * FROM DiaperLog ORDER BY id').all();
    check(feeds.length === 1 && diapers.length === 1, 'CANONICAL_FIXTURE_COUNT_MISMATCH');
    check(feeds[0].familyId === fixture.familyId && feeds[0].amount === 95 && feeds[0].unitAbbr === 'ML' && feeds[0].type === 'BOTTLE' && feeds[0].deletedAt == null && iso(feeds[0].time) === '2026-10-20T13:15:00.000Z', 'FEED_FIXTURE_MISMATCH');
    check(diapers[0].familyId === fixture.familyId && diapers[0].type === 'WET' && diapers[0].deletedAt == null && iso(diapers[0].time) === '2026-10-20T14:30:00.000Z', 'DIAPER_FIXTURE_MISMATCH');
    // All other child-bearing care tables must be empty. OCR/provenance are
    // verified separately and may legitimately contain the synthetic import.
    for (const table of tables) {
      const columns = db.prepare(`PRAGMA table_info(${quoted(table)})`).all().map(row => row.name);
      if (columns.includes('babyId') && !['FeedLog', 'DiaperLog', 'OcrDocument'].includes(table)) {
        check(db.prepare(`SELECT COUNT(*) AS n FROM ${quoted(table)}`).get().n === 0, 'UNEXPECTED_SYNTHETIC_CARE_RECORD');
      }
    }
    check(tables.includes('OcrDocument') && tables.includes('OcrAudit'), 'OCR_TABLES_MISSING');
    const documents = db.prepare('SELECT * FROM OcrDocument ORDER BY id').all();
    const audits = db.prepare('SELECT * FROM OcrAudit ORDER BY id').all();
    check(documents.length > 0 && audits.length > 0, 'OCR_HISTORY_MISSING');
    const documentIds = new Set(documents.map(row => row.id));
    check(documents.every(row => row.familyId === fixture.familyId && row.babyId === fixture.babyId) && audits.every(row => documentIds.has(row.documentId)), 'NONFIXTURE_OCR_REFUSED');
    check(tables.includes('ExternalImportRecord'), 'OCR_LEDGER_MISSING');
    const ledger = db.prepare('SELECT * FROM ExternalImportRecord ORDER BY id').all();
    const expectedTargets = new Map([[`FeedLog:${feeds[0].id}`, 'feed'], [`DiaperLog:${diapers[0].id}`, 'diaper']]);
    check(ledger.length === 2 && new Set(ledger.map(row => `${row.targetEntityType}:${row.targetRecordId}`)).size === 2 && ledger.every(row =>
      row.familyId === fixture.familyId && row.providerId === 'babytracker-ocr-v1' && row.sourceChildId === fixture.babyId &&
      expectedTargets.get(`${row.targetEntityType}:${row.targetRecordId}`) === row.sourceEntityType &&
      documents.some(document => typeof row.sourceRecordId === 'string' && row.sourceRecordId.startsWith(`${fixture.babyId}:${document.sourceHash}:`) && row.sourceRecordId.length > `${fixture.babyId}:${document.sourceHash}:`.length)
    ), 'NONFIXTURE_OR_MISSING_OCR_LEDGER');
    const sources = inspectSourceFiles(documents);
    return { public: { passed: true, syntheticOnly: true, databaseIntegrity: true, ...identity, canonicalEvents: 2,
      canonicalDigest: hash({ feeds, diapers }), ocrDocuments: documents.length, ocrAudits: audits.length,
      ocrDigest: hash({ documents, audits }), ledgerRecords: ledger.length, ledgerDigest: hash(ledger), ...sources }, feeds, diapers };
  } finally { db.close(); }
}

async function waitForHttp() {
  const base = 'http://127.0.0.1:3000';
  let ready = false;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try { const response = await fetch(base, { signal: AbortSignal.timeout(1500), redirect: 'manual' }); if (response.status < 500) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  check(ready, 'OLD_APPLICATION_NOT_READY');
}

async function verifyHttp(before) {
  const access = JSON.parse(fs.readFileSync('/app/env/ocr-staging-access.json', 'utf8'));
  for (const key of Object.keys(fixture)) check(access[key] === fixture[key], 'PRIVATE_FIXTURE_IDENTITY_MISMATCH');
  check(typeof access.securityPin === 'string' && /^\d{8}$/.test(access.securityPin), 'PRIVATE_FIXTURE_PIN_INVALID');
  const base = 'http://127.0.0.1:3000';
  const authResponse = await fetch(base + '/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ familySlug: fixture.familySlug, loginId: fixture.loginId, securityPin: access.securityPin }), signal: AbortSignal.timeout(10000), redirect: 'error' });
  const auth = await authResponse.json();
  check(authResponse.ok && auth.success && auth.data?.id === fixture.caretakerId && auth.data?.familyId === fixture.familyId && typeof auth.data?.token === 'string', 'OLD_APPLICATION_AUTH_FAILED');
  const timelineResponse = await fetch(base + '/api/timeline?babyId=' + fixture.babyId + '&limit=100', {
    headers: { Authorization: 'Bearer ' + auth.data.token }, signal: AbortSignal.timeout(10000), redirect: 'error' });
  const timeline = await timelineResponse.json();
  check(timelineResponse.ok && timeline.success && Array.isArray(timeline.data) && timeline.data.length === 2, 'OLD_TIMELINE_COUNT_MISMATCH');
  const feed = timeline.data.find(row => row.id === before.feeds[0].id);
  const diaper = timeline.data.find(row => row.id === before.diapers[0].id);
  check(feed && feed.amount === 95 && feed.unitAbbr === 'ML' && iso(feed.time) === '2026-10-20T13:15:00.000Z', 'OLD_TIMELINE_FEED_MISMATCH');
  check(diaper && diaper.type === 'WET' && iso(diaper.time) === '2026-10-20T14:30:00.000Z', 'OLD_TIMELINE_DIAPER_MISMATCH');
  const after = inspect();
  check(['canonicalDigest', 'ocrDigest', 'ledgerDigest', 'encryptedSourceDigest'].every(key => after.public[key] === before.public[key]), 'HTTP_CHECK_MUTATED_CARE_DATA');
  return { ...after.public, authenticated: true, ordinaryTimelineVerified: true };
}

(async () => {
  const mode = process.argv[2];
  check(['inspect', 'http'].includes(mode), 'INVALID_VERIFICATION_MODE');
  if (mode === 'http') await waitForHttp();
  const before = inspect();
  const result = mode === 'http' ? await verifyHttp(before) : before.public;
  process.stdout.write(JSON.stringify(result) + '\n');
})().catch(error => {
  // Never print DB rows, credentials, JWTs, request payloads, or native errors.
  process.stdout.write(JSON.stringify({ passed: false, error: error.safeCode || 'ROLLBACK_VERIFICATION_FAILED' }) + '\n');
  process.exitCode = 1;
});
