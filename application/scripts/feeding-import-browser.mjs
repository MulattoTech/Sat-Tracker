// Exercised by the disposable application/browser acceptance gate only.
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

const header = 'id,child_id,start,end,type,method,amount,notes';
const csv = [header,
  'browser-feed-offset,7,2026-11-01 01:55:10-05:00,2026-11-01 01:05:20-06:00,formula,bottle,90,Synthetic offset source',
  'browser-feed-spring,7,2026-03-08 01:55:10,2026-03-08 03:05:20,breast milk,left breast,,Synthetic spring source',
  'browser-feed-midnight,7,2026-10-20 23:59:30,2026-10-21 00:14:45,solid food,parent fed,,Synthetic midnight source',
].join('\n');

function formFor(content, targetBabyId) {
  const form = new FormData();
  form.set('providerId', 'baby-buddy');
  form.append('files', new Blob([content], { type: 'text/csv' }), 'Feeding.csv');
  form.set('configuration', JSON.stringify({
    execution: { sourceTimezone: 'America/Chicago', childDestinations: { '7': { mode: 'existing', targetBabyId } } },
    provider: { feedingUnit: 'ML' },
  }));
  return form;
}

async function counts(db) {
  return { feeds: await db.feedLog.count(), imports: await db.externalImportRecord.count() };
}

export async function verifyFeedingImport({ base, db, family, baby, caretaker, token, secret, context }) {
  assert.equal(new URL(base).hostname, '127.0.0.1', 'Feeding acceptance only runs against the owned local server');
  const checks = [];
  const before = await counts(db);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(30_000);
  const api = (content, targetBabyId = baby.id, bearer = token, endpoint = 'execute') => fetch(`${base}/api/import/external/${endpoint}`, {
    method: 'POST', headers: { Authorization: `Bearer ${bearer}` }, body: formFor(content, targetBabyId),
    signal: AbortSignal.timeout(20_000),
  });
  const openReview = async content => {
    await page.goto(`${base}/${family.slug}/bottle-journal`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: 'Admin', exact: true }).click();
    await settings.getByRole('button', { name: 'Import from another platform', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Import from another platform', exact: true });
    await dialog.locator('input[type="file"]').setInputFiles({ name: 'Feeding.csv', mimeType: 'text/csv', buffer: Buffer.from(content) });
    const [response] = await Promise.all([
      page.waitForResponse(value => value.url() === `${base}/api/import/external/preview` && value.request().method() === 'POST'),
      dialog.getByRole('button', { name: 'Preview import', exact: true }).click(),
    ]);
    assert.equal(response.status(), 200); assert.equal((await response.json()).success, true);
    await dialog.getByRole('combobox').first().click();
    await page.getByRole('option', { name: `${baby.firstName} ${baby.lastName}`, exact: true }).click();
    await dialog.locator('section').filter({ has: page.getByRole('heading', { name: 'Source timezone', exact: true }) }).locator('input').fill('America/Chicago');
    await dialog.locator('section').filter({ has: page.getByRole('heading', { name: 'Units', exact: true }) }).getByRole('combobox').click();
    await page.getByRole('option', { name: 'ML', exact: true }).click();
    await dialog.getByText('Timestamps without a UTC offset use this timezone. Feeding timestamps with an offset keep their exact time.', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await dialog.getByRole('heading', { name: 'Ready to import', exact: true }).waitFor();
    return dialog;
  };
  const confirm = async dialog => {
    const [response] = await Promise.all([
      page.waitForResponse(value => value.url() === `${base}/api/import/external/execute` && value.request().method() === 'POST'),
      dialog.getByRole('button', { name: 'Import records', exact: true }).click(),
    ]);
    return response;
  };
  try {
    const dialog = await openReview(csv);
    assert.deepEqual(await counts(db), before, 'Preview and configuration must not write care records');
    checks.push('Feeding CSV preview exposes child, units, and source timezone before any canonical write');
    const response = await confirm(dialog);
    assert.equal(response.status(), 200);
    const imported = await response.json();
    assert.equal(imported.success, true); assert.equal(imported.data.created, 3); assert.equal(imported.data.duplicates, 0);
    await dialog.getByRole('heading', { name: 'Import completed', exact: true }).waitFor();
    const saved = [];
    for (const [sourceRecordId, type, start, end, feedDuration, amount] of [
      ['browser-feed-offset', 'BOTTLE', '2026-11-01T06:55:10.000Z', '2026-11-01T07:05:20.000Z', 610, 90],
      ['browser-feed-spring', 'BREAST', '2026-03-08T07:55:10.000Z', '2026-03-08T08:05:20.000Z', 610, null],
      ['browser-feed-midnight', 'SOLIDS', '2026-10-21T04:59:30.000Z', '2026-10-21T05:14:45.000Z', 915, null],
    ]) {
      const provenance = await db.externalImportRecord.findFirstOrThrow({ where: { familyId: family.id, providerId: 'baby-buddy', sourceEntityType: 'feeding', sourceRecordId } });
      assert.equal(provenance.sourceChildId, '7'); assert.equal(provenance.targetEntityType, 'FeedLog');
      const feed = await db.feedLog.findUniqueOrThrow({ where: { id: provenance.targetRecordId } });
      assert.equal(feed.startTime.toISOString(), start); assert.equal(feed.endTime.toISOString(), end);
      assert.equal(feed.time.toISOString(), end); assert.equal(feed.feedDuration, feedDuration);
      assert.equal(feed.type, type); assert.equal(feed.amount, amount);
      assert.equal(feed.familyId, family.id); assert.equal(feed.babyId, baby.id); assert.equal(feed.caretakerId, caretaker.id);
      assert.ok(feed.notes.includes('Synthetic'));
      const canonical = await fetch(`${base}/api/feed-log?id=${feed.id}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
      assert.equal(canonical.status, 200);
      const body = await canonical.json(); assert.equal(body.success, true);
      for (const [field, expected] of Object.entries({ startTime: start, endTime: end, time: end, feedDuration, type, amount })) {
        assert.equal(body.data[field], expected, `Canonical feed API lost imported ${field}`);
      }
      saved.push(feed);
    }
    const after = { feeds: before.feeds + 3, imports: before.imports + 3 };
    assert.deepEqual(await counts(db), after);
    checks.push('Confirmed bottle, breast and solids preserve exact endpoints and elapsed seconds across DST/midnight in SQLite and canonical feed API');

    const replayResponse = await api(csv);
    assert.equal(replayResponse.status, 200);
    const replay = await replayResponse.json();
    assert.equal(replay.success, true); assert.equal(replay.data.created, 0); assert.equal(replay.data.duplicates, 3);
    assert.deepEqual(replay.data.records.map(value => value.targetRecordId), imported.data.records.map(value => value.targetRecordId));
    for (const feed of saved) assert.deepEqual(await db.feedLog.findUniqueOrThrow({ where: { id: feed.id } }), feed);
    assert.deepEqual(await counts(db), after);
    checks.push('Real feeding reupload retains the original three canonical records and provenance targets');

    const invalidCsv = [header,
      'browser-feed-rollback-first,7,2026-10-20 08:00:00,2026-10-20 08:10:00,formula,bottle,90,Synthetic first row',
      'browser-feed-rollback-second,7,2026-11-01 01:15:00,2026-11-01 02:15:00,formula,bottle,90,Synthetic ambiguous row',
    ].join('\n');
    const invalidDialog = await openReview(invalidCsv);
    const invalid = await confirm(invalidDialog);
    assert.equal(invalid.status(), 400);
    const failure = await invalid.json(); assert.equal(failure.success, false); assert.match(failure.error, /ambiguous.*UTC offset/);
    await invalidDialog.getByRole('alert').filter({ hasText: 'This feeding time is ambiguous because the clock repeats.' }).waitFor();
    assert.deepEqual(await counts(db), after, 'Later invalid endpoint must roll back the first row and its provenance');
    assert.equal(await invalidDialog.getByRole('button', { name: 'Back', exact: true }).isEnabled(), true);
    checks.push('Review screen visibly explains an ambiguous clock time and a later invalid row atomically rolls back the entire feeding batch');

    const otherFamily = await db.family.create({ data: { id: 'browser-feed-other-family', slug: 'synthetic-feed-other-family', name: 'Other synthetic feeding family' } });
    const otherBaby = await db.baby.create({ data: { id: 'browser-feed-other-baby', familyId: otherFamily.id,
      firstName: 'Other', lastName: 'Synthetic', birthDate: new Date('2026-01-01T00:00:00Z') } });
    const denied = await api(csv.replaceAll('browser-feed-', 'browser-feed-denied-'), otherBaby.id);
    assert.equal(denied.status, 400); assert.match((await denied.json()).error, /not found in this family/);
    const userToken = jwt.sign({ id: caretaker.id, name: caretaker.name, role: 'USER', familyId: family.id, familySlug: family.slug }, secret, { expiresIn: '5m' });
    for (const endpoint of ['preview', 'execute']) {
      const forbidden = await api(csv, baby.id, userToken, endpoint);
      assert.equal(forbidden.status, 403); assert.equal((await forbidden.json()).success, false);
    }
    assert.deepEqual(await counts(db), after);
    assert.deepEqual(pageErrors, [], 'Feeding import browser JavaScript errors');
    checks.push('Real feeding preview/execution reject non-admin caregivers and execution rejects another family child without writing');
    return checks;
  } finally {
    let timer;
    try { await Promise.race([page.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Feeding browser page did not close within 5 seconds')), 5000); })]); }
    finally { clearTimeout(timer); }
  }
}
