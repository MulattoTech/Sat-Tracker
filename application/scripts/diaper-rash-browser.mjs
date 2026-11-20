// Real rash entry, history and selected exports in owned synthetic families only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';

const EXPECTED_CHECKS = 12;
const fields = [
  ['rashLocation', 'Rash location', 200],
  ['rashDescription', 'Rash description', 2000],
  ['rashProductsApplied', 'Products applied', 1000],
  ['rashFollowUpNotes', 'Follow-up notes', 2000],
];
const rashKeys = ['rashObserved', ...fields.map(([key]) => key)];
const emptyRash = Object.fromEntries(rashKeys.map(key => [key, null]));
const rashOf = row => Object.fromEntries(rashKeys.map(key => [key, row[key]]));
const status = value => value === true ? 'Rash observed' : value === false ? 'No rash observed' : 'Not recorded';
const statusButton = value => value === true ? 'Rash observed' : value === false ? 'No rash observed' : 'Clear rash observation';

async function bounded(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded its deadline`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function until(condition, label, milliseconds = 5000) {
  const deadline = Date.now() + milliseconds;
  do {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

export async function verifyDiaperRash({ base, db, browser, reportDir }) {
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/, 'Rash acceptance requires the owned local test server');
  const runId = process.env.SAT_TRACKER_ACCEPTANCE_RUN_ID || randomUUID();
  const prefix = `diaper-rash-${runId}`;
  const now = new Date();
  const family = { id: `${prefix}-family`, slug: `rash-${runId}`, name: 'Synthetic rash family', setupStage: 3 };
  const foreignFamily = { id: `${prefix}-foreign`, slug: `rash-f-${runId}`, name: 'Synthetic foreign rash family', setupStage: 3 };
  const familyIds = [family.id, foreignFamily.id];
  const caregiver = { id: `${prefix}-caregiver`, familyId: family.id, loginId: '65', securityPin: '748263',
    name: 'Synthetic Rash Reviewer', type: 'Parent', role: 'ADMIN', lastSeenVersion: '1.6.7' };
  const baby = { id: `${prefix}-baby`, familyId: family.id, firstName: 'RashPrimary', lastName: 'Fixture', birthDate: new Date(now.getTime() - 90 * 86400000) };
  const sibling = { ...baby, id: `${prefix}-sibling`, firstName: 'RashSibling' };
  const foreignBaby = { ...baby, id: `${prefix}-foreign-baby`, familyId: foreignFamily.id, firstName: 'RashForeign' };
  const preciseTime = new Date(now.getTime() - 120000); preciseTime.setUTCSeconds(56, 789);
  const longPrefix = 'RashDescriptionOnly café 👶 "=literal"\n';
  const longEnd = '\nRASH_DESCRIPTION_END';
  const longDescription = longPrefix + 'Observed pink patch; caregiver wording only.\n'.repeat(60).slice(0, 2000 - longPrefix.length - longEnd.length) + longEnd;
  assert.equal(longDescription.length, 2000);
  const rich = { rashObserved: true, rashLocation: '=RashLocationOnly, left fold', rashDescription: longDescription,
    rashProductsApplied: '+RashProductsOnly barrier cream', rashFollowUpNotes: '@RashFollowupOnly\nRecheck after next change.' };
  const legacyRash = { rashObserved: true, rashLocation: 'Legacy recorded location', rashDescription: 'Legacy recorded description',
    rashProductsApplied: 'Legacy recorded product', rashFollowUpNotes: 'Legacy recorded follow-up' };
  const report = {
    runId, syntheticOnly: true, startedAt: new Date().toISOString(),
    authentication: 'Actual PIN ADMIN login; no signed fixture JWTs',
    scope: 'Three-state rash observations, real form/history/export workflows and exact synthetic ownership boundaries',
    checks: [], evidence: [], screenshots: [], downloads: [], errors: [], captureErrors: [],
    cleanup: { errors: [], contextClosed: false, fixtureFamiliesRemoved: false },
  };
  const pageErrors = [];
  let context, page, failure;
  let legacy, foreignRow, siblingRow, outsideRow, otherTypeRow;
  const created = [];
  mkdirSync(reportDir, { recursive: true });
  const record = name => { report.checks.push(name); console.log(`Diaper rash passed: ${name}`); };
  const read = id => db.diaperLog.findUniqueOrThrow({ where: { id } });
  const ownRows = () => db.diaperLog.findMany({ where: { babyId: baby.id }, orderBy: { id: 'asc' } });
  const panelClosed = panel => panel.evaluateAll(nodes => nodes.length === 0 || nodes.every(node => node.classList.contains('translate-x-full')));
  const responseFor = method => page.waitForResponse(response => new URL(response.url()).pathname === '/api/diaper-log' && response.request().method() === method);
  const api = async (endpoint, method = 'GET', body) => page.evaluate(async ({ endpoint, method, body }) => {
    const response = await fetch(endpoint, { method, headers: { Authorization: `Bearer ${localStorage.getItem('authToken')}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() };
  }, { endpoint, method, body });
  const screenshot = async name => {
    const file = path.join(reportDir, name);
    await page.screenshot({ path: file, fullPage: false, timeout: 5000 });
    report.screenshots.push(file);
  };
  const noOverflow = async area => {
    const documentWidths = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    assert.ok(documentWidths.document <= documentWidths.viewport + 1, `Rash page overflows horizontally: ${JSON.stringify(documentWidths)}`);
    const bad = await area.evaluate(node => [node, ...node.querySelectorAll('.form-page-content, [data-testid="diaper-rash-observation"], input, textarea')]
      .filter(element => element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1)
      .map(element => ({ tag: element.tagName, className: element.className, width: element.clientWidth, content: element.scrollWidth })));
    assert.deepEqual(bad, [], 'Rash editor/details must not overflow horizontally');
  };
  const inViewport = async (locator, label) => {
    const box = await locator.evaluate(node => {
      const { left, top, right, bottom, width, height } = node.getBoundingClientRect();
      return { left, top, right, bottom, width, height, viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    assert.ok(box.width > 0 && box.height > 0 && box.left >= -1 && box.top >= -1
      && box.right <= box.viewportWidth + 1 && box.bottom <= box.viewportHeight + 1,
    `${label} must fit the viewport: ${JSON.stringify(box)}`);
  };
  const assertForm = async (editor, expected, notes) => {
    await until(async () => !await panelClosed(editor), 'diaper editor opening');
    await editor.getByLabel('Rash location', { exact: true }).click({ trial: true });
    await until(async () => {
      if (await editor.getByRole('button', { name: statusButton(expected.rashObserved), exact: true }).getAttribute('aria-pressed') !== 'true') return false;
      for (const [key, label] of fields) if (await editor.getByLabel(label, { exact: true }).inputValue() !== (expected[key] ?? '')) return false;
      return notes === undefined || await editor.getByLabel('Notes', { exact: true }).inputValue() === notes;
    }, 'exact diaper draft hydration');
    assert.equal((await editor.getByTestId('diaper-rash-status').textContent()).trim(), `Rash observation: ${status(expected.rashObserved)}`);
    for (const value of [true, false, null]) assert.equal(await editor.getByRole('button', { name: statusButton(value), exact: true }).getAttribute('aria-pressed'), String(value === expected.rashObserved));
    for (const [, label, maxLength] of fields) assert.equal(await editor.getByLabel(label, { exact: true }).getAttribute('maxlength'), String(maxLength));
    const labels = await editor.getByTestId('diaper-rash-observation').evaluate(group => [...group.querySelectorAll('label[for]')].map(label => ({
      controlInGroup: Boolean(label.control && group.contains(label.control)), count: [...document.querySelectorAll('[id]')].filter(node => node.id === label.htmlFor).length,
    })));
    assert.equal(labels.length, 4); assert.ok(labels.every(label => label.controlInGroup && label.count === 1), 'Every rash label must identify exactly its control');
  };
  const fillRash = async (editor, values) => {
    if (Object.hasOwn(values, 'rashObserved')) await editor.getByRole('button', { name: statusButton(values.rashObserved), exact: true }).click();
    for (const [key, label] of fields) if (Object.hasOwn(values, key)) await editor.getByLabel(label, { exact: true }).fill(values[key] ?? '');
  };
  const openCreate = async () => {
    await page.getByRole('button', { name: 'Diaper', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Log Diaper Change', exact: true });
    await assertForm(editor, emptyRash, '');
    return editor;
  };
  const save = async (editor, method, expected, previous) => {
    const [response] = await Promise.all([responseFor(method), editor.getByRole('button', { name: method === 'POST' ? 'Save' : 'Update', exact: true }).click()]);
    const body = await response.json(), payload = response.request().postDataJSON();
    assert.equal(response.status(), 200); assert.equal(body.success, true);
    assert.equal(body.data.babyId, baby.id); assert.equal(body.data.familyId, family.id);
    const row = await read(body.data.id);
    assert.deepEqual(rashOf(row), expected); assert.deepEqual(rashOf(body.data), expected);
    if (previous) {
      assert.equal(row.id, previous.id); assert.equal(Object.hasOwn(payload, 'time'), false, 'An unchanged displayed minute must omit time');
      assert.equal(row.time.getTime(), previous.time.getTime(), 'Rash/notes edits must preserve the exact original second and millisecond');
      const { updatedAt: _oldUpdated, ...oldFields } = previous;
      const { updatedAt: _newUpdated, ...newFields } = row;
      assert.deepEqual(newFields, { ...oldFields, ...payload, babyId: previous.babyId }, 'A diaper edit changed fields outside its actual submitted payload');
    }
    await until(() => panelClosed(editor), 'diaper save completion');
    await page.waitForLoadState('networkidle', { timeout: 5000 });
    return { row, payload, body };
  };
  const fullLog = async () => {
    await page.goto(`${base}/${family.slug}/full-log?babyId=${baby.id}`, { waitUntil: 'networkidle' });
    await page.getByPlaceholder('Search activities...', { exact: true }).waitFor();
    const pagination = page.locator('.full-log-timeline-pagination-select');
    if (await pagination.count()) await pagination.selectOption('50');
  };
  const search = async (query, expected) => {
    await page.getByPlaceholder('Search activities...', { exact: true }).fill(query);
    await until(async () => await page.locator('.full-log-timeline-activity-item').count() === expected, `history search ${query}`);
  };
  const openDetails = async row => {
    assert.ok(row.notes, 'Synthetic history lookup requires a unique notes marker');
    await search(row.notes, 1);
    await page.locator('.full-log-timeline-activity-item').click();
    const details = page.getByRole('dialog', { name: 'Diaper Record', exact: true });
    await until(async () => !await panelClosed(details), 'diaper history detail opening');
    await details.getByRole('button', { name: 'Edit', exact: true }).click({ trial: true });
    return details;
  };
  const assertDetails = async (details, expected) => {
    const readValue = async label => details.locator('.full-log-timeline-details-label').filter({ hasText: new RegExp(`^${label}:$`) })
      .locator('..').locator('.full-log-timeline-details-value').textContent();
    assert.equal(await readValue('Rash observation'), status(expected.rashObserved));
    for (const [key, label] of fields) {
      if (expected[key]) assert.equal(await readValue(label), expected[key], `History must preserve all ${label} text`);
      else assert.equal(await details.locator('.full-log-timeline-details-label').filter({ hasText: `${label}:` }).count(), 0);
    }
  };
  const closeDetails = async details => {
    await details.getByRole('button', { name: 'Close', exact: true }).last().click();
    await until(() => panelClosed(details), 'history detail closure');
  };
  const edit = async (row, expected = rashOf(row)) => {
    const details = await openDetails(row);
    await details.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit Diaper Change', exact: true });
    await assertForm(editor, expected, row.notes);
    return editor;
  };

  try {
    for (const owner of [family, foreignFamily]) {
      assert.ok(owner.slug.length <= 50); assert.match(owner.slug, /^[a-z0-9-]+$/);
      await db.family.create({ data: owner });
      await db.settings.create({ data: { familyId: owner.id, familyName: owner.name, authType: 'CARETAKER',
        nurseryModeSettings: JSON.stringify({ global: { layout: 'cards', acts: { feed: true, pump: true, diaper: true, sleep: true, food: true } } }) } });
    }
    await db.caretaker.create({ data: caregiver });
    await db.baby.createMany({ data: [baby, sibling, foreignBaby] });
    const fixture = (owner, child, notes, values, time = preciseTime) => db.diaperLog.create({ data: {
      familyId: owner.id, babyId: child.id, ...(owner.id === family.id ? { caretakerId: caregiver.id } : {}),
      time, type: 'DRY', notes, ...values,
    } });
    legacy = await fixture(family, baby, 'RASH_LEGACY', legacyRash);
    siblingRow = await fixture(family, sibling, 'RASH_SIBLING_PRIVATE', { rashObserved: false, rashDescription: 'Sibling only observation' });
    foreignRow = await fixture(foreignFamily, foreignBaby, 'RASH_FOREIGN_PRIVATE', { rashObserved: true, rashDescription: 'Foreign family only observation' });
    outsideRow = await fixture(family, baby, 'RASH_OUTSIDE_RANGE', { rashObserved: true }, new Date(now.getTime() - 4 * 86400000));
    otherTypeRow = await db.note.create({ data: { familyId: family.id, babyId: baby.id, caretakerId: caregiver.id, time: preciseTime,
      content: 'RASH_OTHER_TYPE_EXCLUDED', category: 'General' } });
    const resolved = await fetch(`${base}/api/family/by-slug/${family.slug}`, { signal: AbortSignal.timeout(5000) });
    assert.equal(resolved.status, 200); assert.equal((await resolved.json()).data?.id, family.id);

    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block' });
    page = await context.newPage(); page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(20000);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.clock.setFixedTime(now);
    assert.match(caregiver.loginId, /^\d{2}$/); assert.match(caregiver.securityPin, /^\d{6,10}$/);
    await page.goto(`${base}/${family.slug}`, { waitUntil: 'networkidle' });
    const login = page.locator('.login-container');
    await login.getByRole('heading', { name: 'Login ID & Security PIN', exact: true }).waitFor();
    for (const digit of caregiver.loginId) await login.getByRole('button', { name: digit, exact: true }).click();
    assert.equal(await login.getByLabel('Login ID', { exact: true }).inputValue(), caregiver.loginId);
    for (const digit of caregiver.securityPin) await login.getByRole('button', { name: digit, exact: true }).click();
    const [loginResponse] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth' && response.request().method() === 'POST'),
      login.getByRole('button', { name: 'Go', exact: true }).click(),
    ]);
    const loggedIn = await loginResponse.json();
    assert.equal(loginResponse.status(), 200); assert.equal(loggedIn.success, true); assert.equal(loggedIn.data.id, caregiver.id);
    await page.getByLabel('Select Baby', { exact: true }).waitFor();

    await page.goto(`${base}/${family.slug}/nursery-mode`, { waitUntil: 'networkidle' });
    const nurserySelect = page.getByRole('button', { name: 'Switch Baby', exact: true });
    await nurserySelect.click(); await page.getByRole('option', { name: baby.firstName, exact: true }).click();
    const nurseryCard = page.locator('.nursery-card').filter({ has: page.getByRole('heading', { name: 'Diaper', exact: true }) });
    const [quickResponse] = await Promise.all([responseFor('POST'), nurseryCard.getByRole('button', { name: 'Wet', exact: true }).click()]);
    const quick = await quickResponse.json(); assert.equal(quickResponse.status(), 200); assert.equal(quick.success, true);
    assert.equal(quick.data.babyId, baby.id); assert.equal(quick.data.familyId, family.id); assert.equal(quick.data.type, 'WET');
    assert.deepEqual(rashOf(quick.data), emptyRash); assert.deepEqual(rashOf(await read(quick.data.id)), emptyRash);
    for (const key of rashKeys) assert.equal(Object.hasOwn(quickResponse.request().postDataJSON(), key), false);
    await page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
    record('Real Nursery one-tap diaper remains an unknown rash observation and creates no inferred rash details');

    await page.goto(`${base}/${family.slug}/log-entry?babyId=${baby.id}`, { waitUntil: 'networkidle' });
    const cases = [
      { type: 'WET', label: 'Wet', notes: '=RASH_WET(1,2)', values: rich, cream: false },
      { type: 'DIRTY', label: 'Dirty', notes: 'RASH_DIRTY', values: { ...emptyRash, rashObserved: false }, cream: true },
      { type: 'BOTH', label: 'Wet and Dirty', notes: 'RASH_BOTH', values: emptyRash, cream: true },
      { type: 'DRY', label: 'Dry', notes: 'RASH_DRY', values: { ...emptyRash, rashObserved: true }, cream: false },
    ];
    for (const item of cases) {
      const editor = await openCreate();
      await editor.getByLabel('Type', { exact: true }).click();
      await page.getByRole('option', { name: item.label, exact: true }).click();
      if (item.type !== 'BOTH') await fillRash(editor, item.type === 'WET' ? item.values : { rashObserved: item.values.rashObserved });
      const cream = editor.getByRole('checkbox', { name: 'Diaper Cream Applied', exact: true });
      if (item.cream) { await cream.focus(); await page.keyboard.press('Space'); }
      assert.equal(await cream.isChecked(), item.cream);
      await editor.getByLabel('Notes', { exact: true }).fill(item.notes);
      const result = await save(editor, 'POST', item.values);
      assert.equal(result.row.type, item.type); assert.equal(result.row.creamApplied, item.cream); assert.equal(result.row.notes, item.notes);
      if (item.type === 'BOTH') for (const key of rashKeys) assert.equal(Object.hasOwn(result.payload, key), false, 'Untouched unknown rash fields remain omitted');
      else assert.equal(result.payload.rashObserved, item.values.rashObserved);
      created.push(result.row);
      record(`Actual ${item.type} form saves ${status(item.values.rashObserved)} independently of cream=${item.cream}, with exact optional text`);
    }

    await fullLog(); await page.reload({ waitUntil: 'networkidle' });
    for (const row of created) {
      const details = await openDetails(row); await assertDetails(details, rashOf(row)); await closeDetails(details);
    }
    for (const query of ['RashLocationOnly', 'RashDescriptionOnly', 'RashProductsOnly', 'RashFollowupOnly']) await search(query, 1);
    await search('Rash observation: No rash observed', 1);
    await search('Rash observation: Not recorded', 2);
    const details = await openDetails(created[0]); await assertDetails(details, rich);
    await screenshot('diaper-rash-history.png'); await closeDetails(details);
    record('Reloaded history distinguishes true, false and unknown; all four raw rash details and localized status are searchable without losing multiline text');

    let target = created[3];
    let editor = await edit(target);
    await fillRash(editor, { rashObserved: false, rashLocation: 'Clear this location', rashDescription: 'Clear this description',
      rashProductsApplied: 'Clear this product', rashFollowUpNotes: 'Clear this follow-up' });
    const populated = { rashObserved: false, rashLocation: 'Clear this location', rashDescription: 'Clear this description',
      rashProductsApplied: 'Clear this product', rashFollowUpNotes: 'Clear this follow-up' };
    target = (await save(editor, 'PUT', populated, target)).row;
    editor = await edit(target); await fillRash(editor, emptyRash);
    const cleared = await save(editor, 'PUT', emptyRash, target);
    for (const key of rashKeys) assert.equal(cleared.payload[key], null, 'Deliberate clear must send null, not omission');
    created[3] = cleared.row;
    await page.reload({ waitUntil: 'networkidle' });
    const clearedDetails = await openDetails(cleared.row); await assertDetails(clearedDetails, emptyRash); await closeDetails(clearedDetails);
    record('Explicit true-to-false and then clear-to-unknown edits clear each optional field with null and preserve the original instant after reload');

    let legacyReads = 0, legacyReadError;
    const legacyRoute = async route => {
      if (route.request().method() !== 'GET' || new URL(route.request().url()).searchParams.get('babyId') !== baby.id) return route.continue();
      try {
        const response = await route.fetch({ timeout: 10000 }); const body = await response.json();
        assert.equal(response.status(), 200); assert.equal(body.success, true);
        const row = body.data.find(value => value.id === legacy.id); assert.ok(row); assert.deepEqual(rashOf(row), legacyRash);
        for (const key of rashKeys) delete row[key];
        legacyReads++; await route.fulfill({ response, json: body });
      } catch (error) { legacyReadError = error.message; await route.abort('failed'); }
    };
    await page.route('**/api/timeline?*', legacyRoute);
    await fullLog(); editor = await edit(legacy, emptyRash);
    await page.unroute('**/api/timeline?*', legacyRoute);
    assert.equal(legacyReadError, undefined); assert.ok(legacyReads > 0);
    assert.deepEqual(await read(legacy.id), legacy);
    await editor.getByLabel('Notes', { exact: true }).fill('RASH_LEGACY_REVIEWED');
    const preserved = await save(editor, 'PUT', legacyRash, legacy);
    for (const key of rashKeys) assert.equal(Object.hasOwn(preserved.payload, key), false, 'Legacy notes-only edit must omit every untouched rash field');
    assert.equal(preserved.row.time.toISOString(), preciseTime.toISOString());
    legacy = preserved.row;
    report.evidence.push({ legacyResponseOmittedFields: rashKeys, unchangedTimeOmitted: true, originalTime: preciseTime.toISOString(), persistedTime: legacy.time.toISOString() });
    record('A real notes-only edit from a legacy-shaped history GET omits all untouched rash fields and preserves their newer values and exact seconds/milliseconds');

    await page.setViewportSize({ width: 390, height: 844 });
    target = created[1]; editor = await edit(target);
    const group = editor.getByTestId('diaper-rash-observation');
    const observed = group.getByRole('button', { name: 'Rash observed', exact: true });
    await observed.focus(); await page.keyboard.press('Space');
    assert.equal(await observed.getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Tab');
    const noRash = group.getByRole('button', { name: 'No rash observed', exact: true });
    assert.equal(await noRash.evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Space'); assert.equal(await noRash.getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Tab');
    const clear = group.getByRole('button', { name: 'Clear rash observation', exact: true });
    assert.equal(await clear.evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Space'); assert.equal(await clear.getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Tab');
    assert.equal(await editor.getByLabel('Rash location', { exact: true }).evaluate(node => node === document.activeElement), true);
    const retained = { rashObserved: false, rashLocation: 'Phone caregiver location', rashDescription: 'Retained phone draft café 👶\nSecond observed line.',
      rashProductsApplied: 'Phone product entry', rashFollowUpNotes: 'Phone follow-up draft' };
    await fillRash(editor, retained);
    for (const value of [true, false, null]) {
      const button = group.getByRole('button', { name: statusButton(value), exact: true });
      await button.click({ trial: true }); await inViewport(button, `Mobile ${statusButton(value)}`);
      assert.ok((await button.boundingBox()).height >= 44, 'Rash status touch targets must be at least 44px high');
    }
    await observed.scrollIntoViewIfNeeded(); await screenshot('diaper-rash-phone-status.png');
    for (const [, label] of fields) {
      const input = editor.getByLabel(label, { exact: true });
      await input.click({ trial: true }); await inViewport(input, `Mobile ${label}`);
    }
    await editor.getByLabel('Rash location', { exact: true }).focus(); await page.keyboard.press('Tab');
    assert.equal(await editor.getByLabel('Rash description', { exact: true }).evaluate(node => node === document.activeElement), true);
    for (const name of ['Cancel', 'Update']) {
      const action = editor.getByRole('button', { name, exact: true });
      await action.click({ trial: true }); await inViewport(action, `Mobile ${name}`);
    }
    await noOverflow(editor);
    await editor.getByLabel('Products applied', { exact: true }).scrollIntoViewIfNeeded();
    await screenshot('diaper-rash-phone-fields.png');
    const beforeRejection = await read(target.id);
    const rejectedPayloads = [];
    const reject = async route => {
      if (route.request().method() !== 'PUT' || new URL(route.request().url()).searchParams.get('id') !== target.id) return route.continue();
      rejectedPayloads.push(route.request().postDataJSON());
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Synthetic rejected write' }) });
    };
    await page.route('**/api/diaper-log?*', reject);
    const [rejected] = await Promise.all([responseFor('PUT'), editor.getByRole('button', { name: 'Update', exact: true }).click()]);
    assert.equal(rejected.status(), 400); assert.equal(rejectedPayloads.length, 1);
    await editor.getByRole('alert').filter({ hasText: 'Failed to save diaper log' }).waitFor();
    await assertForm(editor, retained, target.notes); assert.deepEqual(await read(target.id), beforeRejection);
    assert.equal(await panelClosed(editor), false, 'A rejected write must retain the open editor');
    await screenshot('diaper-rash-phone-rejected.png');
    await page.unroute('**/api/diaper-log?*', reject);
    const retried = await save(editor, 'PUT', retained, target);
    assert.deepEqual(retried.payload, rejectedPayloads[0], 'Only an explicit retry may submit the exact retained draft');
    assert.equal(retried.row.creamApplied, true); created[1] = retried.row;
    const phoneDetails = await openDetails(created[0]); await assertDetails(phoneDetails, rich);
    await noOverflow(phoneDetails); await screenshot('diaper-rash-phone-history.png'); await closeDetails(phoneDetails);
    report.evidence.push({ viewport: { width: 390, height: 844 }, keyboardStatusAndFieldTraversal: true, minimumStatusTouchHeight: 44,
      labelsAndActionsAccessible: true, horizontalOverflow: false, rejectedWriteUnchanged: true, explicitRetryPayloadIdentical: true });
    record('At 390×844 keyboard/touch controls and all labels/actions remain usable; a rejected write retains the exact draft, then explicit retry persists it without changing cream or time');
    await page.setViewportSize({ width: 1440, height: 1000 });

    const beforeBoundaries = await ownRows();
    await page.getByPlaceholder('Search activities...', { exact: true }).fill('');
    await page.getByLabel('Select Baby', { exact: true }).click();
    await page.getByRole('menuitemradio', { name: new RegExp(`^${sibling.firstName}\\b`) }).click();
    await page.getByRole('button', { name: `${sibling.firstName}'s Quick Stats`, exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('babyId'), sibling.id);
    await search(siblingRow.notes, 1);
    const siblingDetails = await openDetails(siblingRow); await assertDetails(siblingDetails, rashOf(siblingRow)); await closeDetails(siblingDetails);
    await search('RashDescriptionOnly', 0);
    await page.getByLabel('Select Baby', { exact: true }).click();
    await page.getByRole('menuitemradio', { name: new RegExp(`^${baby.firstName}\\b`) }).click();
    await page.getByRole('button', { name: `${baby.firstName}'s Quick Stats`, exact: true }).waitFor();
    await search('RASH_SIBLING_PRIVATE', 0); await search('RASH_FOREIGN_PRIVATE', 0);
    for (const [endpoint, method, body] of [
      [`/api/diaper-log?id=${foreignRow.id}`, 'GET'],
      [`/api/diaper-log?id=${foreignRow.id}`, 'PUT', { rashObserved: false, rashDescription: 'Denied foreign overwrite' }],
      ['/api/diaper-log', 'POST', { babyId: foreignBaby.id, time: now.toISOString(), type: 'WET', rashObserved: true }],
      [`/api/timeline?babyId=${foreignBaby.id}`, 'GET'],
      [`/api/timeline/export?babyId=${foreignBaby.id}&format=json&timezone=UTC&language=en`, 'GET'],
    ]) {
      const result = await api(endpoint, method, body); assert.equal(result.status, 404); assert.equal(result.body.success, false);
      assert.equal(JSON.stringify(result.body).includes(foreignRow.rashDescription), false);
    }
    assert.deepEqual(await read(siblingRow.id), siblingRow); assert.deepEqual(await read(foreignRow.id), foreignRow);
    assert.deepEqual(await ownRows(), beforeBoundaries);
    assert.equal(await db.diaperLog.count({ where: { babyId: foreignBaby.id } }), 1);
    record('Child switching keeps rash histories separate; actual foreign-family reads, create, edit and export fail without changing any owned or foreign diaper');

    await search('', 8); // Six recent diaper records, one older diaper and one note.
    const [rangeResponse] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/timeline' && new URL(response.url()).searchParams.get('babyId') === baby.id),
      page.getByRole('button', { name: '2 Days', exact: true }).click(),
    ]);
    assert.equal(rangeResponse.status(), 200);
    await page.getByRole('button', { name: 'Filters', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Diaper', exact: true }).click();
    await until(async () => await page.locator('.full-log-timeline-activity-item').count() === 6, 'selected two-day diaper history');
    const current = await ownRows();
    const selected = current.filter(row => row.id !== outsideRow.id);
    assert.equal(selected.length, 6);
    for (const value of [true, false, null]) assert.ok(selected.some(row => row.rashObserved === value), 'Selected export fixtures must retain all three observation states');
    const assertExportSelection = response => {
      const query = new URL(response.url()).searchParams;
      assert.equal(query.get('babyId'), baby.id); assert.equal(query.get('filter'), 'diaper');
      assert.equal(query.get('timezone'), 'UTC'); assert.equal(query.get('language'), 'en');
      const start = new Date(query.get('startDate')), end = new Date(query.get('endDate'));
      assert.ok(Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()));
      assert.ok(end.getTime() - start.getTime() <= 3 * 86400000, 'The selected export must use the two-day UI range');
      assert.ok(outsideRow.time < start); assert.ok(selected.every(row => row.time >= start && row.time <= end));
      return Object.fromEntries(query);
    };
    const download = async format => {
      const requestFormat = format === 'pdf' ? 'json' : format;
      await page.getByRole('button', { name: 'Export', exact: true }).click();
      const [file, response] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/timeline/export'
          && new URL(response.url()).searchParams.get('format') === requestFormat, { timeout: 10000 }),
        page.getByRole('button', { name: `Export ${format.toUpperCase()}`, exact: true }).click(),
      ]);
      assert.equal(response.status(), 200); const selection = assertExportSelection(response);
      assert.match(file.suggestedFilename(), new RegExp(`^activity-log-.*\\.${format}$`));
      const filename = path.join(reportDir, `diaper-rash-selected.${format}`);
      await bounded(file.saveAs(filename), 10000, `${format} download save`);
      assert.equal(await file.failure(), null);
      const buffer = readFileSync(filename); assert.ok(buffer.length > 0);
      report.downloads.push({ format, file: filename, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), selection });
      return { response, buffer, filename };
    };
    const assertRows = rows => {
      assert.equal(rows.length, selected.length);
      assert.ok(rows.every(row => row['Activity Type'] === 'Diaper'));
      for (const excluded of [siblingRow.notes, foreignRow.notes, outsideRow.notes, otherTypeRow.content]) assert.equal(JSON.stringify(rows).includes(excluded), false);
      for (const row of selected) {
        const exported = rows.find(candidate => candidate.Notes === (row.notes ?? ''));
        assert.ok(exported, `Export must contain the exact notes marker for ${row.id}`);
        assert.ok(exported.Details.includes(`Rash observation: ${status(row.rashObserved)}`));
        for (const [key, label] of fields) if (row[key]) assert.ok(exported.Details.includes(`${label}: ${row[key]}`), `Export lost ${label} text`);
      }
    };
    const failedExport = async route => {
      if (new URL(route.request().url()).searchParams.get('format') !== 'csv') return route.continue();
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Synthetic unavailable export' }) });
    };
    let rejectedDownloads = 0; const countRejectedDownload = () => { rejectedDownloads++; };
    page.on('download', countRejectedDownload); await page.route('**/api/timeline/export?*', failedExport);
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const [failedExportResponse] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/timeline/export'),
      page.getByRole('button', { name: 'Export CSV', exact: true }).click(),
    ]);
    assert.equal(failedExportResponse.status(), 503);
    await page.getByRole('alert').filter({ hasText: 'Unable to export activities. Please try again.' }).waitFor();
    assert.equal(rejectedDownloads, 0); page.off('download', countRejectedDownload);
    await page.unroute('**/api/timeline/export?*', failedExport);
    const csv = await download('csv');
    const csvRows = parse(csv.buffer.toString('utf8'), { columns: true });
    assert.equal(csvRows.find(row => row.Notes.includes('RASH_WET')).Notes, "'=RASH_WET(1,2)", 'CSV formula-like notes must be a literal cell');
    const normalizedCsv = csvRows.map(row => ({ ...row, Notes: row.Notes === "'=RASH_WET(1,2)" ? '=RASH_WET(1,2)' : row.Notes }));
    assertRows(normalizedCsv);
    const xlsx = await download('xlsx');
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(xlsx.buffer);
    assert.equal(workbook.worksheets.length, 1);
    const sheet = workbook.worksheets[0], headers = sheet.getRow(1).values.slice(1), xlsxRows = [];
    sheet.eachRow((row, index) => {
      row.eachCell(cell => assert.equal(cell.formula, undefined, 'Caregiver input must never become an XLSX formula'));
      if (index > 1) xlsxRows.push(Object.fromEntries(headers.map((header, i) => [header, row.getCell(i + 1).text])));
    });
    assertRows(xlsxRows); assert.deepEqual(xlsxRows, normalizedCsv);
    assert.equal(await page.getByRole('alert').filter({ hasText: 'Unable to export activities. Please try again.' }).count(), 0);
    report.evidence.push({ exportRows: selected.length, selectedRangeAndType: true, csvFormulaNeutralized: true, xlsxFormulaCells: 0,
      longDescriptionCharacters: longDescription.length, exactMultilineAndUnicode: true, exportFailureRetriable: true });
    record('Real selected two-day diaper CSV/XLSX downloads preserve full Unicode/multiline details, neutralize formula-like cells, exclude other scopes and recover from a visible export failure');

    // Read the real, completed pagination DOM without changing its content or
    // layout. Mutation observation runs before the first awaited canvas capture.
    await page.evaluate(() => {
      window.__rashPdfCapture = null;
      const observer = new MutationObserver(() => {
        const root = document.querySelector('.full-log-pdf-root');
        if (!root) return;
        const pages = [...root.querySelectorAll('.full-log-pdf-page')];
        if (!pages.length || pages.some(page => !page.querySelector('.full-log-pdf-footer')?.textContent)) return;
        window.__rashPdfCapture = {
          text: pages.flatMap(page => [...page.querySelector('.full-log-pdf-content').children].map(child => child.textContent)).join(''),
          pages: pages.map(page => {
            const content = page.querySelector('.full-log-pdf-content'), rect = content.getBoundingClientRect(), pageRect = page.getBoundingClientRect();
            return { width: pageRect.width, height: pageRect.height, clientHeight: content.clientHeight, scrollHeight: content.scrollHeight,
              clientWidth: content.clientWidth, scrollWidth: content.scrollWidth, footer: page.querySelector('.full-log-pdf-footer').textContent,
              clipped: [...content.children].filter(child => { const box = child.getBoundingClientRect();
                return box.top < rect.top - 1 || box.bottom > rect.bottom + 1 || box.left < rect.left - 1 || box.right > rect.right + 1;
              }).map(child => child.textContent.slice(0, 80)) };
          }),
        };
        observer.disconnect();
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      window.__rashPdfObserver = observer;
    });
    const pdf = await download('pdf');
    const json = await pdf.response.json(); assert.equal(json.success, true); assert.deepEqual(json.data.rows, xlsxRows);
    assert.equal(json.data.babyName, `${baby.firstName} ${baby.lastName}`);
    assert.match(pdf.response.headers()['cache-control'], /no-store/);
    assert.equal(pdf.buffer.subarray(0, 5).toString('ascii'), '%PDF-');
    const capture = await page.evaluate(() => { window.__rashPdfObserver?.disconnect(); return window.__rashPdfCapture; });
    assert.ok(capture); assert.ok(capture.pages.length > 1, 'Long selected observations must exercise actual PDF pagination');
    const expectedText = json.data.rows.flatMap((row, index) => [`Activity Log ${index + 1}`,
      ...Object.entries(row).filter(([, value]) => value !== '').map(([label, value]) => `${label}: ${value}`)]).join('');
    assert.equal(capture.text, expectedText, 'PDF pagination must preserve every character exactly, including text split across pages');
    for (const [index, geometry] of capture.pages.entries()) {
      assert.equal(geometry.width, 720); assert.equal(geometry.height, 960);
      assert.ok(geometry.scrollHeight <= geometry.clientHeight); assert.ok(geometry.scrollWidth <= geometry.clientWidth);
      assert.deepEqual(geometry.clipped, [], 'No PDF text block may be clipped at a page boundary');
      assert.equal(geometry.footer, `${index + 1} / ${capture.pages.length}`);
    }
    await until(async () => await page.locator('.full-log-pdf-root').count() === 0, 'temporary PDF DOM cleanup');
    const info = execFileSync('pdfinfo', [pdf.filename], { encoding: 'utf8', timeout: 10000 });
    const pages = Number(info.match(/^Pages:\s+(\d+)$/m)?.[1]); assert.equal(pages, capture.pages.length);
    for (const [index, suffix] of [[1, 'first'], [pages, 'last']]) {
      const output = path.join(reportDir, `diaper-rash-pdf-${suffix}`);
      execFileSync('pdftoppm', ['-f', String(index), '-singlefile', '-scale-to', '1100', '-png', pdf.filename, output], { timeout: 10000, stdio: 'pipe' });
      assert.ok(readFileSync(`${output}.png`).length > 1000); report.screenshots.push(`${output}.png`);
    }
    report.evidence.push({ pdfPages: pages, pdfSourceTextCharacters: expectedText.length, exactPdfText: true, pageGeometry: capture.pages,
      actualPdfRasterized: true, temporaryPdfDomRemoved: true });
    record('Actual selected PDF downloads paginate long Unicode/multiline observations with exact source text, unclipped page geometry, matching PDF page count and first/last-page raster evidence');
    assert.deepEqual(await read(siblingRow.id), siblingRow); assert.deepEqual(await read(foreignRow.id), foreignRow);
    assert.deepEqual(await ownRows(), current, 'Selected exports must never mutate care records');
    assert.deepEqual(pageErrors, [], 'Rash browser JavaScript errors');
    assert.equal(report.checks.length, EXPECTED_CHECKS);
  } catch (error) {
    failure = error; report.errors.push(error.message);
    if (page && !page.isClosed()) {
      try { await screenshot('diaper-rash-failure.png'); }
      catch (captureError) { report.captureErrors.push(captureError.message); }
    }
  } finally {
    if (context) {
      try {
        await bounded(context.unrouteAll({ behavior: 'ignoreErrors' }), 4000, 'Rash route cleanup');
        await bounded(context.close(), 5000, 'Rash context closure');
        report.cleanup.contextClosed = context.pages().length === 0;
      } catch (error) { report.cleanup.errors.push(error.message); }
    } else report.cleanup.contextClosed = true;
    try {
      await db.baby.deleteMany({ where: { familyId: { in: familyIds } } });
      await db.settings.deleteMany({ where: { familyId: { in: familyIds } } });
      await db.caretaker.deleteMany({ where: { familyId: { in: familyIds } } });
      await db.family.deleteMany({ where: { id: { in: familyIds } } });
      assert.equal(await db.family.count({ where: { id: { in: familyIds } } }), 0);
      assert.equal(await db.baby.count({ where: { familyId: { in: familyIds } } }), 0);
      assert.equal(await db.diaperLog.count({ where: { familyId: { in: familyIds } } }), 0);
      assert.equal(await db.note.count({ where: { familyId: { in: familyIds } } }), 0);
      report.cleanup.fixtureFamiliesRemoved = true;
    } catch (error) { report.cleanup.errors.push(error.message); }
    report.status = !failure && report.checks.length === EXPECTED_CHECKS && report.cleanup.contextClosed
      && report.cleanup.fixtureFamiliesRemoved && report.cleanup.errors.length === 0 ? 'PASS' : 'FAIL';
    report.completedAt = new Date().toISOString();
    writeFileSync(path.join(reportDir, 'diaper-rash-browser-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  if (failure) throw failure;
  assert.equal(report.status, 'PASS', 'Rash acceptance and owned cleanup must pass');
  return report.checks;
}
