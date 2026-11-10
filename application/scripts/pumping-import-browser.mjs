// Real wizard, canonical API and milk stock checks on the owned synthetic server.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

const csv = [
  'id,child_id,start,end,amount,notes',
  'browser-pump-total,7,2026-10-20 08:00:10,2026-10-20 08:20:20,100,Original synthetic pumping note',
  'browser-pump-zero,7,2026-03-08 01:55:10,2026-03-08 03:05:20,0,Stored in freezer is only a source note',
].join('\n');
const warning = 'Baby Buddy does not record what happened to pumped milk. Imported sessions need review and do not add to stored milk. Open a pumping session to choose Stored, Fed or Discarded when known.';
const hint = 'This pumping session needs review. It adds no milk to your stock and creates no feeding entry. Choose Stored, Fed or Discarded only when you know what happened.';
const counts = async db => ({ pumps: await db.pumpLog.count(), feeds: await db.feedLog.count(), imports: await db.externalImportRecord.count() });
const sourceFields = ({ pumpAction, updatedAt, ...record }) => record;

export async function verifyPumpingImport({ base, db, family, baby, caretaker, token, secret, context }) {
  assert.equal(new URL(base).hostname, '127.0.0.1', 'Pumping acceptance only runs against the owned local server');
  const checks = [];
  const before = await counts(db);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(30_000);
  await page.clock.setFixedTime(new Date('2026-10-21T18:00:00Z'));
  const request = (path, method = 'GET', body, bearer = token) => fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
  });
  const stock = async () => {
    const response = await request(`/api/breast-milk-balance?babyId=${baby.id}&unit=ML`);
    assert.equal(response.status, 200); return (await response.json()).data.balance;
  };
  const importRequest = (targetBabyId = baby.id, bearer = token, endpoint = 'execute') => {
    const form = new FormData();
    form.set('providerId', 'baby-buddy');
    form.append('files', new Blob([csv], { type: 'text/csv' }), 'Pumping.csv');
    form.set('configuration', JSON.stringify({ execution: { sourceTimezone: 'America/Chicago', childDestinations: { '7': { mode: 'existing', targetBabyId } } }, provider: { pumpingUnit: 'ML' } }));
    return fetch(`${base}/api/import/external/${endpoint}`, { method: 'POST', headers: { Authorization: `Bearer ${bearer}` }, body: form, signal: AbortSignal.timeout(20_000) });
  };
  try {
    const stockBefore = await stock();
    await page.goto(`${base}/${family.slug}/bottle-journal`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: 'Admin', exact: true }).click();
    await settings.getByRole('button', { name: 'Import from another platform', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Import from another platform', exact: true });
    await dialog.locator('input[type="file"]').setInputFiles({ name: 'Pumping.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await dialog.getByRole('button', { name: 'Preview import', exact: true }).click();
    await dialog.getByText(warning, { exact: false }).waitFor();
    await dialog.getByRole('combobox').first().click();
    await page.getByRole('option', { name: `${baby.firstName} ${baby.lastName}`, exact: true }).click();
    await dialog.locator('section').filter({ has: page.getByRole('heading', { name: 'Source timezone', exact: true }) }).locator('input').fill('America/Chicago');
    await dialog.locator('section').filter({ has: page.getByRole('heading', { name: 'Units', exact: true }) }).getByRole('combobox').click();
    await page.getByRole('option', { name: 'ML', exact: true }).click();
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await dialog.getByRole('heading', { name: 'Ready to import', exact: true }).waitFor();
    await dialog.getByText(warning, { exact: false }).waitFor();
    assert.deepEqual(await counts(db), before); assert.equal(await stock(), stockBefore);
    checks.push('Pumping Configure and Review explain unresolved milk disposition before any write or stock change');
    const [execution] = await Promise.all([
      page.waitForResponse(value => value.url() === `${base}/api/import/external/execute` && value.request().method() === 'POST'),
      dialog.getByRole('button', { name: 'Import records', exact: true }).click(),
    ]);
    assert.equal(execution.status(), 200);
    const imported = await execution.json();
    assert.equal(imported.success, true); assert.equal(imported.data.created, 2); assert.equal(imported.data.duplicates, 0);
    await dialog.getByRole('heading', { name: 'Import completed', exact: true }).waitFor();
    const pumps = [];
    for (const [sourceRecordId, amount, start, end, duration, notes] of [
      ['browser-pump-total', 100, '2026-10-20T13:00:10.000Z', '2026-10-20T13:20:20.000Z', 20, 'Original synthetic pumping note'],
      ['browser-pump-zero', 0, '2026-03-08T07:55:10.000Z', '2026-03-08T08:05:20.000Z', 10, 'Stored in freezer is only a source note'],
    ]) {
      const provenance = await db.externalImportRecord.findFirstOrThrow({ where: { familyId: family.id, sourceRecordId } });
      assert.equal(provenance.providerId, 'baby-buddy'); assert.equal(provenance.sourceEntityType, 'pumping');
      assert.equal(provenance.sourceChildId, '7'); assert.equal(provenance.targetEntityType, 'PumpLog');
      const pump = await db.pumpLog.findUniqueOrThrow({ where: { id: provenance.targetRecordId } });
      assert.equal(pump.pumpAction, 'UNKNOWN'); assert.equal(pump.totalAmount, amount); assert.equal(pump.unitAbbr, 'ML');
      assert.equal(pump.leftAmount, null); assert.equal(pump.rightAmount, null); assert.equal(pump.notes, notes);
      assert.equal(pump.startTime.toISOString(), start);
      assert.equal(pump.endTime.toISOString(), end); assert.equal(pump.duration, duration);
      const response = await request(`/api/pump-log?id=${pump.id}`);
      assert.equal(response.status, 200);
      const canonical = (await response.json()).data;
      assert.equal(canonical.pumpAction, 'UNKNOWN'); assert.equal(canonical.notes, notes); assert.equal(canonical.totalAmount, amount);
      assert.equal(canonical.startTime, start); assert.equal(canonical.endTime, end); assert.equal(canonical.duration, duration);
      pumps.push(pump);
    }
    const after = { pumps: before.pumps + 2, feeds: before.feeds, imports: before.imports + 2 };
    assert.deepEqual(await counts(db), after); assert.equal(await stock(), stockBefore);
    checks.push('Confirmed pumping imports preserve totals including zero, exact endpoints and DST elapsed minutes, absent sides, notes and provenance while adding no stock or feed');

    const openPump = async () => {
      await page.goto(`${base}/${family.slug}/full-log`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: /Breast Pumping.*Total Amount: 100/ }).click();
      const details = page.getByRole('dialog', { name: 'Breast Pumping Record', exact: true });
      await details.getByText('Needs review', { exact: true }).waitFor();
      await details.getByRole('button', { name: 'Edit', exact: true }).click();
      const editor = page.getByRole('dialog', { name: 'Edit Pump', exact: true });
      await editor.getByText(hint, { exact: true }).waitFor();
      assert.equal(await editor.getByRole('button', { name: 'Needs review', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await editor.getByLabel('Left Amount', { exact: true }).inputValue(), '');
      assert.equal(await editor.getByLabel('Right Amount', { exact: true }).inputValue(), '');
      assert.equal(await editor.getByLabel('Total Amount', { exact: true }).inputValue(), '100');
      assert.equal(await editor.getByLabel('Notes', { exact: true }).inputValue(), pumps[0].notes);
      return editor;
    };
    const save = async editor => {
      const openedRevision = (await db.pumpLog.findUniqueOrThrow({ where: { id: pumps[0].id } })).updatedAt.toISOString();
      const [response] = await Promise.all([
        page.waitForResponse(value => value.url() === `${base}/api/pump-log?id=${pumps[0].id}` && value.request().method() === 'PUT'),
        editor.getByRole('button', { name: 'Update', exact: true }).click(),
      ]);
      assert.equal(response.status(), 200);
      await editor.waitFor({ state: 'hidden' });
      const { expectedUpdatedAt, ...changes } = response.request().postDataJSON();
      assert.equal(expectedUpdatedAt, openedRevision, 'The editor must send the revision it opened');
      return changes;
    };
    await db.settings.updateMany({ where: { familyId: family.id }, data: { enableBreastMilkTracking: false } });
    assert.deepEqual(await save(await openPump()), {});
    let corrected = await db.pumpLog.findUniqueOrThrow({ where: { id: pumps[0].id } });
    assert.equal(corrected.pumpAction, 'UNKNOWN'); assert.deepEqual(sourceFields(corrected), sourceFields(pumps[0]));
    assert.equal(await stock(), stockBefore); assert.deepEqual(await counts(db), after);
    const noteEditor = await openPump();
    const reviewedNotes = pumps[0].notes + '\nCaregiver review note';
    await noteEditor.getByLabel('Notes', { exact: true }).fill(reviewedNotes);
    assert.deepEqual(await save(noteEditor), { notes: reviewedNotes });
    pumps[0] = { ...pumps[0], notes: reviewedNotes };
    corrected = await db.pumpLog.findUniqueOrThrow({ where: { id: pumps[0].id } });
    assert.equal(corrected.pumpAction, 'UNKNOWN'); assert.deepEqual(sourceFields(corrected), sourceFields(pumps[0]));
    assert.equal(await stock(), stockBefore); assert.deepEqual(await counts(db), after);
    checks.push('Real timeline/editor show Needs review with stock tracking off; unchanged and note-only saves preserve untouched fields and unresolved stock');
    await db.settings.updateMany({ where: { familyId: family.id }, data: { enableBreastMilkTracking: true } });
    const editor = await openPump();
    await editor.getByRole('button', { name: 'Stored', exact: true }).click();
    assert.deepEqual(await save(editor), { pumpAction: 'STORED' });
    corrected = await db.pumpLog.findUniqueOrThrow({ where: { id: pumps[0].id } });
    assert.equal(corrected.pumpAction, 'STORED'); assert.deepEqual(sourceFields(corrected), sourceFields(pumps[0]));
    assert.equal(await stock(), stockBefore + 100); assert.deepEqual(await counts(db), after);
    checks.push('Explicit Stored selection through the real editor adds exactly the recorded amount and changes only disposition');

    for (const [index, action] of ['FED', 'FED', 'UNKNOWN', 'DISCARDED', 'STORED'].entries()) {
      const response = await request(`/api/pump-log?id=${pumps[0].id}`, 'PUT', { pumpAction: action });
      assert.equal(response.status, 200);
      assert.equal(await stock(), stockBefore + (action === 'STORED' ? 100 : 0));
      assert.equal(await db.feedLog.count({ where: { sourcePumpId: pumps[0].id } }), action === 'FED' ? 1 : 0);
      assert.deepEqual(sourceFields(await db.pumpLog.findUniqueOrThrow({ where: { id: pumps[0].id } })), sourceFields(pumps[0]));
      if (index === 0) {
        const pumpBefore = await db.pumpLog.findUniqueOrThrow({ where: { id: pumps[0].id } });
        const feedsBefore = await db.feedLog.findMany({ where: { sourcePumpId: pumps[0].id }, orderBy: { id: 'asc' } });
        const countsBefore = await counts(db); const stockBeforeRejection = await stock();
        assert.equal(feedsBefore.length, 1, 'Rejected corrections must exercise a real owned feeding link');
        const rejected = async (path, method, body, bearer = token) => {
          assert.equal((await request(path, method, body, bearer)).status, 400);
          assert.deepEqual(await db.pumpLog.findUniqueOrThrow({ where: { id: pumps[0].id } }), pumpBefore);
          assert.deepEqual(await db.feedLog.findMany({ where: { sourcePumpId: pumps[0].id }, orderBy: { id: 'asc' } }), feedsBefore);
          assert.deepEqual(await counts(db), countsBefore); assert.equal(await stock(), stockBeforeRejection);
        };
        const reversedEnd = new Date(pumpBefore.startTime.getTime() - 1000).toISOString();
        await rejected(`/api/pump-log?id=${pumpBefore.id}`, 'PUT', { totalAmount: -1 });
        await rejected(`/api/pump-log?id=${pumpBefore.id}`, 'PUT', { endTime: reversedEnd });
        const hookToken = 'st_live_synthetic_' + randomUUID();
        const hookKey = await db.apiKey.create({ data: {
          name: 'Owned pumping acceptance', keyPrefix: hookToken.slice(0, 16), keyHash: createHash('sha256').update(hookToken).digest('hex'),
          familyId: family.id, babyId: baby.id, scopes: JSON.stringify(['write']),
        } });
        try {
          const hookPath = `/api/hooks/v1/babies/${baby.id}/activities`;
          await rejected(hookPath, 'POST', { type: 'pump', action: 'log', time: pumpBefore.startTime.toISOString(), totalAmount: -1, unitAbbr: 'ML' }, hookToken);
          await rejected(`${hookPath}/${pumpBefore.id}`, 'PUT', { type: 'pump', totalAmount: '-1' }, hookToken);
          await rejected(`${hookPath}/${pumpBefore.id}`, 'PUT', { type: 'pump', endTime: reversedEnd }, hookToken);
        } finally {
          await db.apiKey.delete({ where: { id: hookKey.id } });
        }
      }
    }
    const beforeReplay = await db.pumpLog.findMany({ where: { id: { in: pumps.map(pump => pump.id) } }, orderBy: { id: 'asc' } });
    const replayResponse = await importRequest(); assert.equal(replayResponse.status, 200);
    const replay = await replayResponse.json(); assert.equal(replay.data.created, 0); assert.equal(replay.data.duplicates, 2);
    assert.deepEqual(replay.data.records.map(record => record.targetRecordId), imported.data.records.map(record => record.targetRecordId));
    assert.deepEqual(await db.pumpLog.findMany({ where: { id: { in: pumps.map(pump => pump.id) } }, orderBy: { id: 'asc' } }), beforeReplay);
    assert.deepEqual(await counts(db), after); assert.equal(await stock(), stockBefore + 100);
    checks.push('Authenticated action corrections synchronize the owned feed; invalid manual/API-key hook writes preserve pump, feed and stock; replay preserves source identity');

    const otherFamily = await db.family.create({ data: { id: 'browser-pump-other-family', slug: 'synthetic-pump-other', name: 'Other synthetic pumping family' } });
    const otherBaby = await db.baby.create({ data: { id: 'browser-pump-other-baby', familyId: otherFamily.id, firstName: 'Other', lastName: 'Synthetic', birthDate: new Date('2026-01-01Z') } });
    const otherCaretaker = await db.caretaker.create({ data: { id: 'browser-pump-other-caretaker', familyId: otherFamily.id, name: 'Other Reviewer', type: 'parent', role: 'ADMIN', loginId: 'pump-other', securityPin: '123456' } });
    const otherToken = jwt.sign({ id: otherCaretaker.id, name: otherCaretaker.name, role: 'ADMIN', type: 'parent', familyId: otherFamily.id, familySlug: otherFamily.slug }, secret, { expiresIn: '5m' });
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const denied = await request(`/api/pump-log?id=${pumps[0].id}`, method, method === 'PUT' ? { pumpAction: 'STORED', familyId: family.id } : undefined, otherToken);
      assert.equal(denied.status, 404);
    }
    assert.equal((await request(`/api/breast-milk-balance?babyId=${baby.id}`, 'GET', undefined, otherToken)).status, 404);
    assert.equal((await importRequest(otherBaby.id)).status, 400);
    const userToken = jwt.sign({ id: caretaker.id, name: caretaker.name, role: 'USER', familyId: family.id, familySlug: family.slug }, secret, { expiresIn: '5m' });
    for (const endpoint of ['preview', 'execute']) assert.equal((await importRequest(baby.id, userToken, endpoint)).status, 403);
    assert.deepEqual(await counts(db), after); assert.equal(await stock(), stockBefore + 100);
    assert.deepEqual(pageErrors, []);
    checks.push('Actual authentication rejects cross-family pump reads, corrections, deletion and stock access plus unauthorized import attempts');
    return checks;
  } finally {
    let timer;
    try { await Promise.race([page.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Pumping browser page did not close within 5 seconds')), 5000); })]); }
    finally { clearTimeout(timer); }
  }
}
