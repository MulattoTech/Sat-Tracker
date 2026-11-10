// Authenticated HTTP acceptance against the runner's compiled local app and
// disposable database. These checks use real USER logins and a real read-only
// API key, plus an explicitly writable key for a notes-only correction of its
// own synthetic record. They do not use a browser session or real history.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';

export async function verifyFamilyReadBoundaries({ base, db, secret, reportDir }) {
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  const prefix = `family-read-${randomUUID().slice(0, 8)}`;
  const checks = [];
  const report = { runId: process.env.SAT_TRACKER_ACCEPTANCE_RUN_ID || null, syntheticOnly: true,
    kind: 'authenticated-http', authentication: [], checks, responses: {}, startedAt: new Date().toISOString() };
  const persist = () => {
    if (reportDir) {
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(path.join(reportDir, 'family-read-boundary-http-report.json'), JSON.stringify(report, null, 2));
    }
  };
  const check = name => { checks.push(`Authenticated HTTP: ${name}`); persist(); };
  const request = (route, token, method = 'GET', body) => fetch(`${base}${route}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  async function read(label, route, token, expectedStatus = 200) {
    const response = await request(route, token), body = await response.json();
    report.responses[label] = { route, status: response.status, body }; persist();
    assert.equal(response.status, expectedStatus, label);
    if (expectedStatus === 200) assert.equal(body.success, true, label);
    return body.data;
  }
  async function exported(label, route, token, format) {
    const response = await request(route, token); assert.equal(response.status, 200, label);
    let rows;
    if (format === 'csv') rows = parse(await response.text(), { columns: true });
    else {
      const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await response.arrayBuffer());
      const sheet = workbook.worksheets[0], headers = sheet.getRow(1).values.slice(1); rows = [];
      sheet.eachRow((row, index) => { if (index > 1) rows.push(Object.fromEntries(headers.map((header, i) => [header, row.getCell(i + 1).text]))); });
    }
    report.responses[label] = { route, status: response.status, contentType: response.headers.get('content-type'), rows }; persist();
    return rows;
  }

  try {
    const families = [];
    for (const suffix of ['a', 'b']) {
      const family = await db.family.create({ data: { slug: `${prefix}-${suffix}`, name: `Synthetic HTTP family ${suffix}`, setupStage: 3 } });
      await db.settings.create({ data: { familyId: family.id, authType: 'CARETAKER' } }); families.push(family);
    }
    const [family, foreignFamily] = families;
    await db.unit.upsert({ where: { unitAbbr: 'ML' }, update: {}, create: { unitAbbr: 'ML', unitName: 'Milliliters' } });
    const actor = (owner, loginId, name, role = 'USER', deletedAt = null) => db.caretaker.create({ data: {
      familyId: owner.id, loginId, name: `Synthetic ${name}`, securityPin: '742809', role, deletedAt,
    } });
    const caregiver = await actor(family, '01', 'owned caregiver');
    const admin = await actor(family, '02', 'owned admin', 'ADMIN');
    const oldCaregiver = await actor(family, '03', 'owned deleted caregiver', 'USER', new Date('2026-01-02T00:00:00Z'));
    const foreignCaregiver = await actor(foreignFamily, '01', 'foreign caregiver');
    const child = owner => db.baby.create({ data: { familyId: owner.id, firstName: 'Synthetic', lastName: 'Read Child', birthDate: new Date('2026-01-01T00:00:00Z') } });
    const baby = await child(family), foreignBaby = await child(foreignFamily);
    const medicine = await db.medicine.create({ data: { familyId: family.id, name: 'Synthetic owned medicine', unitAbbr: 'ML' } });
    const oldMedicine = await db.medicine.create({ data: { familyId: family.id, name: 'Synthetic owned deleted medicine', deletedAt: new Date('2026-01-02T00:00:00Z') } });
    const foreignMedicine = await db.medicine.create({ data: { familyId: foreignFamily.id, name: 'PRIVATE_FOREIGN_MEDICINE', unitAbbr: 'ML' } });
    const foreignSupplement = await db.medicine.create({ data: { familyId: foreignFamily.id, name: 'PRIVATE_FOREIGN_SUPPLEMENT', isSupplement: true } });
    const food = await db.food.create({ data: { familyId: family.id, name: 'Synthetic owned food' } });
    const oldFood = await db.food.create({ data: { familyId: family.id, name: 'Synthetic owned deleted food', deletedAt: new Date('2026-01-02T00:00:00Z') } });
    const foreignFood = await db.food.create({ data: { familyId: foreignFamily.id, name: 'PRIVATE_FOREIGN_FOOD', commonAllergen: true } });
    const scope = { familyId: family.id, babyId: baby.id, caretakerId: caregiver.id };
    let sequence = 0; const start = Date.now() - 120000, stamp = () => new Date(start + sequence++ * 100);
    const own = {};
    own.diaper = await db.diaperLog.create({ data: { ...scope, time: stamp(), type: 'WET', notes: 'OWN_NORMAL_DIAPER' } });
    own.badCaretaker = await db.diaperLog.create({ data: { ...scope, caretakerId: foreignCaregiver.id, time: stamp(), type: 'DRY', notes: 'OWN_CROSS_CARETAKER' } });
    own.medicine = await db.medicineLog.create({ data: { ...scope, medicineId: medicine.id, time: stamp(), doseAmount: 1, notes: 'OWN_NORMAL_DOSE' } });
    own.badMedicine = await db.medicineLog.create({ data: { ...scope, caretakerId: foreignCaregiver.id, medicineId: foreignSupplement.id, time: stamp(), doseAmount: 2, notes: 'OWN_CROSS_MEDICINE' } });
    own.oldMedicine = await db.medicineLog.create({ data: { ...scope, caretakerId: oldCaregiver.id, medicineId: oldMedicine.id, time: stamp(), doseAmount: 3, notes: 'OWN_DELETED_DOSE' } });
    own.badFood = await db.foodLog.create({ data: { ...scope, caretakerId: foreignCaregiver.id, foodId: foreignFood.id, time: stamp(), notes: 'OWN_CROSS_FOOD' } });
    own.multiFood = await db.foodLog.create({ data: { ...scope, foods: JSON.stringify([{ foodId: food.id }, { foodId: foreignFood.id }]), time: stamp(), notes: 'OWN_MULTI_FOOD' } });
    own.oldFood = await db.foodLog.create({ data: { ...scope, caretakerId: oldCaregiver.id, foodId: oldFood.id, time: stamp(), notes: 'OWN_DELETED_FOOD' } });
    own.feed = await db.feedLog.create({ data: { ...scope, time: stamp(), type: 'BOTTLE', amount: 75, unitAbbr: 'ML', notes: 'OWN_NORMAL_FEED' } });
    own.sleep = await db.sleepLog.create({ data: { ...scope, startTime: stamp(), endTime: new Date(start + 60000), duration: 1, type: 'NAP', location: 'OWN_SLEEP_LOCATION' } });
    own.play = await db.playLog.create({ data: { ...scope, startTime: stamp(), endTime: new Date(start + 60000), duration: 1, type: 'TUMMY_TIME', activities: 'OWN_PLAY_CATEGORY' } });
    own.measurement = await db.measurement.create({ data: { ...scope, date: stamp(), type: 'WEIGHT', value: 7.5, unit: 'kg' } });
    report.fixture = { familyId: family.id, foreignFamilyId: foreignFamily.id, babyId: baby.id, foreignBabyId: foreignBaby.id,
      ownRows: Object.fromEntries(Object.entries(own).map(([name, row]) => [name, { id: row.id, familyId: row.familyId, babyId: row.babyId, caretakerId: row.caretakerId, medicineId: row.medicineId, foodId: row.foodId }])) };

    async function login(person, owner) {
      const response = await request('/api/auth', null, 'POST', { loginId: person.loginId, securityPin: person.securityPin, familySlug: owner.slug });
      assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.success, true); assert.equal(body.data.role, person.role);
      const claims = jwt.verify(body.data.token, secret); assert.equal(claims.familyId, owner.id); assert.equal(claims.id, person.id); assert.equal(claims.role, person.role);
      report.authentication.push({ mechanism: 'POST /api/auth', role: person.role, familyId: owner.id, caretakerId: person.id });
      return body.data.token;
    }
    const userToken = await login(caregiver, family), adminToken = await login(admin, family), foreignToken = await login(foreignCaregiver, foreignFamily);
    const timelineUrl = `/api/timeline?babyId=${baby.id}&limit=100`;
    const hookBase = `/api/hooks/v1/babies/${baby.id}`, listUrl = `${hookBase}/activities?since=2000-01-01T00%3A00%3A00Z&limit=50`;
    await read('missingUser', timelineUrl, null, 401); await read('foreignUser', timelineUrl, foreignToken, 404);
    const deniedKey = await request('/api/api-keys', userToken, 'POST', { name: 'Synthetic denied key', scopes: ['read'] });
    assert.equal(deniedKey.status, 403); await deniedKey.body?.cancel();
    const issued = await request('/api/api-keys', adminToken, 'POST', { name: 'Synthetic read fence', scopes: ['read'] });
    assert.equal(issued.status, 200); const issuedBody = await issued.json(); assert.equal(issuedBody.success, true); const key = issuedBody.data.fullKey;
    const issuedRow = await db.apiKey.findUniqueOrThrow({ where: { id: issuedBody.data.id } });
    assert.equal(issuedRow.familyId, family.id); assert.deepEqual(JSON.parse(issuedRow.scopes), ['read']);
    report.authentication.push({ mechanism: 'ADMIN POST /api/api-keys and real read-only-key middleware', keyId: issuedRow.id, familyId: family.id, scopes: ['read'] });
    await read('missingKey', listUrl, null, 401); await read('invalidKey', listUrl, 'st_live_invalid', 401);
    await read('keyForeignChild', `/api/hooks/v1/babies/${foreignBaby.id}/activities`, key, 404);
    const deniedWrite = await request(`${hookBase}/activities`, key, 'POST', { type: 'diaper', diaperType: 'WET' });
    assert.equal(deniedWrite.status, 403); await deniedWrite.body?.cancel();

    const timeline = await read('ownedTimeline', timelineUrl, userToken);
    assert.deepEqual(timeline.map(row => row.id).sort(), Object.values(own).map(row => row.id).sort());
    assert.ok(!JSON.stringify(timeline).includes(foreignCaregiver.name)); assert.ok(!JSON.stringify(timeline).includes(foreignMedicine.name));
    assert.ok(!JSON.stringify(timeline).includes(foreignSupplement.name));
    const badFood = timeline.find(row => row.id === own.badFood.id); assert.equal(badFood.food, null);
    assert.deepEqual(badFood.foodItems, [{ foodId: foreignFood.id, hadReaction: false, reactionDescription: null }]);
    const multiFood = timeline.find(row => row.id === own.multiFood.id);
    assert.ok(JSON.stringify(multiFood).includes(food.name)); assert.ok(!JSON.stringify(multiFood).includes(foreignFood.name));
    assert.equal(timeline.find(row => row.id === own.oldMedicine.id).medicine.name, oldMedicine.name);
    assert.equal(timeline.find(row => row.id === own.oldMedicine.id).caretakerName, oldCaregiver.name);
    assert.equal(timeline.find(row => row.id === own.oldFood.id).food.name, oldFood.name);
    check('USER timeline preserves owned historical care and withholds foreign food names/allergen flags');

    const exportBase = `/api/timeline/export?babyId=${baby.id}&timezone=UTC&language=en`;
    const csv = await exported('ownedCsv', `${exportBase}&format=csv`, userToken, 'csv');
    const xlsx = await exported('ownedXlsx', `${exportBase}&format=xlsx`, userToken, 'xlsx'); assert.deepEqual(xlsx, csv);
    assert.equal(csv.length, Object.keys(own).length);
    for (const note of ['OWN_CROSS_CARETAKER', 'OWN_CROSS_MEDICINE', 'OWN_CROSS_FOOD']) {
      const row = csv.find(value => value.Notes === note); assert.ok(row); assert.equal(row.Caretaker, ''); assert.equal(row.Details, '');
    }
    assert.equal(csv.find(row => row.Notes === 'OWN_DELETED_DOSE').Details, oldMedicine.name);
    assert.equal(csv.find(row => row.Notes === 'OWN_DELETED_FOOD').Details, oldFood.name);
    assert.equal(csv.find(row => row.Notes === 'OWN_DELETED_DOSE').Caretaker, oldCaregiver.name);
    check('USER CSV and XLSX preserve the same owned rows while withholding foreign caregiver/catalog labels');

    const ownedHooks = (await read('ownedHookActivities', listUrl, key)).activities;
    assert.equal(ownedHooks.find(row => row.id === own.diaper.id).caretakerName, caregiver.name);
    assert.equal(ownedHooks.find(row => row.id === own.badCaretaker.id).caretakerName, null);
    assert.equal(ownedHooks.find(row => row.id === own.badMedicine.id).details.medicineName, null);
    assert.equal(ownedHooks.find(row => row.id === own.badMedicine.id).activityType, 'medicine');
    assert.equal(ownedHooks.find(row => row.id === own.oldMedicine.id).details.medicineName, oldMedicine.name);
    const correctionUrl = `${hookBase}/activities/${own.badMedicine.id}`;
    const correction = { type: 'medicine', notes: 'OWN_CROSS_MEDICINE_REVIEWED' };
    const deniedCorrection = await request(correctionUrl, key, 'PUT', correction);
    assert.equal(deniedCorrection.status, 403); await deniedCorrection.body?.cancel();
    const beforeCorrection = await db.medicineLog.findUniqueOrThrow({ where: { id: own.badMedicine.id } });
    assert.equal(beforeCorrection.notes, own.badMedicine.notes);
    const writableIssued = await request('/api/api-keys', adminToken, 'POST', { name: 'Synthetic notes-only correction', scopes: ['read', 'write'] });
    assert.equal(writableIssued.status, 200); const writableBody = await writableIssued.json(); assert.equal(writableBody.success, true);
    const writableRow = await db.apiKey.findUniqueOrThrow({ where: { id: writableBody.data.id } });
    assert.equal(writableRow.familyId, family.id); assert.deepEqual(JSON.parse(writableRow.scopes), ['read', 'write']);
    report.authentication.push({ mechanism: 'ADMIN POST /api/api-keys for notes-only correction', keyId: writableRow.id, familyId: family.id, scopes: ['read', 'write'] });
    const corrected = await request(correctionUrl, writableBody.data.fullKey, 'PUT', correction), correctedBody = await corrected.json();
    report.responses.ownedNotesCorrection = { route: correctionUrl, method: 'PUT', input: correction, status: corrected.status, body: correctedBody }; persist();
    assert.equal(corrected.status, 200); assert.equal(correctedBody.success, true);
    assert.equal(correctedBody.data.activityType, 'medicine'); assert.equal(correctedBody.data.details.medicineName, null);
    const afterCorrection = await db.medicineLog.findUniqueOrThrow({ where: { id: own.badMedicine.id } });
    assert.deepEqual(afterCorrection, { ...beforeCorrection, notes: correction.notes, updatedAt: afterCorrection.updatedAt });
    const correctedCsv = csv.map(row => row.Notes === 'OWN_CROSS_MEDICINE' ? { ...row, Notes: correction.notes } : row);
    check('API-key activity reads and a writable-key notes-only correction keep owned doses generic without foreign labels');

    const beforeStatus = await read('ownedHookStatus', `${hookBase}/status?timezone=UTC`, key);
    assert.equal(beforeStatus.lastActivities.feed.id, own.feed.id); assert.equal(beforeStatus.activeFeed, null);
    assert.equal((await read('ownedLatestMeasurements', `${hookBase}/measurements/latest`, key)).measurements.WEIGHT.value, 7.5);
    const beforeReference = await read('ownedReference', `${hookBase}/reference`, key);
    assert.ok(beforeReference.medicines.some(row => row.id === medicine.id));
    assert.ok(!beforeReference.medicines.some(row => [oldMedicine.id, foreignMedicine.id].includes(row.id)));
    assert.ok(beforeReference.sleepLocations.includes('OWN_SLEEP_LOCATION')); assert.ok(beforeReference.playCategories.includes('OWN_PLAY_CATEGORY'));

    const foreign = {}, foreignScope = { familyId: foreignFamily.id, babyId: baby.id, caretakerId: foreignCaregiver.id }, later = new Date(Date.now() - 1000);
    foreign.feed = await db.feedLog.create({ data: { ...foreignScope, time: later, type: 'BOTTLE', amount: 177, unitAbbr: 'ML', notes: 'PRIVATE_FOREIGN_ROW_feed' } });
    foreign.diaper = await db.diaperLog.create({ data: { ...foreignScope, time: later, type: 'DIRTY', notes: 'PRIVATE_FOREIGN_ROW_diaper' } });
    foreign.sleep = await db.sleepLog.create({ data: { ...foreignScope, startTime: later, endTime: later, duration: 0, type: 'NAP', location: 'PRIVATE_FOREIGN_SLEEP_LOCATION' } });
    foreign.note = await db.note.create({ data: { ...foreignScope, time: later, content: 'PRIVATE_FOREIGN_ROW_note' } });
    foreign.pump = await db.pumpLog.create({ data: { ...foreignScope, startTime: later, endTime: later, duration: 0, totalAmount: 33, unitAbbr: 'ML', pumpAction: 'UNKNOWN' } });
    foreign.play = await db.playLog.create({ data: { ...foreignScope, startTime: later, endTime: later, duration: 0, type: 'TUMMY_TIME', activities: 'PRIVATE_FOREIGN_PLAY_CATEGORY' } });
    foreign.bath = await db.bathLog.create({ data: { ...foreignScope, time: later, bathType: 'PRIVATE_FOREIGN_BATH_TYPE' } });
    foreign.measurement = await db.measurement.create({ data: { ...foreignScope, date: later, type: 'WEIGHT', value: 17.7, unit: 'kg' } });
    foreign.medicine = await db.medicineLog.create({ data: { ...foreignScope, time: later, medicineId: foreignMedicine.id, doseAmount: 9 } });
    foreign.supplement = await db.medicineLog.create({ data: { ...foreignScope, time: later, medicineId: foreignSupplement.id, doseAmount: 8 } });
    await db.activeBreastFeed.create({ data: { ...foreignScope, sessionStartTime: later, activeSide: 'RIGHT', isPaused: true, leftDuration: 321, rightDuration: 654 } });
    report.fixture.foreignRows = Object.fromEntries(Object.entries(foreign).map(([name, row]) => [name, { id: row.id, familyId: row.familyId, babyId: row.babyId }]));

    const afterTimeline = await read('crossRowTimeline', timelineUrl, userToken);
    assert.deepEqual(afterTimeline.map(row => row.id).sort(), timeline.map(row => row.id).sort());
    assert.deepEqual(await exported('crossRowCsv', `${exportBase}&format=csv`, userToken, 'csv'), correctedCsv);
    const afterHooks = (await read('crossRowHookActivities', listUrl, key)).activities;
    assert.deepEqual(afterHooks.map(row => row.id).sort(), ownedHooks.map(row => row.id).sort());
    for (const [kind, row] of Object.entries(foreign)) assert.ok(!afterHooks.some(item => item.id === row.id), `Foreign ${kind} must be absent`);
    const limited = await read('crossRowHookLimitOne', `${hookBase}/activities?type=feed&limit=1&since=2000-01-01T00%3A00%3A00Z`, key);
    assert.deepEqual(limited.activities.map(row => row.id), [own.feed.id]);
    check('Read-only API-key lists exclude foreign rows for all ten types before selection and retain canonical row scoping');

    const afterStatus = await read('crossRowHookStatus', `${hookBase}/status?timezone=UTC`, key);
    const stableLatest = value => Object.fromEntries(Object.entries(value.lastActivities).map(([kind, row]) => [kind, row && Object.fromEntries(Object.entries(row).filter(([name]) => name !== 'minutesAgo'))]));
    assert.deepEqual(stableLatest(afterStatus), stableLatest(beforeStatus)); assert.equal(afterStatus.activeFeed, null);
    const today = new Date(`${afterStatus.dailyCounts.date}T00:00:00Z`); assert.ok(Number.isFinite(today.getTime()));
    const ownedTodayFeeds = await db.feedLog.count({ where: { familyId: family.id, babyId: baby.id, deletedAt: null, time: { gte: today } } });
    assert.equal(afterStatus.dailyCounts.feeds, ownedTodayFeeds);
    check('Read-only API-key status excludes foreign latest events, feed counts and active breastfeed state');

    const afterMeasurements = await read('crossRowLatestMeasurements', `${hookBase}/measurements/latest`, key);
    assert.equal(afterMeasurements.measurements.WEIGHT.value, 7.5);
    check('Read-only API-key latest measurement uses owned history instead of a newer foreign row');

    const afterReference = await read('crossRowReference', `${hookBase}/reference`, key);
    assert.deepEqual(afterReference, beforeReference);
    check('Read-only API-key reference choices retain defaults and owned history without foreign sleep/play labels');
    assert.equal(checks.length, 7); report.status = 'PASS'; return checks;
  } catch (error) {
    report.status = 'FAIL'; report.error = error.message; throw error;
  } finally {
    report.completedAt = new Date().toISOString(); persist();
  }
}
