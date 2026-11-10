// Invoked only by the disposable synthetic browser suite; never targets a live database.
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

const csv = [
  'id,child_id,time,name,dosage,dosage_unit,notes,next_dose_interval',
  'browser-med-unknown,7,2026-10-21 08:15:00,Synthetic unknown medicine,,drops,Synthetic missing dose,04:00:00',
  'browser-med-known,7,2026-10-21 09:15:00,Synthetic known medicine,2.5,ml,Synthetic measured dose,06:00:00',
  'browser-med-zero,7,2026-10-21 10:15:00,Synthetic explicit zero,0,ml,Synthetic explicit zero,',
].join('\n');
const warning = 'Medication entries without an amount are preserved as notes with an unknown dose';

function formFor(content, targetBabyId) {
  const form = new FormData();
  form.set('providerId', 'baby-buddy');
  form.append('files', new Blob([content], { type: 'text/csv' }), 'Medication.csv');
  if (targetBabyId) form.set('configuration', JSON.stringify({
    execution: { sourceTimezone: 'America/Chicago', childDestinations: {
      '7': { mode: 'existing', targetBabyId },
    } },
    provider: {},
  }));
  return form;
}

async function recordCounts(db) {
  const [notes, medicines, medicineLogs, importRecords] = await Promise.all([
    db.note.count(), db.medicine.count(), db.medicineLog.count(), db.externalImportRecord.count(),
  ]);
  return { notes, medicines, medicineLogs, importRecords };
}

export async function verifyMedicationImport({ base, db, family, baby, caretaker, token, secret, context }) {
  assert.equal(new URL(base).hostname, '127.0.0.1', 'Medication acceptance only runs against the owned local test server');
  const checks = [];
  const before = await recordCounts(db);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(30_000);
  try {
    await page.goto(`${base}/${family.slug}/bottle-journal`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: 'Admin', exact: true }).click();
    await settings.getByRole('button', { name: 'Import from another platform', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Import from another platform', exact: true });
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'Medication.csv', mimeType: 'text/csv', buffer: Buffer.from(csv),
    });
    const [previewResponse] = await Promise.all([
      page.waitForResponse(response => response.url() === `${base}/api/import/external/preview`
        && response.request().method() === 'POST'),
      dialog.getByRole('button', { name: 'Preview import', exact: true }).click(),
    ]);
    assert.equal(previewResponse.status(), 200);
    const preview = await previewResponse.json();
    assert.equal(preview.success, true);
    assert.equal(preview.data.preview.totalRows, 3);
    assert.equal(preview.data.warnings.find(value => value.code === 'medication-dosage-missing')?.affectedRows, 1);
    await dialog.getByText(`${warning} (1)`, { exact: true }).waitFor();
    await dialog.getByRole('combobox').click();
    await page.getByRole('option', { name: `${baby.firstName} ${baby.lastName}`, exact: true }).click();
    await dialog.locator('section').filter({
      has: page.getByRole('heading', { name: 'Source timezone', exact: true }),
    }).locator('input').fill('America/Chicago');
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await dialog.getByRole('heading', { name: 'Ready to import', exact: true }).waitFor();
    assert.deepEqual(await recordCounts(db), before, 'Preview and review must not write canonical records');
    checks.push('Medication CSV warning and child/timezone review are visible before any canonical write');

    const [executeResponse] = await Promise.all([
      page.waitForResponse(response => response.url() === `${base}/api/import/external/execute`
        && response.request().method() === 'POST'),
      dialog.getByRole('button', { name: 'Import records', exact: true }).click(),
    ]);
    assert.equal(executeResponse.status(), 200);
    const executed = await executeResponse.json();
    assert.equal(executed.success, true);
    assert.equal(executed.data.created, 3);
    assert.equal(executed.data.duplicates, 0);
    await dialog.getByRole('heading', { name: 'Import completed', exact: true }).waitFor();

    const provenance = await db.externalImportRecord.findMany({
      where: { familyId: family.id, providerId: 'baby-buddy', sourceEntityType: 'medication',
        sourceRecordId: { in: ['browser-med-unknown', 'browser-med-known', 'browser-med-zero'] } },
      orderBy: { sourceRecordId: 'asc' },
    });
    assert.equal(provenance.length, 3);
    assert.ok(provenance.every(row => row.sourceChildId === '7'));
    const unknown = provenance.find(row => row.sourceRecordId === 'browser-med-unknown');
    assert.equal(unknown.targetEntityType, 'Note');
    const note = await db.note.findUniqueOrThrow({ where: { id: unknown.targetRecordId } });
    assert.equal(note.familyId, family.id); assert.equal(note.babyId, baby.id);
    assert.equal(note.caretakerId, caretaker.id);
    assert.equal(note.time.toISOString(), '2026-10-21T13:15:00.000Z');
    for (const text of ['Medication: Synthetic unknown medicine', 'Dose amount: not recorded in the source.',
      'Source dose unit: drops', 'Source next-dose interval: 04:00:00', 'Synthetic missing dose']) {
      assert.ok(note.content.includes(text), `Unresolved note must preserve ${text}`);
    }
    assert.equal(await db.medicine.count({ where: { familyId: family.id, name: 'Synthetic unknown medicine' } }), 0,
      'A missing source dose must not manufacture a medicine or a zero-dose administration');
    const doses = [];
    for (const [sourceRecordId, doseAmount, time] of [
      ['browser-med-known', 2.5, '2026-10-21T14:15:00.000Z'],
      ['browser-med-zero', 0, '2026-10-21T15:15:00.000Z'],
    ]) {
      const row = provenance.find(value => value.sourceRecordId === sourceRecordId);
      assert.equal(row.targetEntityType, 'MedicineLog');
      const dose = await db.medicineLog.findUniqueOrThrow({ where: { id: row.targetRecordId } });
      assert.equal(dose.doseAmount, doseAmount); assert.equal(dose.unitAbbr, 'ML');
      assert.equal(dose.time.toISOString(), time); assert.equal(dose.familyId, family.id);
      assert.equal(dose.babyId, baby.id); assert.equal(dose.caretakerId, caretaker.id);
      doses.push(dose);
    }
    const after = { notes: before.notes + 1, medicines: before.medicines + 2,
      medicineLogs: before.medicineLogs + 2, importRecords: before.importRecords + 3 };
    assert.deepEqual(await recordCounts(db), after);
    checks.push('Explicit UI confirmation preserves unknown dose as a Note and known/explicit-zero doses as MedicineLogs with source identity');

    const replayResponse = await fetch(`${base}/api/import/external/execute`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formFor(csv, baby.id),
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(replayResponse.status, 200);
    const replay = await replayResponse.json();
    assert.equal(replay.success, true); assert.equal(replay.data.created, 0); assert.equal(replay.data.duplicates, 3);
    assert.equal(replay.data.records.length, 3);
    for (const original of provenance) {
      const duplicate = replay.data.records.find(row => row.sourceRecordId === original.sourceRecordId);
      assert.equal(duplicate.status, 'duplicate');
      assert.equal(duplicate.targetEntityType, original.targetEntityType);
      assert.equal(duplicate.targetRecordId, original.targetRecordId);
    }
    assert.deepEqual(await recordCounts(db), after, 'Reupload must not create another dose, note, or provenance record');
    assert.deepEqual(await db.note.findUniqueOrThrow({ where: { id: note.id } }), note);
    for (const dose of doses) {
      assert.deepEqual(await db.medicineLog.findUniqueOrThrow({ where: { id: dose.id } }), dose);
    }
    checks.push('Real API reupload returns the same three medication targets as duplicates without changing canonical records');

    const foreignFamily = await db.family.create({ data: {
      id: 'browser-med-other-family', slug: 'synthetic-med-other-family', name: 'Other synthetic medication family',
    } });
    const foreignBaby = await db.baby.create({ data: { id: 'browser-med-other-baby', familyId: foreignFamily.id,
      firstName: 'Other', lastName: 'Synthetic', birthDate: new Date('2026-01-01T00:00:00Z') } });
    const deniedCsv = csv.replaceAll('browser-med-', 'browser-med-denied-');
    const wrongFamilyResponse = await fetch(`${base}/api/import/external/execute`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: formFor(deniedCsv, foreignBaby.id),
      signal: AbortSignal.timeout(20_000),
    });
    assert.equal(wrongFamilyResponse.status, 400);
    const wrongFamily = await wrongFamilyResponse.json();
    assert.equal(wrongFamily.success, false);
    assert.match(wrongFamily.error, /not found in this family/);
    assert.deepEqual(await recordCounts(db), after, 'A foreign child destination must reject the whole import');
    checks.push('Real medication import API rejects another family\'s child before writing any record');

    const userToken = jwt.sign({ id: caretaker.id, name: caretaker.name, role: 'USER',
      familyId: family.id, familySlug: family.slug }, secret, { expiresIn: '5m' });
    for (const endpoint of ['preview', 'execute']) {
      const response = await fetch(`${base}/api/import/external/${endpoint}`, {
        method: 'POST', headers: { Authorization: `Bearer ${userToken}` }, body: formFor(deniedCsv, baby.id),
        signal: AbortSignal.timeout(20_000),
      });
      assert.equal(response.status, 403, `Non-admin ${endpoint} must be rejected`);
      const result = await response.json();
      assert.equal(result.success, false);
    }
    assert.deepEqual(await recordCounts(db), after, 'Rejected requests must leave canonical storage unchanged');
    assert.deepEqual(pageErrors, [], 'Medication import browser JavaScript errors');
    checks.push('Real medication preview and execution both reject a non-admin caregiver with HTTP 403');
    return checks;
  } finally {
    let closeTimer;
    try {
      await Promise.race([page.close(), new Promise((_, reject) => {
        closeTimer = setTimeout(() => reject(new Error('Medication browser page did not close within 5 seconds')), 5000);
      })]);
    } finally { clearTimeout(closeTimer); }
  }
}
