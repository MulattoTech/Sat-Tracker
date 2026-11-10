// Real ordinary-caregiver UI, authentication and disposable canonical writes.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright';
import jwt from 'jsonwebtoken';

const uncertain = 'The care action was not confirmed. Its original details are kept. Retry the saved action or review the care log.';
const changed = 'This saved care action changed or was removed. Review the care log before dismissing the saved action.';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function bounded(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]); }
  finally { clearTimeout(timer); }
}

// Own the actual restarted process and use the executable that the canonical
// browser runner already launched (CI may install only chromium-headless-shell).
async function launchProfile(profile, executable) {
  assert.equal(path.basename(profile), 'quick-care-browser-profile');
  assert.match(path.basename(path.dirname(profile)), /^(babytracker-browser-synthetic|sat-quick-care-browser)-/);
  assert.equal(typeof executable, 'string'); assert.ok(path.isAbsolute(executable));
  const process = spawn(executable, ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = deferred(), closed = deferred(), ready = deferred();
  let endpoint, launchError, browser, output = '';
  process.once('exit', exited.resolve); process.once('close', closed.resolve);
  process.once('error', error => { launchError = error; ready.resolve(); });
  const capture = data => { output = (output + data).slice(-6000); const match = output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/);
    if (match) { endpoint = match[1]; ready.resolve(); } };
  process.stdout.on('data', capture); process.stderr.on('data', capture);
  const stopped = () => process.exitCode !== null || process.signalCode !== null;
  const close = async () => {
    if (browser && !stopped()) {
      await bounded(browser.newBrowserCDPSession().then(session => session.send('Browser.close')), 3000, 'Quick-care browser graceful close').catch(() => {});
      await bounded(exited.promise, 3000, 'Quick-care browser exit').catch(() => {});
    }
    if (!stopped() && process.pid) { process.kill('SIGTERM'); await bounded(exited.promise, 3000, 'Quick-care browser termination').catch(() => {}); }
    if (!stopped() && process.pid) { process.kill('SIGKILL'); await bounded(exited.promise, 5000, 'Quick-care browser forced exit'); }
    assert.ok(stopped() || launchError, 'Owned persistent browser exit must be verified');
    await bounded(browser?.close() || Promise.resolve(), 3000, 'Quick-care browser connection close').catch(() => {});
    for (const stream of process.stdio || []) stream?.destroy?.();
    await bounded(closed.promise, 3000, 'Quick-care browser pipe closure');
  };
  try {
    await bounded(Promise.race([ready.promise, exited.promise]), 15_000, 'Quick-care browser readiness');
    if (launchError || !endpoint) throw launchError || new Error(`Owned browser did not expose its endpoint: ${output}`);
    browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
    const context = browser.contexts()[0]; assert.ok(context);
    return { context, pid: process.pid, close };
  } catch (error) { await close(); throw error; }
}

export async function verifyNurseryQuickCare({ base, db, secret, context, scratch, browserExecutable, onCheck, onEvidence }) {
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  const family = await db.family.create({ data: { slug: `synthetic-quick-${randomUUID().slice(0, 8)}`, name: 'Synthetic Quick Care Recovery', setupStage: 3 } });
  const [caregiver, peer] = await Promise.all(['01', '02'].map((loginId, index) => db.caretaker.create({ data: {
    familyId: family.id, name: `Synthetic Quick Caregiver ${index + 1}`, loginId, securityPin: `83027${index}`,
    role: 'USER', type: 'parent', lastSeenVersion: '1.6.7',
  } })));
  await db.settings.create({ data: { familyId: family.id, familyName: family.name, authType: 'CARETAKER' } });
  const food = await db.food.create({ data: { familyId: family.id, name: 'Synthetic Recovery Oatmeal' } });
  const children = [];
  const child = async label => { const baby = await db.baby.create({ data: { familyId: family.id, firstName: `Synthetic Quick ${label}`,
    lastName: 'Acceptance', birthDate: new Date('2026-01-01T00:00:00Z') } }); children.push(baby); return baby; };
  const sibling = await child('Sibling');
  const login = async (actor, client = fetch) => {
    const response = await client(`${base}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ familySlug: family.slug, loginId: actor.loginId, securityPin: actor.securityPin }), signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.data.role, 'USER');
    assert.equal(jwt.verify(body.data.token, secret).id, actor.id); return body.data.token;
  };
  const token = await login(caregiver), peerToken = await login(peer);
  const checks = [], errors = [], releases = new Set();
  const record = name => { checks.push(name); onCheck?.(name); console.log(`Quick care passed: ${name}`); };
  const key = (kind, scope) => `nurseryQuickCareIntentV1:${kind}:${scope}`;
  const card = (page, kind) => page.locator('.nursery-card').filter({ has: page.getByRole('heading', { name: kind === 'diaper' ? 'Diaper' : 'Food', exact: true }) });
  const rows = (kind, babyId) => (kind === 'diaper' ? db.diaperLog : db.foodLog).findMany({ where: { babyId }, orderBy: { createdAt: 'asc' } });
  const response = (page, endpoint, method) => {
    const pending = page.waitForResponse(value => new URL(value.url()).pathname === endpoint && value.request().method() === method);
    void pending.catch(() => {}); return pending;
  };
  async function setCards(page) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click(); const drawer = page.locator('.nursery-drawer');
    await drawer.getByRole('button', { name: 'Cards', exact: true }).click();
    const row = drawer.locator('.nursery-trow').filter({ has: page.locator('.tn').filter({ hasText: /^Food$/ }) });
    if ((await row.locator('.nursery-tstate').innerText()).trim() === 'OFF') await row.locator('button').click();
    await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  }
  async function select(page, baby) {
    const button = page.getByRole('button', { name: 'Switch Baby', exact: true });
    if ((await button.innerText()).trim() !== baby.firstName) {
      await button.click(); await page.getByRole('option', { name: baby.firstName, exact: true }).click();
    }
  }
  async function initialize(owned, baby) {
    await owned.addInitScript(({ token, family, baby, caretakerId }) => {
      if (!localStorage.getItem('authToken')) {
        localStorage.setItem('authToken', token); localStorage.setItem('caretakerId', caretakerId); localStorage.setItem('isAdmin', 'false');
        localStorage.setItem('selectedFamily', JSON.stringify(family)); localStorage.setItem(`selectedBaby_${family.id}`, JSON.stringify(baby));
      }
      localStorage.setItem('unlockTime', String(Date.now()));
    }, { token, family, baby, caretakerId: caregiver.id });
  }
  async function fixture(label, options = {}) {
    const baby = await child(String(checks.length + 1)), now = Math.floor(Date.now() / 60_000) * 60_000;
    const owned = await context.browser().newContext({ viewport: options.phone ? { width: 412, height: 915 } : { width: 1440, height: 1000 },
      timezoneId: 'UTC', serviceWorkers: 'block', reducedMotion: 'reduce' });
    await initialize(owned, baby); const page = await owned.newPage();
    page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(30_000); page.on('pageerror', error => errors.push(`${label}: ${error.message}`));
    if (!options.realClock) await page.clock.install({ time: new Date(now) });
    await page.goto(`${base}/${family.slug}/nursery-mode`, { waitUntil: 'networkidle' }); await setCards(page); await select(page, baby);
    const scope = JSON.stringify([family.id, `caretaker:${caregiver.id}`, baby.id]);
    return { page, baby, now, owned, scope, card: kind => card(page, kind), rows: kind => rows(kind, baby.id),
      saved: kind => page.evaluate(key => { const value = localStorage.getItem(key); return value === null ? null : JSON.parse(value); }, key(kind, scope)) };
  }
  async function run(name, action, options) {
    const f = await fixture(name, options);
    try { await action(f); record(name); }
    catch (error) { await f.page.screenshot({ path: 'test-results/nursery-quick-care-failure.png', fullPage: true }).catch(() => {}); throw new Error(`${name}: ${error.message}`, { cause: error }); }
    finally {
      for (const release of releases) release(); releases.clear();
      await bounded(f.owned.unrouteAll({ behavior: 'ignoreErrors' }), 4000, 'Quick-care route cleanup');
      await bounded(f.owned.close(), 5000, 'Quick-care context cleanup');
    }
  }
  async function perform(page, kind, target = card(page, kind)) {
    if (kind === 'diaper') await target.getByRole('button', { name: 'Wet', exact: true }).click();
    else { await target.getByRole('button', { name: 'Log Food', exact: true }).click();
      await target.getByRole('button', { name: food.name, exact: true }).click(); }
  }
  async function drop(f, kind, status) {
    const done = deferred(), observed = {}; let intercepted = false, fault;
    const handler = async route => {
      if (intercepted || route.request().method() !== 'POST') return route.continue(); intercepted = true;
      try {
        observed.payload = route.request().postDataJSON();
        if (status) await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ success: false }) });
        else {
          const saved = await route.fetch(); assert.equal(saved.status(), 200); observed.response = await saved.json(); observed.rows = await f.rows(kind);
          assert.equal(observed.rows.length, 1); await route.abort('failed');
        }
      } catch (error) { fault = error; await route.abort().catch(() => {}); }
      finally { done.resolve(); }
    };
    await f.page.route(`**/api/${kind}-log`, handler); await perform(f.page, kind);
    await bounded(done.promise, 15_000, 'Quick-care response interception'); if (fault) throw fault;
    await f.card(kind).getByText(uncertain, { exact: true }).waitFor();
    await f.page.unroute(`**/api/${kind}-log`, handler);
    return observed;
  }
  async function retry(f, kind, expected = 200) {
    const pending = response(f.page, `/api/${kind}-log`, 'POST');
    await f.card(kind).getByRole('button', { name: 'Retry saved care action', exact: true }).click();
    const result = await pending; assert.equal(result.status(), expected); const body = await result.json();
    if (expected === 200) await f.page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
    return { payload: result.request().postDataJSON(), body };
  }

  for (const kind of ['diaper', 'food']) {
    await run(`Successful ${kind} quick care retains conditional Undo and explicit distinct actions`, async f => {
      const pending = response(f.page, `/api/${kind}-log`, 'POST'); await perform(f.page, kind); const first = await pending;
      assert.equal(first.status(), 200); const body = await first.json(); assert.equal(body.replayed, false);
      await f.page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
      assert.equal((await f.rows(kind)).length, 1); assert.equal(await f.saved(kind), null);
      assert.equal(body.undo.scope, f.scope); assert.equal(body.undo.records[0].id, body.data.id);
      if (kind === 'food') await f.card(kind).getByRole('button', { name: 'Skip', exact: true }).click();
      const next = response(f.page, `/api/${kind}-log`, 'POST'); await perform(f.page, kind); const later = await next;
      assert.equal(later.status(), 200); assert.notEqual(later.request().postDataJSON().requestId, first.request().postDataJSON().requestId);
      assert.equal((await f.rows(kind)).length, 2, 'A deliberate second action remains distinct');
    });
    await run(`Lost ${kind} success response retries the exact original action once after two minutes`, async f => {
      const original = await drop(f, kind), saved = await f.saved(kind); assert.ok(saved);
      assert.equal(saved.time, original.payload.time); assert.equal(saved.requestId, original.payload.requestId);
      assert.equal(await f.card(kind).getByRole('button', { name: kind === 'diaper' ? 'Wet' : 'Log Food', exact: true }).count(), 0);
      assert.equal(await f.page.getByRole('button', { name: 'Undo', exact: true }).count(), 0);
      await f.page.clock.fastForward(120_000); const repeated = await retry(f, kind);
      assert.deepEqual(repeated.payload, original.payload); assert.equal(repeated.body.replayed, true);
      assert.deepEqual(repeated.body.undo, original.response.undo); assert.deepEqual(await f.rows(kind), original.rows);
      assert.equal(await f.saved(kind), null);
      if (kind === 'food') {
        const enjoyed = response(f.page, '/api/food-log', 'PUT'); await f.card(kind).getByRole('button', { name: 'Loved', exact: true }).click();
        const result = await enjoyed; assert.equal(result.status(), 200); assert.deepEqual(result.request().postDataJSON().nurseryUndo, original.response.undo);
        assert.equal((await f.rows(kind))[0].enjoyment, 'LOVED');
      }
      onEvidence?.({ name: `${kind} lost response`, original, repeated, rows: await f.rows(kind) });
    }, { phone: true });
    await run(`Rejected ${kind} delivery survives refresh with its first time and UUID`, async f => {
      const first = await drop(f, kind, 500), saved = await f.saved(kind); assert.equal((await f.rows(kind)).length, 0);
      await f.page.clock.fastForward(120_000); await f.page.reload({ waitUntil: 'networkidle' });
      await f.card(kind).getByRole('button', { name: 'Retry saved care action', exact: true }).waitFor();
      assert.equal(await f.card(kind).evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'Saved recovery controls fit their card after reload');
      // Scroll only the activity scroller; scrolling every ancestor can move
      // the fixed Nursery stage and hide the very layout being verified.
      await f.card(kind).evaluate(element => {
        const scroller = element.closest('.nursery-actscroll');
        scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 30;
      });
      await f.page.screenshot({ path: `test-results/nursery-quick-care-${kind}-cards.png`, fullPage: true });
      assert.deepEqual(await f.saved(kind), saved); const repeated = await retry(f, kind);
      assert.deepEqual(repeated.payload, first.payload); assert.equal(repeated.body.replayed, false); assert.equal((await f.rows(kind)).length, 1);
    }, { phone: true });
    for (const operation of ['correction', 'deletion']) await run(`A peer ${operation} after lost ${kind} confirmation requires review without replacement or fresh Undo`, async f => {
      const first = await drop(f, kind), saved = await f.saved(kind), id = first.response.data.id;
      const result = await fetch(`${base}/api/${kind}-log?id=${encodeURIComponent(id)}`, {
        method: operation === 'correction' ? 'PUT' : 'DELETE', headers: { Authorization: `Bearer ${peerToken}`, 'Content-Type': 'application/json' },
        ...(operation === 'correction' ? { body: JSON.stringify({ notes: 'Peer verified this care event' }) } : {}), signal: AbortSignal.timeout(20_000),
      }); assert.equal(result.status, 200); await result.body?.cancel(); const winner = await f.rows(kind);
      const repeated = await retry(f, kind, 409); assert.equal(repeated.body.undo, undefined);
      await f.card(kind).getByText(changed, { exact: true }).waitFor(); assert.deepEqual(await f.saved(kind), saved);
      assert.deepEqual(await f.rows(kind), winner); assert.equal(await f.page.getByRole('button', { name: 'Undo', exact: true }).count(), 0);
      assert.equal(await f.card(kind).getByRole('button', { name: 'Dismiss saved care action', exact: true }).isDisabled(), true);
      const popup = f.owned.waitForEvent('page'); await f.card(kind).getByRole('button', { name: 'Review care log', exact: true }).click();
      const review = await popup; await review.close();
      await f.card(kind).getByRole('button', { name: 'Dismiss saved care action', exact: true }).click();
      await f.card(kind).getByRole('button', { name: kind === 'diaper' ? 'Wet' : 'Log Food', exact: true }).waitFor();
      assert.equal(await f.saved(kind), null); assert.deepEqual(await f.rows(kind), winner);
    });
  }

  await run('A delayed diaper confirmation cannot alter a different child or remove its original recoverable action', async f => {
    const reached = deferred(), release = deferred(); releases.add(release.resolve); let original;
    const handler = async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const result = await route.fetch(); assert.equal(result.status(), 200); original = await result.json(); reached.resolve(); await release.promise;
      await route.fulfill({ response: result }).catch(() => {});
    };
    await f.page.route('**/api/diaper-log', handler); await perform(f.page, 'diaper'); await bounded(reached.promise, 15_000, 'Held diaper save');
    const saved = await f.saved('diaper'); await select(f.page, sibling); const completed = response(f.page, '/api/diaper-log', 'POST'); release.resolve();
    await (await completed).finished(); await f.page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    assert.equal(await f.page.getByRole('button', { name: 'Undo', exact: true }).count(), 0); assert.equal((await rows('diaper', sibling.id)).length, 0);
    assert.deepEqual(await f.saved('diaper'), saved); await f.page.unroute('**/api/diaper-log', handler); await select(f.page, f.baby);
    const replay = await retry(f, 'diaper'); assert.equal(replay.body.data.id, original.data.id); assert.equal((await f.rows('diaper')).length, 1);
  });

  await run('Blocked browser persistence sends no diaper request and keeps the first action for a later explicit retry', async f => {
    await f.page.clock.setFixedTime(new Date(f.now));
    let posts = 0; f.page.on('request', request => { if (new URL(request.url()).pathname === '/api/diaper-log' && request.method() === 'POST') posts++; });
    await f.page.evaluate(() => { const original = Storage.prototype.setItem; window.quickCareBlocked = true;
      Storage.prototype.setItem = function (key, value) { if (window.quickCareBlocked && key.startsWith('nurseryQuickCareIntentV1:')) throw new DOMException('Blocked synthetic storage', 'QuotaExceededError'); return original.call(this, key, value); }; });
    await perform(f.page, 'diaper'); await f.card('diaper').getByText('This browser could not save the care action. Keep this page open and check browser storage. No request was sent on this attempt.', { exact: true }).waitFor();
    const firstTime = new Date(f.now).toISOString(); assert.equal(posts, 0); assert.equal((await f.rows('diaper')).length, 0);
    await f.page.clock.setFixedTime(new Date(f.now + 120_000)); await f.page.evaluate(() => { window.quickCareBlocked = false; });
    const saved = await retry(f, 'diaper'); assert.equal(saved.payload.time, firstTime); assert.equal(posts, 1); assert.equal((await f.rows('diaper')).length, 1);
  });

  await run('Unreadable saved food state stays blocked after a successful catalog refresh until explicit reload', async f => {
    await drop(f, 'food'); const saved = await f.saved('food');
    await f.page.addInitScript(() => { const original = Storage.prototype.getItem; window.quickCareReadBlocked = true;
      Storage.prototype.getItem = function (key) { if (window.quickCareReadBlocked && key.startsWith('nurseryQuickCareIntentV1:food:')) throw new DOMException('Blocked synthetic storage', 'SecurityError'); return original.call(this, key); }; });
    await f.page.reload({ waitUntil: 'networkidle' });
    await f.card('food').getByText('This browser could not read its saved care action. Keep this page open and check browser storage before logging again.', { exact: true }).waitFor();
    assert.equal(await f.card('food').getByRole('button', { name: 'Log Food', exact: true }).count(), 0);
    await f.page.evaluate(() => { window.quickCareReadBlocked = false; window.dispatchEvent(new Event('focus')); });
    assert.equal(await f.card('food').getByRole('button', { name: 'Log Food', exact: true }).count(), 0);
    await f.card('food').getByRole('button', { name: 'Reload saved action', exact: true }).click();
    assert.deepEqual(await f.saved('food'), saved); const repeated = await retry(f, 'food'); assert.equal(repeated.body.replayed, true);
  });

  await run('Unavailable Web Locks retain the original food action without delivery', async f => {
    await f.page.evaluate(() => { window.quickCareOriginalLocks = navigator.locks; Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }); });
    await perform(f.page, 'food');
    await f.card('food').getByText('This browser cannot safely coordinate saved care actions. Keep this page open and use a browser with Web Locks support before saving.', { exact: true }).waitFor();
    assert.equal((await f.rows('food')).length, 0); assert.equal(await f.saved('food'), null);
    await f.page.evaluate(() => { Object.defineProperty(navigator, 'locks', { configurable: true, value: window.quickCareOriginalLocks }); });
    assert.equal((await retry(f, 'food')).body.replayed, false);
  });

  await run('A real authentication refresh changing caregiver cannot dispatch the original diaper as that caregiver', async f => {
    const cookieLogin = await f.owned.request.post(`${base}/api/auth`, { data: {
      familySlug: family.slug, loginId: peer.loginId, securityPin: peer.securityPin,
    } }); assert.equal(cookieLogin.status(), 200);
    let first = true;
    const handler = route => {
      if (route.request().method() !== 'POST' || !first) return route.continue(); first = false;
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ success: false }) });
    };
    await f.page.route('**/api/diaper-log', handler);
    const denied = f.page.waitForResponse(value => new URL(value.url()).pathname === '/api/diaper-log' && value.status() === 409);
    await perform(f.page, 'diaper'); const result = await denied; assert.equal((await result.json()).code, 'NURSERY_UNDO_SCOPE_CHANGED');
    const saved = await f.saved('diaper'); assert.ok(saved); assert.equal(saved.scope, f.scope);
    assert.equal((await f.rows('diaper')).length, 0); assert.equal(await f.page.getByRole('button', { name: 'Undo', exact: true }).count(), 0);
    const currentActor = await f.page.evaluate(() => JSON.parse(atob(localStorage.getItem('authToken').split('.')[1])).id); assert.equal(currentActor, peer.id);
    await f.page.unroute('**/api/diaper-log', handler);
    const originalLogin = await f.owned.request.post(`${base}/api/auth`, { data: { familySlug: family.slug, loginId: caregiver.loginId, securityPin: caregiver.securityPin } });
    const originalToken = (await originalLogin.json()).data.token;
    await f.page.evaluate(token => { localStorage.setItem('authToken', token); window.dispatchEvent(new StorageEvent('storage', { key: 'authToken' })); }, originalToken);
    await f.card('diaper').getByRole('button', { name: 'Retry saved care action', exact: true }).waitFor();
    const confirmed = await retry(f, 'diaper'); assert.equal(confirmed.body.data.caretakerId, caregiver.id); assert.equal((await f.rows('diaper')).length, 1);
  });

  await run('The real twenty-second deadline includes held authentication refresh and prevents its late POST', async f => {
    const loggedIn = await f.owned.request.post(`${base}/api/auth`, { data: {
      familySlug: family.slug, loginId: caregiver.loginId, securityPin: caregiver.securityPin,
    } }); assert.equal(loggedIn.status(), 200);
    const entered = deferred(), release = deferred(); releases.add(release.resolve);
    const refresh = async route => { const result = await route.fetch(); assert.equal(result.status(), 200); entered.resolve();
      await release.promise; await route.fulfill({ response: result }).catch(() => {}); };
    let firstPayload;
    const unauthorized = route => { if (route.request().method() !== 'POST') return route.continue();
      firstPayload = route.request().postDataJSON(); return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ success: false }) }); };
    await f.page.route('**/api/auth/refresh-token', refresh); await f.page.route('**/api/diaper-log', unauthorized);
    const started = Date.now(); await perform(f.page, 'diaper'); await bounded(entered.promise, 12_000, 'Actual auth refresh arrival');
    await f.card('diaper').getByText(uncertain, { exact: true }).waitFor({ timeout: 25_000 });
    const elapsed = Date.now() - started, saved = await f.saved('diaper'); assert.ok(elapsed >= 19_000 && elapsed < 27_000, `Actual timeout elapsed ${elapsed}ms`);
    assert.equal((await f.rows('diaper')).length, 0); assert.equal(await f.card('diaper').getByRole('button', { name: 'Retry saved care action', exact: true }).isEnabled(), true);
    let latePosts = 0; const observe = route => { if (route.request().method() === 'POST') latePosts++; return route.continue(); };
    await f.page.unroute('**/api/diaper-log', unauthorized); await f.page.route('**/api/diaper-log', observe);
    const refreshed = response(f.page, '/api/auth/refresh-token', 'POST'); release.resolve(); await (await refreshed).finished();
    await f.page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    assert.equal(latePosts, 0); assert.equal((await f.rows('diaper')).length, 0); assert.deepEqual(await f.saved('diaper'), saved);
    await f.page.unroute('**/api/auth/refresh-token', refresh); await f.page.unroute('**/api/diaper-log', observe);
    const repeated = await retry(f, 'diaper'); assert.deepEqual(repeated.payload, firstPayload); assert.equal((await f.rows('diaper')).length, 1);
    onEvidence?.({ name: 'Outer authentication deadline', elapsedMs: elapsed, firstPayload, saved, latePosts });
  }, { realClock: true });

  for (const kind of ['diaper', 'food']) await run(`A real lock-queued ${kind} dismissal prevents another tab's stale retry from recreating the action`, async f => {
    await drop(f, kind, 500); const saved = await f.saved(kind), tab = await f.owned.newPage();
    tab.setDefaultTimeout(15_000); await tab.goto(`${base}/${family.slug}/nursery-mode`, { waitUntil: 'networkidle' }); await select(tab, f.baby);
    await card(tab, kind).getByRole('button', { name: 'Retry saved care action', exact: true }).waitFor();
    // Review is an explicit caregiver action. Close its own popup before
    // queuing the comparison operations on the two original tabs.
    const popup = f.owned.waitForEvent('page'); await f.card(kind).getByRole('button', { name: 'Review care log', exact: true }).click(); await (await popup).close();
    await f.page.evaluate(key => {
      window.quickCareLockRelease = null;
      window.quickCareHeldLock = navigator.locks.request(key, () => new Promise(resolve => { window.quickCareLockRelease = resolve; }));
    }, key(kind, f.scope));
    await f.page.waitForFunction(() => typeof window.quickCareLockRelease === 'function');
    let posts = 0; const observe = request => { if (new URL(request.url()).pathname === `/api/${kind}-log` && request.method() === 'POST') posts++; };
    f.page.on('request', observe); tab.on('request', observe);
    await f.card(kind).getByRole('button', { name: 'Dismiss saved care action', exact: true }).click();
    await card(tab, kind).getByRole('button', { name: 'Retry saved care action', exact: true }).click();
    await f.page.waitForFunction(async key => (await navigator.locks.query()).pending.filter(lock => lock.name === key).length >= 2, key(kind, f.scope), { timeout: 1500 });
    await f.page.evaluate(() => window.quickCareLockRelease()); await f.page.evaluate(() => window.quickCareHeldLock);
    await card(tab, kind).getByRole('button', { name: 'Reload saved action', exact: true }).waitFor();
    assert.equal(await f.saved(kind), null); assert.equal(posts, 0); assert.equal((await f.rows(kind)).length, 0);
    assert.equal(saved.time.length, 24); await tab.close();
  });

  await run('A late success in one tab cannot clear a newer diaper action saved by the other tab', async f => {
    const entered = deferred(), release = deferred(); releases.add(release.resolve); let first;
    const hold = async route => { if (route.request().method() !== 'POST') return route.continue();
      const result = await route.fetch(); assert.equal(result.status(), 200); first = await result.json(); entered.resolve();
      await release.promise; await route.fulfill({ response: result }).catch(() => {}); };
    await f.page.route('**/api/diaper-log', hold); await perform(f.page, 'diaper'); await bounded(entered.promise, 12_000, 'Original diaper commit');
    const original = await f.saved('diaper'), tab = await f.owned.newPage(); tab.setDefaultTimeout(15_000);
    await tab.goto(`${base}/${family.slug}/nursery-mode`, { waitUntil: 'networkidle' }); await select(tab, f.baby);
    const confirmed = response(tab, '/api/diaper-log', 'POST'); await card(tab, 'diaper').getByRole('button', { name: 'Retry saved care action', exact: true }).click();
    assert.equal((await confirmed).status(), 200); await card(tab, 'diaper').getByRole('button', { name: 'Wet', exact: true }).waitFor();
    const reject = route => route.request().method() === 'POST'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false }) }) : route.continue();
    await tab.route('**/api/diaper-log', reject); await perform(tab, 'diaper'); await card(tab, 'diaper').getByText(uncertain, { exact: true }).waitFor();
    const newer = await f.saved('diaper'); assert.notEqual(newer.requestId, original.requestId);
    const delivered = response(f.page, '/api/diaper-log', 'POST'); release.resolve(); await (await delivered).finished();
    await f.page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    assert.deepEqual(await f.saved('diaper'), newer); assert.equal((await f.rows('diaper')).length, 1); assert.equal((await f.rows('diaper'))[0].id, first.data.id);
    assert.equal(await f.page.getByRole('button', { name: 'Undo', exact: true }).count(), 0);
    await tab.close();
  });

  await run('Phone Big Tiles keep both frozen quick-care actions and configured timezone through lost-response retry', async f => {
    // Verify actual provider refresh after installing the instance override:
    // page.clock's Intl wrapper does not share its instances' prototype.
    const detected = f.page.waitForEvent('console', message => message.text().startsWith('Detected timezone: America/Los_Angeles,'));
    await f.page.evaluate(() => {
      const original = Intl.DateTimeFormat;
      const decorate = instance => { const resolved = instance.resolvedOptions.bind(instance);
        instance.resolvedOptions = () => ({ ...resolved(), timeZone: 'America/Los_Angeles' }); return instance; };
      Intl.DateTimeFormat = new Proxy(original, { apply: (target, thisArg, args) => decorate(Reflect.apply(target, thisArg, args)),
        construct: (target, args) => decorate(Reflect.construct(target, args)) });
      window.dispatchEvent(new Event('focus'));
    }); await detected;
    await f.page.getByRole('button', { name: 'Settings', exact: true }).click();
    await f.page.locator('.nursery-drawer').getByRole('button', { name: 'Big Tiles', exact: true }).click();
    await f.page.locator('.nursery-drawer').getByRole('button', { name: 'Close', exact: true }).click();
    for (const kind of ['diaper', 'food']) {
      const title = kind === 'diaper' ? 'Diaper' : 'Food';
      await f.page.locator('.nursery-tile').filter({ has: f.page.locator('.tlabel').filter({ hasText: new RegExp(`^${title}$`) }) }).locator('.tmain').click();
      const dialog = f.page.getByRole('dialog', { name: title, exact: true }); let first = true;
      const lost = async route => { if (!first || route.request().method() !== 'POST') return route.continue(); first = false;
        const result = await route.fetch(); assert.equal(result.status(), 200); await route.abort('failed'); };
      await f.page.route(`**/api/${kind}-log`, lost);
      await dialog.getByRole('button', { name: kind === 'diaper' ? 'Wet' : food.name, exact: true }).click();
      await dialog.getByText(uncertain, { exact: true }).waitFor(); const saved = await f.saved(kind);
      const expected = new Date(saved.time).toLocaleString('en', { timeZone: 'America/Los_Angeles' });
      await dialog.getByText(`Saved care action · ${kind === 'diaper' ? 'Wet' : food.name} · ${expected}`, { exact: true }).waitFor();
      assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
      await f.page.screenshot({ path: 'test-results/nursery-quick-care-mobile.png', fullPage: true });
      const sent = response(f.page, `/api/${kind}-log`, 'POST'); await dialog.getByRole('button', { name: 'Retry saved care action', exact: true }).click();
      assert.equal((await sent).status(), 200); assert.equal((await f.rows(kind)).length, 1);
      await f.page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
      if (kind === 'food') await dialog.getByRole('button', { name: 'Loved', exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    }
  }, { phone: true });

  {
    const label = 'Both original quick-care actions survive a complete owned browser process restart without automatic delivery';
    const baby = await child('Restart'), profile = path.join(scratch, 'quick-care-browser-profile');
    const scope = JSON.stringify([family.id, `caretaker:${caregiver.id}`, baby.id]); let owned;
    try {
      owned = await launchProfile(profile, browserExecutable); const originalPid = owned.pid; await initialize(owned.context, baby);
      let page = await owned.context.newPage(); page.setDefaultTimeout(15_000); await page.goto(`${base}/${family.slug}/nursery-mode`, { waitUntil: 'networkidle' });
      await setCards(page); await select(page, baby);
      const frozen = {}, bodies = {};
      for (const kind of ['diaper', 'food']) {
        const handler = route => { if (route.request().method() !== 'POST') return route.continue(); bodies[kind] = route.request().postDataJSON();
          return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false }) }); };
        await page.route(`**/api/${kind}-log`, handler); await perform(page, kind); await card(page, kind).getByText(uncertain, { exact: true }).waitFor();
        frozen[kind] = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key(kind, scope)); assert.ok(frozen[kind]);
        assert.equal((await rows(kind, baby.id)).length, 0);
      }
      await owned.close(); owned = null;
      owned = await launchProfile(profile, browserExecutable); assert.notEqual(owned.pid, originalPid); await initialize(owned.context, baby);
      page = await owned.context.newPage(); page.setDefaultTimeout(15_000); await page.goto(`${base}/${family.slug}/nursery-mode`, { waitUntil: 'networkidle' });
      for (const kind of ['diaper', 'food']) {
        await card(page, kind).getByRole('button', { name: 'Retry saved care action', exact: true }).waitFor();
        assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key(kind, scope)), frozen[kind]);
        assert.equal((await rows(kind, baby.id)).length, 0, 'Restart cannot automatically send pending care');
        const pending = response(page, `/api/${kind}-log`, 'POST'); await card(page, kind).getByRole('button', { name: 'Retry saved care action', exact: true }).click();
        const result = await pending; assert.equal(result.status(), 200); assert.deepEqual(result.request().postDataJSON(), bodies[kind]);
        await page.waitForFunction(key => localStorage.getItem(key) === null, key(kind, scope)); assert.equal((await rows(kind, baby.id)).length, 1);
      }
      onEvidence?.({ name: label, originalPid, restartedPid: owned.pid, frozen, bodies }); record(label);
    } finally { if (owned) await owned.close(); }
  }

  assert.deepEqual(errors, [], 'Quick-care browser JavaScript errors');
  assert.equal(checks.length, 21);
  return checks;
}
