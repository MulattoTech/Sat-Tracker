// Actual USER logins and dose forms against the runner's disposable SQLite app.
// This module owns its profile, actors and family; it never uses a live session.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

export async function verifyMedicineDoseRecovery({ base, db, scratch, reportDir }) {
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  const prefix = `dose-browser-${randomUUID()}`;
  const profile = path.join(scratch, prefix);
  const family = { id: `${prefix}-family`, slug: `synthetic-${prefix.slice(-36)}`, name: 'Synthetic dose recovery family' };
  const babies = ['Alpha', 'Beta'].map(name => ({ id: `${prefix}-${name}`, firstName: `Synthetic ${name}`, familyId: family.id }));
  const actors = [
    { id: `${prefix}-actor-a`, loginId: '01', securityPin: '123456', name: 'Synthetic caregiver Alpha' },
    { id: `${prefix}-actor-b`, loginId: '02', securityPin: '654321', name: 'Synthetic caregiver Beta' },
  ];
  const endpoint = `${base}/api/medicine-log`;
  const pendingMessage = 'Saving this dose could not be confirmed. Its original details are kept. Retry the saved request.';
  const timeoutMessage = 'Saving the dose request timed out. Its original details are kept.';
  const checks = [], errors = [], medicines = [], requests = [];
  const report = { syntheticOnly: true, authentication: 'Actual PIN UI and POST /api/auth USER logins', checks, evidence: [], screenshots: [] };
  let context, page, activePage;
  const persist = () => {
    if (reportDir) {
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(path.join(reportDir, 'medicine-dose-recovery-browser-report.json'), JSON.stringify(report, null, 2));
    }
  };
  const check = description => { checks.push(description); persist(); };
  const until = async (condition, description, timeout = 15_000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await condition()) return;
      if (Date.now() >= deadline) throw new Error(`Dose browser timed out: ${description}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const scope = (baby = babies[0], actor = actors[0]) => JSON.stringify([family.id, `caretaker:${actor.id}`, baby.id]);
  const key = (baby, actor) => `medicineDosePendingV1:${scope(baby, actor)}`;
  const saved = (target = page, baby, actor) => target.evaluate(key => {
    const value = localStorage.getItem(key); return value === null ? null : JSON.parse(value);
  }, key(baby, actor));
  const rows = medicine => db.medicineLog.findMany({ where: { familyId: family.id, medicineId: medicine.id }, orderBy: { createdAt: 'asc' } });
  const tracker = target => target.getByRole('dialog', { name: 'Medicine Tracker', exact: true });
  const editor = target => target.getByRole('dialog', { name: 'Give Medicine', exact: true });
  const pending = target => editor(target).getByRole('region', { name: 'Dose awaiting confirmation', exact: true });
  const isClosed = panel => panel.evaluate(element => element.classList.contains('translate-x-full'));
  const waitClosed = panel => until(() => panel.evaluate(element => element.classList.contains('translate-x-full')
    && element.getBoundingClientRect().left >= innerWidth - 1), 'form closing animation');
  const track = target => {
    target.setDefaultTimeout(15_000); target.setDefaultNavigationTimeout(25_000);
    target.on('pageerror', error => errors.push(error.message));
    target.on('requestfailed', request => {
      report.failedRequests ??= [];
      report.failedRequests.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText });
      report.failedRequests = report.failedRequests.slice(-30);
    });
    target.on('response', response => {
      if (response.request().isNavigationRequest()) {
        report.navigations ??= [];
        report.navigations.push({ path: new URL(response.url()).pathname, status: response.status(), location: response.headers().location });
        report.navigations = report.navigations.slice(-30);
      }
    });
    target.on('console', message => {
      if (/redirect|slug|family|load|chunk/i.test(message.text())) {
        report.navigationMessages ??= [];
        report.navigationMessages.push(message.text().slice(0, 300));
        report.navigationMessages = report.navigationMessages.slice(-20);
      }
    });
    target.on('request', request => {
      if (request.url() === endpoint && request.method() === 'POST') requests.push(request.postDataJSON());
    });
    return target;
  };
  const launch = async () => {
    context = await chromium.launchPersistentContext(profile, { headless: true,
      executablePath: process.env.BABYTRACKER_TEST_BROWSER_PATH || undefined,
      serviceWorkers: 'block', timezoneId: 'UTC', viewport: { width: 1440, height: 1100 } });
    await context.addInitScript(() => {
      const fonts = document.fonts, ready = fonts.ready;
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      window.__doseLoginFonts = { reads: 0, released: false, release: () => {
        window.__doseLoginFonts.released = true; release();
      } };
      Object.defineProperty(fonts, 'ready', { configurable: true, get: () => {
        window.__doseLoginFonts.reads++;
        return ready.then(() => gate).then(() => fonts);
      } });
    });
    page = track(context.pages()[0] || await context.newPage()); activePage = page;
  };
  const login = async (target, actor, navigate = true) => {
    activePage = target;
    if (navigate) await target.goto(`${base}/${family.slug}`, { waitUntil: 'networkidle' });
    const panel = target.locator('.login-container');
    await panel.getByRole('heading', { name: 'Login ID & Security PIN', exact: true }).waitFor();
    const loginId = panel.getByLabel('Login ID', { exact: true });
    const pin = panel.getByLabel('Security PIN', { exact: true });
    if (await target.evaluate(() => window.__doseLoginFonts?.released === false)) {
      await target.waitForFunction(() => window.__doseLoginFonts.reads > 0);
    }
    for (let index = 0; index < actor.loginId.length; index++) {
      await panel.getByRole('button', { name: actor.loginId[index], exact: true }).click();
      if (index === 0 && await target.evaluate(() => window.__doseLoginFonts?.released === false)) {
        // A real delayed layout update must preserve the first committed digit.
        await until(async () => await loginId.inputValue() === actor.loginId[0], 'first login ID digit committed');
        await target.evaluate(() => window.__doseLoginFonts.release());
        await target.waitForFunction(() => document.querySelector('.login-container .login-title')?.style.opacity === '1');
        await target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      assert.equal(await loginId.inputValue(), actor.loginId.slice(0, index + 1));
    }
    for (let index = 0; index < actor.securityPin.length; index++) {
      await panel.getByRole('button', { name: actor.securityPin[index], exact: true }).click();
      assert.equal(await pin.inputValue(), actor.securityPin.slice(0, index + 1));
    }
    const [response] = await Promise.all([
      target.waitForResponse(value => new URL(value.url()).pathname === '/api/auth' && value.request().method() === 'POST'),
      panel.getByRole('button', { name: 'Go', exact: true }).click(),
    ]);
    const result = await response.json();
    assert.equal(response.status(), 200); assert.equal(result.data.role, 'USER'); assert.equal(result.data.id, actor.id);
    await target.getByLabel('Select Baby', { exact: true }).waitFor();
  };
  const select = async (target, baby) => {
    activePage = target;
    await target.getByLabel('Select Baby', { exact: true }).click();
    await target.getByRole('menuitemradio', { name: new RegExp('^' + baby.firstName) }).click();
    await target.getByRole('button', { name: `${baby.firstName}'s Quick Stats`, exact: true }).waitFor();
    assert.equal(new URL(target.url()).searchParams.get('babyId'), baby.id);
  };
  const open = async (target, medicine, notes = 'Synthetic one administered dose') => {
    activePage = target;
    await tracker(target).waitFor({ state: 'attached' });
    if (await isClosed(tracker(target))) await target.getByRole('button', { name: 'Medicine', exact: true }).click();
    await tracker(target).getByRole('button', { name: 'Give Medicine', exact: true }).click();
    await until(async () => !await isClosed(editor(target)), 'dose editor opening');
    if (medicine) {
      await editor(target).getByRole('button', { name: 'Select a medicine', exact: true }).click();
      await target.getByRole('menuitem', { name: medicine.name, exact: true }).click();
      await editor(target).getByLabel('Dose', { exact: true }).fill('2.5');
      await editor(target).getByLabel('Notes (optional)', { exact: true }).fill(notes);
    }
    return editor(target);
  };
  const closeDose = async target => {
    await editor(target).getByRole('button', { name: 'Close', exact: true }).last().click();
    await waitClosed(editor(target));
  };
  const closeTracker = async target => {
    await tracker(target).getByRole('button', { name: 'Close', exact: true }).last().click();
    await waitClosed(tracker(target));
  };
  const medicine = async label => {
    const value = await db.medicine.create({ data: { id: `${prefix}-${label}`, familyId: family.id,
      name: `Synthetic ${label} medicine`, typicalDoseSize: 2.5, unitAbbr: 'ML', doseMinTime: '00:04:00', active: true } });
    medicines.push(value); return value;
  };
  const pressSave = target => editor(target).getByRole('button', { name: 'Save', exact: true }).click();
  const waitPending = async target => {
    await pending(target).waitFor();
    await pending(target).getByRole('button', { name: 'Retry saved dose', exact: true }).waitFor();
    assert.equal(await editor(target).getByLabel('Dose', { exact: true }).count(), 0, 'Uncertain quantity is read-only');
    return saved(target);
  };
  const confirm = async (target, snapshot = null) => {
    const [response] = await Promise.all([
      target.waitForResponse(value => value.url() === endpoint && value.request().method() === 'POST'),
      snapshot ? pending(target).getByRole('button', { name: 'Retry saved dose', exact: true }).click() : pressSave(target),
    ]);
    const result = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(result)); assert.equal(result.success, true);
    if (snapshot) assert.deepEqual(response.request().postDataJSON(), snapshot.request, 'Retry must keep the first request and payload');
    await waitClosed(editor(target));
    return result.data;
  };
  const lose = async (target, med) => {
    let evidence;
    const handler = async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch(), result = await response.json();
      assert.equal(response.status(), 200); assert.equal(result.success, true);
      evidence = { request: route.request().postDataJSON(), id: result.data.id };
      await route.abort('failed');
    };
    await target.route(endpoint, handler); await pressSave(target);
    const snapshot = await waitPending(target);
    await editor(target).getByRole('alert').filter({ hasText: pendingMessage }).waitFor();
    await target.unroute(endpoint, handler);
    assert.equal((await rows(med)).length, 1); assert.deepEqual(snapshot.request, evidence.request);
    return { snapshot, ...evidence };
  };
  const total = async (target, med, text) => {
    const card = tracker(target).locator('.medicine-form-dose-card').filter({ has: target.getByRole('heading', { name: med.name, exact: true }) });
    await card.getByText(`Total in last 24h: ${text} ml`, { exact: true }).waitFor();
  };
  const holdSuccess = async target => {
    let release, finish, committed;
    const gate = new Promise(resolve => { release = resolve; });
    const finished = new Promise(resolve => { finish = resolve; });
    const handler = async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch(), result = await response.json();
      assert.equal(response.status(), 200); committed = result.data;
      await gate;
      await route.fulfill({ response }).catch(() => {});
      finish();
    };
    await target.route(endpoint, handler);
    return { wait: () => until(() => !!committed, 'server committed the held dose'),
      release: async () => {
        release(); await finished; await target.unroute(endpoint, handler);
        await target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }, row: () => committed };
  };
  const holdLock = async target => {
    await target.evaluate(key => {
      window.__doseLockRelease = null;
      window.__doseHeldLock = navigator.locks.request(key, () => new Promise(resolve => { window.__doseLockRelease = resolve; }));
    }, key());
    await until(() => target.evaluate(() => typeof window.__doseLockRelease === 'function'), 'real Web Lock acquired');
    return async () => {
      await target.evaluate(() => window.__doseLockRelease());
      await target.evaluate(() => window.__doseHeldLock);
    };
  };
  const queuedLocks = async (target, count) => until(async () => target.evaluate(async ({ key, count }) =>
    (await navigator.locks.query()).pending.filter(lock => lock.name === key).length >= count, { key: key(), count }), 'both real lock requests queued', 2500);

  try {
    await db.family.create({ data: { ...family, setupStage: 3 } });
    await db.baby.createMany({ data: babies.map(baby => ({ ...baby, lastName: 'Dose', birthDate: new Date('2026-01-01Z') })) });
    await db.caretaker.createMany({ data: actors.map(actor => ({ ...actor, familyId: family.id, role: 'USER', type: 'parent', lastSeenVersion: '1.6.7' })) });
    await db.settings.create({ data: { familyId: family.id, familyName: family.name, authType: 'CARETAKER' } });
    await db.unit.upsert({ where: { unitAbbr: 'ML' }, create: { unitAbbr: 'ML', unitName: 'Milliliters', activityTypes: 'medicine' }, update: {} });
    const resolved = await fetch(`${base}/api/family/by-slug/${family.slug}`, { signal: AbortSignal.timeout(5000) });
    assert.equal(resolved.status, 200); assert.equal((await resolved.json()).data?.id, family.id, 'Fixture slug must satisfy the ordinary public resolver');
    await launch(); await login(page, actors[0]); await select(page, babies[0]);

    const ordinary = await medicine('ordinary'); await open(page, ordinary);
    const beforeCancel = requests.length;
    await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click(); await waitClosed(editor(page));
    assert.equal(requests.length, beforeCancel); assert.equal(await saved(), null); assert.equal((await rows(ordinary)).length, 0);
    await open(page, ordinary); const first = await confirm(page);
    assert.equal(first.caretakerId, actors[0].id); assert.equal(first.babyId, babies[0].id);
    assert.equal((await rows(ordinary)).length, 1); await total(page, ordinary, '2.5');
    check('Actual USER login and ordinary dose form: Cancel sends nothing; confirmed 2.5 ML creates one row and a 2.5 ml active total');

    const lost = await medicine('lost response'); await open(page, lost);
    const lostResult = await lose(page, lost);
    await closeDose(page);
    await tracker(page).getByRole('button', { name: 'Review saved dose', exact: true }).click();
    assert.deepEqual(await waitPending(page), lostResult.snapshot);
    await page.reload({ waitUntil: 'networkidle' }); await select(page, babies[0]); await open(page);
    assert.deepEqual(await waitPending(page), lostResult.snapshot);
    const replay = await confirm(page, lostResult.snapshot);
    assert.equal(replay.id, lostResult.id); assert.equal((await rows(lost)).length, 1); await total(page, lost, '2.5');
    report.evidence.push({ case: 'lost response', requestId: lostResult.request.requestId, rowIds: (await rows(lost)).map(row => row.id), displayedTotal: '2.5 ml' });
    check('Lost successful dose response survives close and reload; explicit retry keeps the UUID, first time and 2.5 ML without doubling the active total');

    const restarted = await medicine('browser restart'); await open(page, restarted);
    const restartResult = await lose(page, restarted);
    await context.close(); context = null; await launch();
    await page.goto(`${base}/${family.slug}/log-entry`, { waitUntil: 'networkidle' });
    await select(page, babies[0]); await open(page);
    assert.deepEqual(await waitPending(page), restartResult.snapshot);
    assert.equal((await confirm(page, restartResult.snapshot)).id, restartResult.id); assert.equal((await rows(restarted)).length, 1);
    check('A real Chromium profile restart restores the original unconfirmed dose and acknowledges the same row on explicit retry');

    const offline = await medicine('offline'); await open(page, offline, 'Synthetic offline first values');
    await context.setOffline(true); await pressSave(page); const offlineSaved = await waitPending(page);
    await editor(page).getByRole('alert').filter({ hasText: pendingMessage }).waitFor();
    assert.equal((await rows(offline)).length, 0);
    await context.setOffline(false);
    await db.medicine.update({ where: { id: offline.id }, data: { typicalDoseSize: 99 } });
    await page.reload({ waitUntil: 'networkidle' }); await select(page, babies[0]); await open(page);
    assert.deepEqual(await waitPending(page), offlineSaved); assert.equal((await rows(offline)).length, 0);
    await confirm(page, offlineSaved); const offlineRows = await rows(offline);
    assert.equal(offlineRows.length, 1); assert.equal(offlineRows[0].doseAmount, 2.5); assert.equal(offlineRows[0].unitAbbr, 'ML');
    check('Offline dose remains local without automatic dispatch; reconnect and catalog changes do not replace its original quantity, unit, time or notes');

    const rejected = await medicine('rejections'); await open(page, rejected);
    for (const status of [400, 403]) {
      const handler = route => route.request().method() === 'POST'
        ? route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ success: false, error: `Synthetic ${status} dose rejection` }) }) : route.continue();
      await page.route(endpoint, handler);
      if (status === 400) await pressSave(page); else await pending(page).getByRole('button', { name: 'Retry saved dose', exact: true }).click();
      await waitPending(page);
      await editor(page).getByRole('alert').filter({ hasText: status === 400 ? 'Synthetic 400 dose rejection' : 'Sign in again as the original caregiver' }).waitFor();
      await page.unroute(endpoint, handler); assert.equal((await rows(rejected)).length, 0);
    }
    const rejectedSaved = await saved(); await confirm(page, rejectedSaved); assert.equal((await rows(rejected)).length, 1);
    check('Definite 400 and 403 responses retain one immutable request for review and explicit retry without false success or new identity');

    const deleted = await medicine('deleted source'); await open(page, deleted);
    const deletedResult = await lose(page, deleted);
    const loginResponse = await context.request.post(`${base}/api/auth`, { data: { familySlug: family.slug, loginId: actors[1].loginId, securityPin: actors[1].securityPin } });
    const loggedIn = await loginResponse.json(); assert.equal(loginResponse.status(), 200); assert.equal(loggedIn.data.role, 'USER');
    const deletion = await context.request.delete(`${endpoint}?id=${deletedResult.id}`, { headers: { Authorization: `Bearer ${loggedIn.data.token}` } });
    assert.equal(deletion.status(), 200);
    const [conflict] = await Promise.all([
      page.waitForResponse(value => value.url() === endpoint && value.request().method() === 'POST'),
      pending(page).getByRole('button', { name: 'Retry saved dose', exact: true }).click(),
    ]);
    assert.equal(conflict.status(), 409); assert.equal((await conflict.json()).code, 'DOSE_CHANGED');
    await editor(page).getByRole('alert').filter({ hasText: 'The saved dose needs review because the record changed or was removed.' }).waitFor();
    await pending(page).getByRole('button', { name: 'Review care log', exact: true }).click();
    await page.waitForURL(`**/${family.slug}/full-log?babyId=${babies[0].id}`);
    await page.goto(`${base}/${family.slug}/log-entry?babyId=${babies[0].id}`, { waitUntil: 'networkidle' }); await open(page);
    await waitPending(page); page.once('dialog', dialog => dialog.accept());
    await pending(page).getByRole('button', { name: 'Dismiss saved dose', exact: true }).click(); await waitClosed(editor(page));
    assert.equal(await saved(), null); assert.equal((await rows(deleted)).length, 0);
    assert.equal(await db.externalImportRecord.count({ where: { familyId: family.id, sourceRecordId: deletedResult.request.requestId } }), 1);
    check('Other USER deletes the committed dose; retry returns an actionable conflict, and reviewed dismissal clears only local recovery while preserving the receipt and deletion');

    const quota = await medicine('storage unavailable'); await open(page, quota);
    await page.evaluate(() => {
      window.__doseOriginalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) { if (key.startsWith('medicineDosePendingV1:')) throw new DOMException('Synthetic quota', 'QuotaExceededError'); return window.__doseOriginalSetItem.call(this, key, value); };
    });
    const beforeQuota = requests.length; await pressSave(page);
    await editor(page).getByRole('alert').filter({ hasText: 'This browser could not keep the dose request.' }).waitFor();
    assert.equal(requests.length, beforeQuota); assert.equal(await editor(page).getByLabel('Dose', { exact: true }).inputValue(), '2.5');
    await page.evaluate(() => { Storage.prototype.setItem = window.__doseOriginalSetItem; });
    await editor(page).getByRole('button', { name: 'Check saved dose again', exact: true }).click();
    await confirm(page); assert.equal((await rows(quota)).length, 1);
    check('Unavailable local storage blocks every POST and retains editable inputs; explicit storage recheck permits a single later save');

    const locks = await medicine('locks unavailable'); await open(page, locks);
    await page.evaluate(() => { Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }); });
    const beforeLocks = requests.length; await pressSave(page);
    await editor(page).getByRole('alert').filter({ hasText: 'This browser could not coordinate the saved dose.' }).waitFor();
    assert.equal(requests.length, beforeLocks); assert.equal(await editor(page).getByLabel('Dose', { exact: true }).inputValue(), '2.5');
    await page.evaluate(() => { delete navigator.locks; });
    await editor(page).getByRole('button', { name: 'Check saved dose again', exact: true }).click(); await confirm(page);
    check('Unavailable Web Locks block dispatch without losing the draft; restoring coordination enables an explicit save');

    const timed = await medicine('timeout'); await open(page, timed);
    let releaseTimeout, timeoutEntered = false;
    const timeoutGate = new Promise(resolve => { releaseTimeout = resolve; });
    const timeoutHandler = async route => {
      if (route.request().method() !== 'POST') return route.continue();
      timeoutEntered = true; await timeoutGate; await route.abort('failed').catch(() => {});
    };
    await page.route(endpoint, timeoutHandler); await pressSave(page); await until(() => timeoutEntered, 'held dose request');
    await editor(page).getByRole('alert').filter({ hasText: timeoutMessage }).waitFor({ timeout: 25_000 });
    const timedSaved = await waitPending(page); assert.equal((await rows(timed)).length, 0);
    releaseTimeout(); await page.unroute(endpoint, timeoutHandler); await confirm(page, timedSaved);
    check('A genuinely stalled POST releases the UI within its 20-second deadline and keeps the first request for an explicit one-row retry');

    // The global fetch wrapper can wait on a shared refresh before returning a
    // Response. The dose deadline must include this wait, not just fetch itself.
    const refreshing = await medicine('refresh timeout'); await open(page, refreshing);
    let releaseRefresh, refreshEntered = false;
    const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
    const refreshHandler = async route => {
      const response = await route.fetch(); assert.equal(response.status(), 200);
      refreshEntered = true; await refreshGate; await route.fulfill({ response }).catch(() => {});
    };
    const unauthorized = route => route.request().method() === 'POST'
      ? route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Synthetic expired access token' }) }) : route.continue();
    // Restore the original actor's real refresh cookie after the independent
    // deletion actor login above. This does not inject or replace any JWT.
    const refreshLogin = await context.request.post(`${base}/api/auth`, { data: { familySlug: family.slug, loginId: actors[0].loginId, securityPin: actors[0].securityPin } });
    assert.equal(refreshLogin.status(), 200);
    await page.route(`${base}/api/auth/refresh-token`, refreshHandler); await page.route(endpoint, unauthorized); await pressSave(page);
    await until(() => refreshEntered, 'real authentication refresh held');
    await editor(page).getByRole('alert').filter({ hasText: timeoutMessage }).waitFor({ timeout: 25_000 });
    const refreshSaved = await waitPending(page); assert.equal((await rows(refreshing)).length, 0);
    const refreshed = page.waitForResponse(value => new URL(value.url()).pathname === '/api/auth/refresh-token');
    let lateRefreshPosts = 0;
    const observeLateRefresh = route => {
      if (route.request().method() === 'POST') lateRefreshPosts++;
      return route.continue();
    };
    await page.unroute(endpoint, unauthorized); await page.route(endpoint, observeLateRefresh); releaseRefresh();
    const refreshedResponse = await refreshed; assert.equal(refreshedResponse.status(), 200); await refreshedResponse.finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(lateRefreshPosts, 0, 'Late auth refresh must not dispatch the timed-out original dose');
    assert.equal((await rows(refreshing)).length, 0, 'Recovery still needs an explicit caregiver retry');
    await page.unroute(endpoint, observeLateRefresh);
    await page.unroute(`${base}/api/auth/refresh-token`, refreshHandler);
    await confirm(page, refreshSaved); assert.equal((await rows(refreshing)).length, 1);
    check('The 20-second dose deadline also bounds a real authentication refresh; its late completion cannot submit the aborted request or change its owner');

    const child = await medicine('child response'); await open(page, child, 'Synthetic Alpha held response');
    const heldChild = await holdSuccess(page); await pressSave(page); await heldChild.wait(); const childSaved = await saved();
    await closeDose(page); await closeTracker(page); await select(page, babies[1]);
    await open(page, child, 'Synthetic Beta deliberate administration');
    await heldChild.release();
    assert.equal(await editor(page).getByLabel('Notes (optional)', { exact: true }).inputValue(), 'Synthetic Beta deliberate administration');
    assert.equal(await isClosed(editor(page)), false); assert.equal(await saved(page, babies[1]), null);
    const betaDose = await confirm(page); assert.equal(betaDose.babyId, babies[1].id);
    await closeTracker(page); await select(page, babies[0]); await open(page);
    assert.deepEqual(await waitPending(page), childSaved); await confirm(page, childSaved);
    const childRows = await rows(child); assert.equal(childRows.length, 2);
    assert.deepEqual(childRows.map(row => row.babyId).sort(), babies.map(baby => baby.id).sort());
    check('A late Alpha response cannot close or replace the new Beta draft; each child keeps only its deliberate administration and Alpha recovers its original request');

    const actor = await medicine('actor response'); await open(page, actor, 'Synthetic caregiver Alpha held response');
    const heldActor = await holdSuccess(page); await pressSave(page); await heldActor.wait(); const actorSaved = await saved();
    await closeDose(page); await closeTracker(page);
    await page.getByRole('button', { name: 'Logout', exact: true }).click(); await login(page, actors[1], false); await select(page, babies[0]);
    await open(page, actor, 'Synthetic caregiver Beta deliberate administration'); await heldActor.release();
    assert.equal(await editor(page).getByLabel('Notes (optional)', { exact: true }).inputValue(), 'Synthetic caregiver Beta deliberate administration');
    assert.equal(await saved(page, babies[0], actors[1]), null); assert.equal((await confirm(page)).caretakerId, actors[1].id);
    await closeTracker(page); await page.getByRole('button', { name: 'Logout', exact: true }).click();
    await login(page, actors[0], false); await select(page, babies[0]); await open(page);
    assert.deepEqual(await waitPending(page), actorSaved); await confirm(page, actorSaved);
    assert.deepEqual((await rows(actor)).map(row => row.caretakerId).sort(), actors.map(actor => actor.id).sort());
    check('Ordinary caregiver logout/login isolates pending requests; a late old response cannot acknowledge the next caregiver form or change recorded attribution');

    const competing = await medicine('competing tabs');
    const tab = track(await context.newPage()); await tab.goto(`${base}/${family.slug}/log-entry`, { waitUntil: 'networkidle' }); await select(tab, babies[0]);
    await open(page, competing, 'Synthetic first tab intent'); await open(tab, competing, 'Synthetic second tab intent');
    const heldWinner = await holdSuccess(page); const unlock = await holdLock(page);
    const beforeRace = requests.length;
    await pressSave(page); await pressSave(tab); await queuedLocks(page, 2); await unlock(); await heldWinner.wait();
    await waitPending(tab); assert.equal(requests.length, beforeRace + 1, 'The losing fresh claim must adopt the existing request before posting');
    assert.equal((await rows(competing)).length, 1); await heldWinner.release(); await waitClosed(editor(page));
    await until(async () => await saved(tab) === null, 'winning acknowledgement clears only its saved request');
    await editor(tab).getByRole('button', { name: 'Cancel', exact: true }).click(); await waitClosed(editor(tab));
    check('Two actual tabs queued behind one real Web Lock preserve the winning frozen request and dispatch only one dose; adoption never echoes a stale snapshot');

    const removed = await medicine('dismissed retry'); await open(page, removed);
    const abort = route => route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue();
    await page.route(endpoint, abort); await pressSave(page); await waitPending(page); await page.unroute(endpoint, abort);
    await open(tab); await waitPending(tab);
    const unlockRemoval = await holdLock(page); const beforeRemovedRetry = requests.length;
    page.once('dialog', dialog => dialog.accept());
    await pending(page).getByRole('button', { name: 'Dismiss saved dose', exact: true }).click();
    await pending(tab).getByRole('button', { name: 'Retry saved dose', exact: true }).click();
    await queuedLocks(page, 2); await unlockRemoval(); await waitClosed(editor(page));
    await editor(tab).getByRole('button', { name: 'Save', exact: true }).waitFor();
    assert.equal(requests.length, beforeRemovedRetry); assert.equal(await saved(tab), null); assert.equal((await rows(removed)).length, 0);
    await editor(tab).getByRole('button', { name: 'Cancel', exact: true }).click(); await waitClosed(editor(tab)); await tab.close();
    check('Real lock-queued dismissal followed by a stale retry sends no POST and never recreates the request another tab explicitly removed');

    const unreadable = await medicine('unreadable acknowledgement'); await open(page, unreadable);
    const heldUnreadable = await holdSuccess(page); await pressSave(page); await heldUnreadable.wait();
    const unreadableSaved = await saved();
    await page.evaluate(() => {
      window.__doseOriginalGetItem = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) { if (key.startsWith('medicineDosePendingV1:')) throw new Error('Synthetic storage read failure'); return window.__doseOriginalGetItem.call(this, key); };
    });
    await heldUnreadable.release();
    await editor(page).getByRole('alert').filter({ hasText: 'This browser could not keep the dose request.' }).waitFor();
    assert.equal(await isClosed(editor(page)), false); assert.equal((await rows(unreadable)).length, 1);
    assert.equal(await pending(page).getByRole('button', { name: 'Retry saved dose', exact: true }).isDisabled(), true);
    await page.evaluate(() => { Storage.prototype.getItem = window.__doseOriginalGetItem; });
    await editor(page).getByRole('button', { name: 'Check saved dose again', exact: true }).click();
    assert.deepEqual(await waitPending(page), unreadableSaved);
    await page.setViewportSize({ width: 412, height: 915 });
    assert.equal(await editor(page).evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
    if (reportDir) {
      const screenshot = path.join(reportDir, 'medicine-dose-recovery-mobile.png');
      await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
    }
    assert.equal((await confirm(page, unreadableSaved)).id, heldUnreadable.row().id); assert.equal((await rows(unreadable)).length, 1);
    check('Unreadable storage after server success retains a blocked in-memory summary; explicit reread and retry acknowledge one row, and the recovery controls fit a 412px viewport');

    assert.deepEqual(errors, [], 'Dose recovery browser JavaScript errors');
    assert.equal(checks.length, 15);
    report.status = 'PASS'; persist(); return checks;
  } catch (error) {
    report.status = 'FAIL'; report.error = error.message; report.pageErrors = errors;
    if (activePage && !activePage.isClosed()) {
      report.visibleText = await activePage.locator('body').innerText().catch(() => 'Unavailable');
      if (reportDir) await activePage.screenshot({ path: path.join(reportDir, 'medicine-dose-recovery-failure.png') }).catch(() => {});
    }
    persist(); throw error;
  } finally {
    if (context) {
      for (const target of context.pages()) await target.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
      await context.close();
    }
    await db.medicineLog.deleteMany({ where: { familyId: family.id } });
    await db.externalImportRecord.deleteMany({ where: { familyId: family.id } });
    await db.medicine.deleteMany({ where: { familyId: family.id } });
    await db.settings.deleteMany({ where: { familyId: family.id } });
    await db.baby.deleteMany({ where: { familyId: family.id } });
    await db.caretaker.deleteMany({ where: { familyId: family.id } });
    await db.family.deleteMany({ where: { id: family.id } });
    report.cleanup = { profileClosed: true, fixtureFamilyRemoved: await db.family.count({ where: { id: family.id } }) === 0 };
    persist();
  }
}
