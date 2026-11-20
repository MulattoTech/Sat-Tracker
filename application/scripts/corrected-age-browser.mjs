// Real profile editors and age displays against the source gate's disposable DB.
import assert from 'node:assert/strict';
import { pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DAY_MS = 86_400_000;
const EXPECTED_CHECKS = 10;

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

// The expected cases use independently chosen calendar-day counts, all <6 months.
// Only unit spelling comes from Intl; no application age helper is imported.
function shortDays(days) {
  const weeks = Math.floor(days / 7), remainder = days % 7;
  const units = [];
  if (weeks) units.push(new Intl.NumberFormat('en', { style: 'unit', unit: 'week', unitDisplay: 'short' }).format(weeks));
  if (remainder || !weeks) units.push(new Intl.NumberFormat('en', { style: 'unit', unit: 'day', unitDisplay: 'short' }).format(remainder));
  return new Intl.ListFormat('en', { style: 'short', type: 'unit' }).format(units);
}

function dayInZone(instant, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant).map(part => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / DAY_MS;
}

export async function verifyCorrectedAge({ base, db, browser, reportDir }) {
  assert.equal(new URL(base).hostname, '127.0.0.1', 'Corrected-age checks require the owned local test server');
  const runId = process.env.SAT_TRACKER_ACCEPTANCE_RUN_ID || randomUUID();
  const prefix = `corrected-age-${runId}`;
  const fixedNow = new Date(); // Keep actual-issued JWTs valid; freeze only the browser Date clock.
  const birth = days => new Date(Date.UTC(fixedNow.getUTCFullYear(), fixedNow.getUTCMonth(), fixedNow.getUTCDate() - days, 12, 34, 56, 789));
  const family = { id: `${prefix}-family`, slug: `synthetic-${prefix}`, name: 'Synthetic corrected age family', setupStage: 3 };
  const caregiver = { id: `${prefix}-caregiver`, loginId: '64', securityPin: '5826', name: 'Synthetic Age Reviewer', role: 'ADMIN', type: 'Parent' };
  const babies = [
    { id: `${prefix}-preterm`, firstName: 'AgePreterm', lastName: 'Fixture', birthDate: birth(90), gestationalAgeDays: 224 },
    { id: `${prefix}-term`, firstName: 'AgeTerm', lastName: 'Fixture', birthDate: birth(42), gestationalAgeDays: 259 },
    { id: `${prefix}-before-due`, firstName: 'AgeBeforeDue', lastName: 'Fixture', birthDate: birth(10), gestationalAgeDays: 224 },
  ];
  const [preterm, term, beforeDue] = babies;
  const account = { id: `${prefix}-account`, firstName: 'AgeReviewer', lastName: 'Fixture', email: `${prefix}@example.invalid` };
  const password = `Synthetic!Age-${randomBytes(12).toString('hex')}`;
  const salt = randomBytes(32);
  const passwordHash = `${salt.toString('base64')}:${pbkdf2Sync(password, salt, 100000, 64, 'sha256').toString('base64')}`;
  const report = {
    runId, syntheticOnly: true, startedAt: new Date().toISOString(),
    authentication: 'Actual PIN ADMIN login and actual account login endpoint; no signed fixture JWTs',
    scope: 'Default and storybook profile UI, calendar age, selected-profile refresh, legacy cache and exact birth timestamp preservation',
    checks: [], evidence: [], screenshots: [], errors: [], captureErrors: [],
    cleanup: { errors: [], contextsClosed: false, fixtureFamilyRemoved: false },
  };
  const contexts = [];
  const pageErrors = [];
  let activePage, failure;
  mkdirSync(reportDir, { recursive: true });

  const readBaby = id => db.baby.findUniqueOrThrow({ where: { id } });
  const profile = row => {
    const { updatedAt: _updated, gestationalAgeDays: _gestation, ...other } = row;
    return other;
  };
  const newContext = async timeZone => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: timeZone, locale: 'en-US' });
    contexts.push(context);
    await context.addInitScript(() => { window.__correctedAgeDocument = crypto.randomUUID(); });
    const page = await context.newPage();
    activePage = page;
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(20_000);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.clock.setFixedTime(fixedNow);
    return { context, page };
  };
  const header = (page, baby) => page.getByRole('button', { name: `${baby.firstName}'s Quick Stats`, exact: true });
  const assertAge = async (page, baby, chronologicalDays, corrected) => {
    const area = header(page, baby);
    const expectedChronological = `Chronological age: ${shortDays(chronologicalDays)}`;
    const expectedCorrected = `Corrected age: ${typeof corrected === 'number' ? shortDays(corrected) : corrected}`;
    await until(async () => await area.count() === 1
      && (await area.getByTestId('chronological-age').textContent())?.trim() === expectedChronological
      && (await area.getByTestId('corrected-age').textContent())?.trim() === expectedCorrected,
    `${baby.firstName} chronological and corrected header`);
    assert.equal(await area.getByTestId('child-age-display').count(), 1);
  };
  const assertCached = async (page, baby, gestation) => {
    await until(async () => {
      const cached = await page.evaluate(familyId => JSON.parse(localStorage.getItem(`selectedBaby_${familyId}`) || 'null'), family.id);
      return cached?.id === baby.id && cached.gestationalAgeDays === gestation;
    }, 'selected child cache to contain the server profile');
  };
  const selectBaby = async (page, baby) => {
    await page.getByLabel('Select Baby', { exact: true }).click();
    await page.getByRole('menuitemradio', { name: new RegExp(`^${baby.firstName}\\b`) }).click();
    await header(page, baby).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('babyId'), baby.id);
  };
  const loginPin = async page => {
    await page.goto(`${base}/${family.slug}`, { waitUntil: 'networkidle' });
    const panel = page.locator('.login-container');
    await panel.getByRole('heading', { name: 'Login ID & Security PIN', exact: true }).waitFor();
    for (const digit of caregiver.loginId) await panel.getByRole('button', { name: digit, exact: true }).click();
    assert.equal(await panel.getByLabel('Login ID', { exact: true }).inputValue(), caregiver.loginId);
    for (const digit of caregiver.securityPin) await panel.getByRole('button', { name: digit, exact: true }).click();
    const [response] = await Promise.all([
      page.waitForResponse(value => new URL(value.url()).pathname === '/api/auth' && value.request().method() === 'POST'),
      panel.getByRole('button', { name: 'Go', exact: true }).click(),
    ]);
    const result = await response.json();
    assert.equal(response.status(), 200); assert.equal(result.success, true);
    assert.equal(result.data.id, caregiver.id); assert.equal(result.data.role, 'ADMIN');
    await page.getByLabel('Select Baby', { exact: true }).waitFor();
  };
  const panelClosed = async panel => await panel.evaluate(node => node.classList.contains('translate-x-full'));
  const openSettings = async page => {
    await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await until(async () => !await panelClosed(settings), 'settings opening');
    await settings.getByRole('tab', { name: 'Config', exact: true }).click();
    const section = settings.getByRole('heading', { name: 'Manage Babies', exact: true }).locator('..');
    await section.getByRole('combobox').click();
    await page.getByRole('option', { name: `${preterm.firstName} ${preterm.lastName}`, exact: true }).click();
    return { settings, section };
  };
  const openDefault = async (page, section) => {
    await section.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit Baby', exact: true });
    await until(async () => !await panelClosed(editor), 'default baby editor opening');
    await editor.getByLabel('Gestational weeks at birth', { exact: true }).waitFor();
    return editor;
  };
  const fillGestation = async (editor, weeks, days) => {
    await editor.getByLabel('Gestational weeks at birth', { exact: true }).fill(weeks);
    await editor.getByLabel('Additional days at birth', { exact: true }).fill(days);
  };
  const assertForm = async (editor, weeks, days) => {
    assert.equal(await editor.getByLabel('Gestational weeks at birth', { exact: true }).inputValue(), weeks);
    assert.equal(await editor.getByLabel('Additional days at birth', { exact: true }).inputValue(), days);
    assert.equal(await editor.getByTestId('gestational-age-inputs').count(), 1);
    const labels = await editor.getByTestId('gestational-age-inputs').evaluate(group => [...group.querySelectorAll('label[for]')].map(label => ({
      targetInGroup: Boolean(label.control && group.contains(label.control)),
      targetCount: [...document.querySelectorAll('[id]')].filter(node => node.id === label.htmlFor).length,
    })));
    assert.equal(labels.length, 2);
    assert.ok(labels.every(label => label.targetInGroup && label.targetCount === 1), 'Gestation labels must target one control in this editor');
  };
  const save = async (page, editor, gestation, appearance = 'default') => {
    const before = await readBaby(preterm.id);
    const documentId = await page.evaluate(() => window.__correctedAgeDocument);
    const [response] = await Promise.all([
      page.waitForResponse(value => new URL(value.url()).pathname === '/api/baby' && value.request().method() === 'PUT'),
      editor.getByRole('button', { name: appearance === 'default' ? 'Update' : 'Save changes', exact: true }).click(),
    ]);
    const result = await response.json();
    assert.equal(response.status(), 200); assert.equal(result.success, true);
    const request = response.request().postDataJSON();
    assert.equal(request.id, preterm.id); assert.equal(request.gestationalAgeDays, gestation);
    assert.equal(Object.hasOwn(request, 'birthDate'), false, 'Gestation-only UI edits must omit the unchanged birth instant');
    assert.equal(result.data.gestationalAgeDays, gestation);
    assert.equal(result.data.birthDate, preterm.birthDate.toISOString());
    if (appearance === 'default') await until(() => panelClosed(editor), 'default editor completion');
    else await editor.waitFor({ state: 'hidden' });
    const after = await readBaby(preterm.id);
    assert.deepEqual(profile(after), profile(before), 'Gestation-only edit changed other child fields');
    assert.equal(after.gestationalAgeDays, gestation);
    assert.equal(after.birthDate.getTime(), preterm.birthDate.getTime(), 'Birth milliseconds must survive profile edits');
    assert.equal(await page.evaluate(() => window.__correctedAgeDocument), documentId, 'A profile edit must not require document navigation');
    await assertCached(page, preterm, gestation);
    await page.waitForLoadState('networkidle', { timeout: 5000 });
    report.evidence.push({ appearance, gestationalAgeDays: gestation, birthDate: after.birthDate.toISOString(), unchangedBirthOmitted: true, sameDocument: true });
  };
  const rejectInputs = async (page, editor, cases, appearance = 'default') => {
    const before = await readBaby(preterm.id);
    const writes = [];
    const observe = request => { if (new URL(request.url()).pathname === '/api/baby' && request.method() === 'PUT') writes.push(request.postDataJSON()); };
    page.on('request', observe);
    try {
      for (const [weeks, days] of cases) {
        await fillGestation(editor, weeks, days);
        await editor.getByRole('button', { name: appearance === 'default' ? 'Update' : 'Save changes', exact: true }).click();
        await editor.getByRole('alert').waitFor();
        assert.ok(await editor.locator('[aria-invalid="true"]').count() > 0, 'Invalid gestation must identify a field');
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(writes.length, 0, 'Invalid gestation must not send a profile write');
        assert.deepEqual(await readBaby(preterm.id), before, 'Invalid gestation changed stored data');
      }
    } finally { page.off('request', observe); }
  };
  const screenshot = async (page, name, fullPage = true) => {
    const file = path.join(reportDir, name);
    await page.screenshot({ path: file, fullPage, timeout: 5000 });
    report.screenshots.push(file);
  };
  const assertInViewport = async (locator, label) => {
    await locator.waitFor({ state: 'visible' });
    const box = await locator.evaluate(node => {
      const { left, top, right, bottom, width, height } = node.getBoundingClientRect();
      return { left, top, right, bottom, width, height, viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    assert.ok(box.width > 0 && box.height > 0 && box.left >= -1 && box.top >= -1
      && box.right <= box.viewportWidth + 1 && box.bottom <= box.viewportHeight + 1,
    `${label} must fit the viewport: ${JSON.stringify(box)}`);
  };
  const assertNoHorizontalOverflow = async (page, area, label) => {
    const widths = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    assert.ok(widths.document <= widths.viewport + 1, `${label} document must not scroll horizontally: ${JSON.stringify(widths)}`);
    const overflowing = await area.evaluate(node => [node, ...node.querySelectorAll('.form-page-content, .sb-pane-bd, [data-testid="gestational-age-inputs"], [data-testid="child-age-display"]')]
      .filter(element => element.scrollWidth > element.clientWidth + 1)
      .map(element => ({ tag: element.tagName, className: element.className, width: element.clientWidth, content: element.scrollWidth })));
    assert.deepEqual(overflowing, [], `${label} content must not overflow horizontally`);
  };
  const responsiveEditor = async (page, editor, viewport, weeks, days, appearance) => {
    await page.setViewportSize(viewport);
    const profileLabels = appearance === 'default' ? ['First Name', 'Last Name', 'Birth Date'] : ['First name', 'Last name', 'Birth date'];
    for (const name of profileLabels) {
      const input = editor.getByLabel(name, { exact: true });
      await input.click({ trial: true });
      await assertInViewport(input, `${appearance} ${name} field`);
    }
    const group = editor.getByTestId('gestational-age-inputs');
    await group.scrollIntoViewIfNeeded();
    await fillGestation(editor, weeks, days);
    await assertForm(editor, weeks, days);
    await editor.getByLabel('Gestational weeks at birth', { exact: true }).click();
    await page.keyboard.press('Tab');
    assert.equal(await editor.getByLabel('Additional days at birth', { exact: true }).evaluate(node => node === document.activeElement), true,
      'Keyboard traversal must reach the additional-days input at the responsive size');
    for (const name of ['Cancel', appearance === 'default' ? 'Update' : 'Save changes']) {
      const action = editor.getByRole('button', { name, exact: true });
      await action.click({ trial: true });
      await assertInViewport(action, `${appearance} ${name} action`);
    }
    await group.scrollIntoViewIfNeeded();
    for (const label of await group.locator('label[for]').all()) await assertInViewport(label, `${appearance} gestation label`);
    for (const name of ['Gestational weeks at birth', 'Additional days at birth']) {
      const input = editor.getByLabel(name, { exact: true });
      await input.click({ trial: true });
      await assertInViewport(input, `${appearance} ${name} input`);
    }
    await assertNoHorizontalOverflow(page, editor, `${appearance} editor`);
    report.evidence.push({ appearance, viewport, responsiveEditor: true, keyboardTraversal: true, labelsAndActionsVisible: true, horizontalOverflow: false });
  };
  const responsiveHeader = async (page, baby, appearance) => {
    const area = header(page, baby);
    await area.click({ trial: true });
    for (const target of [area, area.getByTestId('chronological-age'), area.getByTestId('corrected-age'), page.getByLabel('Select Baby', { exact: true })]) {
      await assertInViewport(target, `${appearance} child header`);
    }
    await page.getByLabel('Select Baby', { exact: true }).click({ trial: true });
    await assertNoHorizontalOverflow(page, area, `${appearance} child header`);
    report.evidence.push({ appearance, viewport: page.viewportSize(), responsiveHeader: true, ageLabelsVisible: true, childSelectionAccessible: true, horizontalOverflow: false });
  };

  try {
    await db.family.create({ data: family });
    await db.settings.create({ data: { familyId: family.id, familyName: family.name, authType: 'CARETAKER' } });
    await db.caretaker.create({ data: { ...caregiver, familyId: family.id, lastSeenVersion: '1.6.7' } });
    await db.baby.createMany({ data: babies.map(baby => ({ ...baby, familyId: family.id, gender: 'FEMALE', dailyIntakeTargetMl: 615.5 })) });
    await db.account.create({ data: { ...account, password: passwordHash, verified: true, familyId: family.id, caretakerId: caregiver.id, planType: 'full', lastSeenVersion: '1.6.7' } });
    const termSnapshot = await readBaby(term.id), dueSnapshot = await readBaby(beforeDue.id);
    const { context, page } = await newContext('UTC');
    const legacy = { ...await readBaby(preterm.id), birthDate: preterm.birthDate.toISOString() };
    delete legacy.gestationalAgeDays;
    await context.addInitScript(({ familyId, profile }) => {
      if (!sessionStorage.getItem('syntheticLegacyAgeSeeded')) {
        localStorage.setItem(`selectedBaby_${familyId}`, JSON.stringify(profile));
        sessionStorage.setItem('syntheticLegacyAgeSeeded', 'true');
      }
    }, { familyId: family.id, profile: legacy });
    await loginPin(page);
    await assertAge(page, preterm, 90, 34);
    await assertCached(page, preterm, 224);
    await page.waitForLoadState('networkidle', { timeout: 5000 });
    report.checks.push('Legacy selected-child cache without gestation hydrates actual server data and labels chronological and corrected ages separately');

    // A single actual profile GET is delivered in the pre-field response shape.
    // This deliberately tests an older/partial editor model against a newer DB;
    // authentication, write responses and all other GET fields remain real.
    let legacyResponseObserved = false, legacyResponseError;
    await page.route(`${base}/api/baby`, async route => {
      try {
        assert.equal(route.request().method(), 'GET');
        const response = await route.fetch({ timeout: 10_000 });
        const body = await response.json();
        assert.equal(response.status(), 200); assert.equal(body.success, true);
        const record = body.data.find(row => row.id === preterm.id);
        assert.equal(record.gestationalAgeDays, 224);
        delete record.gestationalAgeDays;
        legacyResponseObserved = true;
        await route.fulfill({ response, json: body });
      } catch (error) {
        legacyResponseError = error.message;
        await route.abort('failed');
      }
    }, { times: 1 });
    let { settings, section } = await openSettings(page);
    let editor = await openDefault(page, section);
    assert.equal(legacyResponseError, undefined); assert.equal(legacyResponseObserved, true);
    await assertForm(editor, '', '');
    const beforeNameEdit = await readBaby(preterm.id);
    await editor.getByLabel('Last Name', { exact: true }).fill('FixtureReviewed');
    const [unrelatedResponse] = await Promise.all([
      page.waitForResponse(value => new URL(value.url()).pathname === '/api/baby' && value.request().method() === 'PUT'),
      editor.getByRole('button', { name: 'Update', exact: true }).click(),
    ]);
    const unrelatedResult = await unrelatedResponse.json();
    assert.equal(unrelatedResponse.status(), 200); assert.equal(unrelatedResult.success, true);
    const unrelatedPayload = unrelatedResponse.request().postDataJSON();
    assert.equal(Object.hasOwn(unrelatedPayload, 'gestationalAgeDays'), false, 'Untouched gestation must be omitted even when the editor has a legacy partial profile');
    assert.equal(Object.hasOwn(unrelatedPayload, 'birthDate'), false);
    await until(() => panelClosed(editor), 'legacy profile name-only edit completion');
    const afterNameEdit = await readBaby(preterm.id);
    assert.deepEqual(afterNameEdit, { ...beforeNameEdit, lastName: 'FixtureReviewed', updatedAt: afterNameEdit.updatedAt });
    preterm.lastName = 'FixtureReviewed';
    await assertAge(page, preterm, 90, 34);
    await assertCached(page, preterm, 224);
    await page.waitForLoadState('networkidle', { timeout: 5000 });
    report.checks.push('An unrelated real edit from a legacy profile response omits untouched gestation and birth date, preserving the newer recorded values');

    editor = await openDefault(page, section);
    await assertForm(editor, '32', '0');
    await fillGestation(editor, '34', '0');
    await screenshot(page, 'corrected-age-default.png');
    await responsiveEditor(page, editor, { width: 390, height: 844 }, '34', '0', 'default');
    await screenshot(page, 'corrected-age-default-phone.png', false);
    await save(page, editor, 238);
    await assertAge(page, preterm, 90, 48);
    await settings.getByRole('button', { name: 'Close', exact: true }).last().click();
    await until(() => panelClosed(settings), 'settings closing');
    await responsiveHeader(page, preterm, 'default');
    await screenshot(page, 'corrected-age-phone-header.png', false);
    report.checks.push('Default editor saves gestation at 390×844 with accessible labels, keyboard input and actions, no horizontal overflow, and an immediately refreshed visible child header without rewriting the exact birth instant');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await selectBaby(page, term);
    await assertAge(page, term, 42, 'Not applicable');
    await page.reload({ waitUntil: 'networkidle' });
    await assertAge(page, term, 42, 'Not applicable');
    await selectBaby(page, preterm);
    await assertAge(page, preterm, 90, 48);
    await assertCached(page, preterm, 238);
    report.checks.push('Child switching and document reload preserve independent profiles; a 37-week birth is explicitly not corrected');

    await selectBaby(page, beforeDue);
    await assertAge(page, beforeDue, 10, `${shortDays(46)} before estimated due date`);
    await selectBaby(page, preterm);
    report.checks.push('A child before the estimated due date shows time remaining instead of a negative corrected age');

    ({ settings, section } = await openSettings(page));
    editor = await openDefault(page, section);
    await assertForm(editor, '34', '0');
    await rejectInputs(page, editor, [['46', '0'], ['36', '7'], ['3.5', '0'], ['', '4']]);
    report.checks.push('Default editor rejects excessive weeks, out-of-range days, fractions and days without weeks with visible field errors and no write');

    await fillGestation(editor, '35', '');
    await save(page, editor, 245);
    await assertAge(page, preterm, 90, 55);
    editor = await openDefault(page, section);
    await assertForm(editor, '35', '0');
    report.checks.push('Whole weeks with blank additional days save exact zero-extra-day gestation and hydrate it when reopened');

    await fillGestation(editor, '', '');
    await save(page, editor, null);
    await assertAge(page, preterm, 90, 'Not recorded');
    await settings.getByRole('button', { name: 'Close', exact: true }).last().click();
    await until(() => panelClosed(settings), 'settings closing after clear');
    await page.reload({ waitUntil: 'networkidle' });
    await assertAge(page, preterm, 90, 'Not recorded');
    report.checks.push('Explicitly clearing both default-form fields stores null and keeps corrected age unknown after reload');

    const story = await newContext('America/Chicago');
    const loginResponse = await story.context.request.post(`${base}/api/accounts/login`, { data: { email: account.email, password }, timeout: 10_000 });
    const signedIn = await loginResponse.json();
    assert.equal(loginResponse.status(), 200); assert.equal(signedIn.success, true);
    assert.equal(signedIn.data.user.id, account.id); assert.equal(signedIn.data.user.familyId, family.id);
    await story.context.addInitScript(({ token, user }) => {
      if (!sessionStorage.getItem('syntheticAgeAccountSeeded')) {
        localStorage.setItem('authToken', token); localStorage.setItem('unlockTime', String(Date.now()));
        localStorage.setItem('accountUser', JSON.stringify(user));
        sessionStorage.setItem('syntheticAgeAccountSeeded', 'true');
      }
    }, { token: signedIn.data.token, user: signedIn.data.user });
    const storyDays = dayInZone(fixedNow, 'America/Chicago') - dayInZone(preterm.birthDate, 'America/Chicago');
    await story.page.goto(`${base}/${family.slug}/log-entry?babyId=${preterm.id}`, { waitUntil: 'networkidle' });
    await assertAge(story.page, preterm, storyDays, 'Not recorded');
    const openStory = async () => {
      const manager = story.page.getByRole('dialog', { name: 'Your account', exact: true });
      if (!await manager.count()) {
        await story.page.getByRole('button', { name: 'Hi, AgeReviewer', exact: true }).click();
        await story.page.getByRole('menuitem', { name: 'Account settings', exact: true }).click();
        await manager.getByRole('button', { name: 'Family & people', exact: true }).click();
      }
      const row = manager.locator('.sb-prow').filter({ has: story.page.getByText(`${preterm.firstName} ${preterm.lastName}`, { exact: true }) });
      await row.getByRole('button', { name: 'Edit', exact: true }).click();
      const panel = story.page.getByRole('dialog', { name: 'Edit baby', exact: true });
      await panel.getByLabel('Gestational weeks at birth', { exact: true }).waitFor();
      return { manager, panel };
    };
    let { manager, panel } = await openStory();
    await assertForm(panel, '', '');
    await rejectInputs(story.page, panel, [['45', '1']], 'storybook');
    await fillGestation(panel, '33', '6');
    await screenshot(story.page, 'corrected-age-storybook.png');
    await responsiveEditor(story.page, panel, { width: 768, height: 1024 }, '33', '6', 'storybook');
    await screenshot(story.page, 'corrected-age-storybook-tablet.png', false);
    await save(story.page, panel, 237, 'storybook');
    // Radix hides the underlying header from accessibility while the account
    // drawer is open. Close that drawer before asserting the visible header.
    await manager.getByRole('button', { name: 'Close', exact: true }).click();
    await manager.waitFor({ state: 'hidden' });
    await assertAge(story.page, preterm, storyDays, storyDays - 43);
    await responsiveHeader(story.page, preterm, 'storybook');
    await screenshot(story.page, 'corrected-age-tablet-header.png', false);
    await story.page.setViewportSize({ width: 1440, height: 1000 });
    ({ manager, panel } = await openStory());
    await assertForm(panel, '33', '6');
    report.checks.push('Actual account storybook editor rejects invalid gestation, saves at 768×1024 with accessible labels, keyboard input and actions, no horizontal overflow, and refreshes the visible child header using the browser time zone');

    await fillGestation(panel, '', '');
    await save(story.page, panel, null, 'storybook');
    await manager.getByRole('button', { name: 'Close', exact: true }).click();
    await manager.waitFor({ state: 'hidden' });
    await story.page.reload({ waitUntil: 'networkidle' });
    await assertAge(story.page, preterm, storyDays, 'Not recorded');
    assert.deepEqual(await readBaby(term.id), termSnapshot);
    assert.deepEqual(await readBaby(beforeDue.id), dueSnapshot);
    assert.deepEqual(pageErrors, [], 'Corrected-age editor browser JavaScript errors');
    report.checks.push('Storybook explicit clear survives reload without changing either sibling profile or the original birth timestamp');
    assert.equal(report.checks.length, EXPECTED_CHECKS);
  } catch (error) {
    failure = error;
    report.errors.push(error.message);
    if (activePage && !activePage.isClosed()) {
      try { await screenshot(activePage, 'corrected-age-failure.png'); }
      catch (captureError) { report.captureErrors.push(captureError.message); }
    }
  } finally {
    for (const context of contexts) {
      try { await bounded(context.close(), 5000, 'Corrected-age context closure'); }
      catch (error) { report.cleanup.errors.push(error.message); }
    }
    report.cleanup.contextsClosed = contexts.every(context => context.pages().length === 0);
    try {
      await db.account.deleteMany({ where: { id: account.id, familyId: family.id } });
      await db.baby.deleteMany({ where: { familyId: family.id } });
      await db.settings.deleteMany({ where: { familyId: family.id } });
      await db.caretaker.deleteMany({ where: { familyId: family.id } });
      await db.family.deleteMany({ where: { id: family.id } });
      assert.equal(await db.family.count({ where: { id: family.id } }), 0);
      assert.equal(await db.baby.count({ where: { familyId: family.id } }), 0);
      assert.equal(await db.account.count({ where: { id: account.id } }), 0);
      report.cleanup.fixtureFamilyRemoved = true;
    } catch (error) { report.cleanup.errors.push(error.message); }
    report.status = !failure && report.checks.length === EXPECTED_CHECKS && report.cleanup.contextsClosed
      && report.cleanup.fixtureFamilyRemoved && report.cleanup.errors.length === 0 ? 'PASS' : 'FAIL';
    report.completedAt = new Date().toISOString();
    writeFileSync(path.join(reportDir, 'corrected-age-browser-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  if (failure) throw failure;
  assert.equal(report.status, 'PASS', 'Corrected-age acceptance and owned cleanup must pass');
  return report.checks;
}
