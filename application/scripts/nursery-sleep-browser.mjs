// Real ordinary-caregiver controls, authentication and canonical SQLite writes.
// The caller owns the disposable local application and its synthetic database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import jwt from 'jsonwebtoken';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function bounded(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]); }
  finally { clearTimeout(timer); }
}
const isSleep = request => new URL(request.url()).pathname === '/api/sleep-log';
const isActiveLookup = request => isSleep(request) && request.method() === 'GET' && new URL(request.url()).searchParams.get('activeOnly') === 'true';
const sleepCard = page => page.locator('.nursery-card').filter({ has: page.getByRole('heading', { name: 'Sleep', exact: true }) });

// Own the process explicitly so restart evidence includes verified shutdown,
// not just copying browser storage into another context.
async function launchProfile(profile, browserExecutable) {
  assert.equal(path.basename(profile), 'sleep-recovery-browser-profile');
  assert.match(path.basename(path.dirname(profile)), /^(babytracker-browser-synthetic|sat-sleep-browser)-/);
  assert.ok(typeof browserExecutable === 'string' && path.isAbsolute(browserExecutable) && existsSync(browserExecutable),
    'Owned browser executable is unavailable for the Sleep recovery restart');
  const child = spawn(browserExecutable, [
    '--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { env: { ...process.env, TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = deferred(), closed = deferred(), ready = deferred();
  let endpoint = '', launchError, output = '', browser;
  child.once('exit', exited.resolve); child.once('close', closed.resolve);
  child.once('error', error => { launchError = error; ready.resolve(); });
  const capture = chunk => { output = (output + chunk).slice(-6000); const match = output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/); if (match) { endpoint = match[1]; ready.resolve(); } };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  const stopped = () => child.exitCode !== null || child.signalCode !== null;
  const close = async () => {
    try {
      if (browser && !stopped()) {
        await bounded(browser.newBrowserCDPSession().then(session => session.send('Browser.close')), 3000, 'Persistent browser graceful close').catch(() => {});
        await bounded(exited.promise, 3000, 'Persistent browser exit').catch(() => {});
      }
      if (!stopped() && child.pid) { child.kill('SIGTERM'); await bounded(exited.promise, 3000, 'Persistent browser termination').catch(() => {}); }
      if (!stopped() && child.pid) { child.kill('SIGKILL'); await bounded(exited.promise, 5000, 'Persistent browser forced exit'); }
      assert.ok(stopped() || launchError, 'Owned persistent browser exit must be verified');
      await bounded(browser?.close() || Promise.resolve(), 3000, 'Persistent browser connection close').catch(() => {});
      for (const stream of child.stdio || []) stream?.destroy?.();
      await bounded(closed.promise, 3000, 'Persistent browser pipe closure');
    } finally { for (const stream of child.stdio || []) stream?.destroy?.(); if (!stopped()) child.unref(); }
  };
  try {
    await bounded(Promise.race([ready.promise, exited.promise]), 15_000, 'Persistent browser readiness');
    if (launchError || !endpoint) throw launchError || new Error(`Owned persistent browser did not expose a local endpoint: ${output}`);
    browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
    const context = browser.contexts()[0]; assert.ok(context);
    return { context, pid: child.pid, close };
  } catch (error) { await close(); throw error; }
}

export async function verifyNurserySleepRecovery({ base, db, secret, context, scratch, browserExecutable }) {
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  const family = await db.family.create({ data: { slug: `synthetic-sleep-${randomUUID().slice(0, 8)}`, name: 'Synthetic Sleep Recovery', setupStage: 3 } });
  const caregiver = await db.caretaker.create({ data: { familyId: family.id, loginId: '01', name: 'Synthetic Ordinary Sleep Caregiver',
    role: 'USER', type: 'parent', securityPin: '830271', lastSeenVersion: '1.6.7' } });
  const peer = await db.caretaker.create({ data: { familyId: family.id, loginId: '02', name: 'Synthetic Ordinary Sleep Peer',
    role: 'USER', type: 'parent', securityPin: '830272', lastSeenVersion: '1.6.7' } });
  await db.settings.create({ data: { familyId: family.id, familyName: family.name, authType: 'CARETAKER',
    nurseryModeSettings: JSON.stringify({ global: { layout: 'cards' } }) } });
  async function login(person) {
    const response = await fetch(`${base}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginId: person.loginId, securityPin: person.securityPin, familySlug: family.slug }), signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.success, true); assert.equal(result.data.role, 'USER');
    const decoded = jwt.verify(result.data.token, secret); assert.equal(decoded.id, person.id); assert.equal(decoded.familyId, family.id); return result.data.token;
  }
  const token = await login(caregiver), peerToken = await login(peer);
  const checks = [], errors = [], owned = [], releases = [];
  let persistent;
  const babyRecord = label => db.baby.create({ data: { familyId: family.id, firstName: `Synthetic Sleep ${label}`, lastName: 'Acceptance', birthDate: new Date('2026-01-01T00:00:00Z') } });
  const seedSleep = (baby, now, extra = {}) => db.sleepLog.create({ data: { familyId: family.id, babyId: baby.id, caretakerId: caregiver.id,
    startTime: new Date(now - 3_600_000), type: 'NAP', location: 'Crib', ...extra } });
  const scopeFor = (baby, person = caregiver) => JSON.stringify([family.id, `caretaker:${person.id}`, baby.id]);
  const keyFor = baby => `nurserySleepIntentV1:${scopeFor(baby)}`;
  const rows = baby => db.sleepLog.findMany({ where: { babyId: baby.id }, orderBy: { startTime: 'asc' } });
  const api = async (method, id, body, auth = peerToken) => {
    const response = await fetch(`${base}/api/sleep-log${id ? '?id=' + id : ''}`, { method,
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    return { status: response.status, ...await response.json() };
  };
  async function initialize(target, baby) {
    await target.addInitScript(({ token, family, baby, caregiverId }) => {
      if (!localStorage.getItem('authToken')) {
        localStorage.setItem('authToken', token); localStorage.setItem('caretakerId', caregiverId); localStorage.setItem('isAdmin', 'false');
        localStorage.setItem('selectedFamily', JSON.stringify(family)); localStorage.setItem(`selectedBaby_${family.id}`, JSON.stringify(baby));
      }
      localStorage.setItem('unlockTime', String(Date.now()));
    }, { token, family, baby, caregiverId: caregiver.id });
  }
  const preparePage = async (target, now) => {
    const page = await target.newPage(); await page.setViewportSize({ width: 412, height: 915 });
    page.setDefaultTimeout(12_000); page.setDefaultNavigationTimeout(30_000); page.on('pageerror', error => errors.push(error.message));
    await page.clock.setFixedTime(new Date(now)); return page;
  };
  const choose = async (page, baby) => {
    const switcher = page.getByRole('button', { name: 'Switch Baby', exact: true }); await switcher.waitFor();
    if ((await switcher.innerText()).trim() !== baby.firstName && await switcher.getAttribute('aria-haspopup') === 'listbox') {
      await switcher.click(); await page.getByRole('option', { name: baby.firstName, exact: true }).click();
    }
  };
  const layout = async (page, name) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('.nursery-drawer').getByRole('button', { name, exact: true }).click();
    await page.locator('.nursery-drawer').getByRole('button', { name: 'Close', exact: true }).click();
  };
  async function fixture(label, seed = false) {
    const baby = await babyRecord(label), now = Math.floor(Date.now() / 60_000) * 60_000;
    const session = seed ? await seedSleep(baby, now) : null;
    const target = await context.browser().newContext({ viewport: { width: 412, height: 915 }, timezoneId: 'UTC', serviceWorkers: 'block' });
    owned.push(target); await initialize(target, baby); const page = await preparePage(target, now);
    const load = async (waitUntil = 'networkidle') => {
      await page.goto(`${base}/${family.slug}/nursery-mode`, { waitUntil }); await layout(page, 'Cards'); await choose(page, baby); await sleepCard(page).waitFor();
    };
    const response = method => page.waitForResponse(res => isSleep(res.request()) && res.request().method() === method);
    return { baby, now, session, page, target, load, response, card: () => sleepCard(page),
      read: () => page.evaluate(key => JSON.parse(localStorage.getItem(key) || 'null'), keyFor(baby)) };
  }
  const clickStart = async f => { await f.card().getByRole('button', { name: 'Start Sleep', exact: true }).click(); await f.card().getByRole('button', { name: 'Crib', exact: true }).click(); };
  const retry = f => f.card().getByRole('button', { name: 'Retry saved sleep action', exact: true });
  const reload = f => f.card().getByRole('button', { name: 'Reload sleep state', exact: true });
  const noTimerChanges = async f => { assert.equal(await f.card().getByRole('button', { name: 'Start Sleep', exact: true }).count(), 0); assert.equal(await f.card().getByRole('button', { name: 'Wake Up', exact: true }).count(), 0); };
  const rejectWrite = bodies => async route => {
    if (!isSleep(route.request()) || route.request().method() === 'GET') return route.continue();
    bodies.push(route.request().postDataJSON()); return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Synthetic rejected sleep action' }) });
  };
  async function scenario(name, run) {
    console.log(`Sleep workflow: ${name}`);
    try { await run(); checks.push(name); }
    finally {
      releases.splice(0).forEach(release => release());
      for (const target of owned.splice(0)) { await bounded(target.unrouteAll({ behavior: 'ignoreErrors' }), 3000, 'Sleep route cleanup'); await bounded(target.close(), 5000, 'Sleep context close'); }
    }
  }
  try {
    await scenario('Failed initial sleep lookup and ambiguous active rows block Start/Wake until explicit review', async () => {
      const f = await fixture('Lookup', true), before = await rows(f.baby);
      const block = route => isActiveLookup(route.request()) ? route.fulfill({ status: 503, json: { success: false } }) : route.continue();
      await f.page.route('**/api/sleep-log*', block); await f.load();
      await f.card().getByRole('alert').filter({ hasText: 'Could not check the current sleep state' }).waitFor(); await noTimerChanges(f);
      assert.deepEqual(await rows(f.baby), before); await f.page.unroute('**/api/sleep-log*', block); await reload(f).click();
      await f.card().getByRole('button', { name: 'Wake Up', exact: true }).waitFor();
      await seedSleep(f.baby, f.now, { location: 'Contact' }); await reload(f).click();
      await f.card().getByRole('alert').filter({ hasText: 'More than one sleep is active' }).waitFor(); await noTimerChanges(f); assert.equal((await rows(f.baby)).length, 2);
    });
    await scenario('A lost Start reply retains its first UUID/time through refresh and exact retry without a second timer', async () => {
      const f = await fixture('Start Retry'), bodies = []; await f.load(); let drop = true;
      await f.page.route('**/api/sleep-log', async route => {
        if (route.request().method() !== 'POST') return route.continue(); bodies.push(route.request().postDataJSON());
        if (!drop) return route.continue(); drop = false;
        const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed');
      });
      await clickStart(f); await retry(f).waitFor(); await f.card().getByRole('alert').filter({ hasText: 'was not confirmed' }).waitFor();
      const intent = await f.read(), saved = await rows(f.baby); assert.equal(saved.length, 1); assert.equal(intent.startTime, saved[0].startTime.toISOString());
      await f.page.clock.setFixedTime(new Date(f.now + 300_000)); await f.page.reload({ waitUntil: 'networkidle' });
      await retry(f).waitFor(); assert.deepEqual(await f.read(), intent); const replay = f.response('POST'); await retry(f).click(); assert.equal((await replay).status(), 200);
      await f.card().getByRole('button', { name: 'Wake Up', exact: true }).waitFor(); assert.deepEqual(bodies[1], bodies[0]);
      assert.deepEqual(await rows(f.baby), saved); assert.equal(await f.read(), null);
    });
    await scenario('A rejected Wake preserves its original endpoint across a complete owned browser process restart', async () => {
      const baby = await babyRecord('Restart'), now = Math.floor(Date.now() / 60_000) * 60_000, session = await seedSleep(baby, now);
      const profile = path.join(scratch, 'sleep-recovery-browser-profile'); persistent = await launchProfile(profile, browserExecutable); const firstPid = persistent.pid;
      await initialize(persistent.context, baby); let page = await preparePage(persistent.context, now); let f = { page, card: () => sleepCard(page) };
      const bodies = [], block = rejectWrite(bodies); await page.route('**/api/sleep-log*', block);
      await page.goto(`${base}/${family.slug}/nursery-mode`, { waitUntil: 'networkidle' }); await layout(page, 'Cards'); await choose(page, baby);
      await f.card().getByRole('button', { name: 'Wake Up', exact: true }).click(); await retry(f).waitFor();
      await f.card().getByRole('alert').filter({ hasText: 'was not confirmed' }).waitFor();
      const intent = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), keyFor(baby)); assert.equal(intent.endTime, new Date(now).toISOString());
      assert.equal((await rows(baby))[0].endTime, null); await persistent.close(); persistent = null;
      persistent = await launchProfile(profile, browserExecutable); assert.notEqual(persistent.pid, firstPid); await initialize(persistent.context, baby);
      page = await preparePage(persistent.context, now + 600_000); f = { page, card: () => sleepCard(page) };
      await page.goto(`${base}/${family.slug}/nursery-mode`, { waitUntil: 'networkidle' }); await retry(f).waitFor();
      assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), keyFor(baby)), intent);
      assert.equal((await rows(baby))[0].endTime, null, 'Reopening never sends a pending Wake automatically');
      const sent = page.waitForRequest(request => isSleep(request) && request.method() === 'PUT'); await retry(f).click(); assert.deepEqual((await sent).postDataJSON(), bodies[0]);
      await f.card().getByRole('button', { name: 'Start Sleep', exact: true }).waitFor(); const saved = await db.sleepLog.findUniqueOrThrow({ where: { id: session.id } });
      assert.equal(saved.endTime.toISOString(), intent.endTime); assert.equal(saved.duration, 60); assert.equal((await rows(baby)).length, 1);
      await persistent.close(); persistent = null;
    });
    await scenario('A lost committed Wake is reviewed as changed and never extended by a later retry or mistaken for missing-row success', async () => {
      const f = await fixture('Wake Lost', true); await f.load(); let drop = true;
      await f.page.route('**/api/sleep-log?*', async route => {
        if (route.request().method() !== 'PUT' || !drop) return route.continue(); drop = false;
        const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed');
      });
      await f.card().getByRole('button', { name: 'Wake Up', exact: true }).click(); await f.card().getByRole('alert').filter({ hasText: 'was not confirmed' }).waitFor();
      const intent = await f.read(), saved = await rows(f.baby); assert.equal(saved[0].endTime.toISOString(), intent.endTime);
      await f.page.clock.setFixedTime(new Date(f.now + 300_000)); const response = f.response('PUT'); await retry(f).click(); assert.equal((await response).status(), 409);
      assert.deepEqual(await rows(f.baby), saved); assert.equal(await retry(f).isDisabled(), true); await reload(f).click();
      await f.card().getByRole('button', { name: 'Dismiss sleep review', exact: true }).waitFor(); assert.deepEqual(await f.read(), intent);
      await f.card().getByRole('button', { name: 'Dismiss sleep review', exact: true }).click(); await f.card().getByRole('button', { name: 'Start Sleep', exact: true }).waitFor();
      assert.equal(await f.read(), null); assert.deepEqual(await rows(f.baby), saved);
    });
    await scenario('Late child-A lookup cannot populate child-B timer or supply child-A mutation identity', async () => {
      const f = await fixture('Stale Lookup A', true), sibling = await babyRecord('Stale Lookup B'), other = await seedSleep(sibling, f.now);
      const held = deferred(), arrived = deferred(); releases.push(held.resolve); let holding = true;
      await f.page.route('**/api/sleep-log?*', async route => {
        if (!holding || !isActiveLookup(route.request()) || new URL(route.request().url()).searchParams.get('babyId') !== f.baby.id) return route.continue();
        const response = await route.fetch(); arrived.resolve(); await held.promise; await route.fulfill({ response });
      });
      await f.load('domcontentloaded'); await bounded(arrived.promise, 10_000, 'Old child lookup');
      await choose(f.page, sibling); await f.card().getByRole('button', { name: 'Wake Up', exact: true }).waitFor();
      holding = false; held.resolve(); await f.page.waitForLoadState('networkidle');
      assert.equal((await f.page.getByRole('button', { name: 'Switch Baby', exact: true }).innerText()).trim(), sibling.firstName);
      const response = f.response('PUT'); await f.card().getByRole('button', { name: 'Wake Up', exact: true }).click(); const sent = await response;
      assert.equal(new URL(sent.url()).searchParams.get('id'), other.id); assert.equal(sent.status(), 200);
      assert.equal((await rows(f.baby))[0].endTime, null); assert.equal((await rows(sibling))[0].duration, 60);
    });
    for (const action of ['start', 'wake']) await scenario(`Revision-bound ${action} Undo preserves a peer caregiver's completed correction`, async () => {
      const f = await fixture(`Undo ${action}`, action === 'wake'); await f.load();
      const saved = f.response(action === 'start' ? 'POST' : 'PUT');
      if (action === 'start') await clickStart(f); else await f.card().getByRole('button', { name: 'Wake Up', exact: true }).click();
      assert.equal((await saved).status(), 200); await f.page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
      const row = (await rows(f.baby))[0]; const corrected = await api('PUT', row.id, {
        startTime: new Date(f.now - 120_000).toISOString(), endTime: new Date(f.now - 60_000).toISOString(), notes: 'Peer verified this completed sleep',
      }); assert.equal(corrected.status, 200); const before = await rows(f.baby);
      const response = f.response(action === 'start' ? 'DELETE' : 'PUT'); await f.page.getByRole('button', { name: 'Undo', exact: true }).click(); assert.equal((await response).status(), 409);
      await f.card().getByText('Sleep undo review', { exact: true }).waitFor(); assert.deepEqual(await rows(f.baby), before); assert.equal(await retry(f).isDisabled(), true);
      await reload(f).click(); await f.card().getByRole('button', { name: 'Dismiss sleep review', exact: true }).waitFor(); assert.deepEqual(await rows(f.baby), before);
    });
    await scenario('A rejected Undo survives its toast and later uses the original confirmed revision', async () => {
      const f = await fixture('Undo Retry', true); await f.load(); await f.page.clock.install({ time: new Date(f.now) });
      const wake = f.response('PUT'); await f.card().getByRole('button', { name: 'Wake Up', exact: true }).click(); assert.equal((await wake).status(), 200);
      const ended = await rows(f.baby), bodies = [], block = rejectWrite(bodies); await f.page.route('**/api/sleep-log*', block);
      await f.page.getByRole('button', { name: 'Undo', exact: true }).click(); await f.card().getByRole('alert').filter({ hasText: 'was not confirmed' }).waitFor();
      const pending = await f.read(); assert.equal(pending.kind, 'undo-wake'); assert.deepEqual(await rows(f.baby), ended);
      await f.page.clock.fastForward(7000); assert.equal(await f.page.getByRole('button', { name: 'Undo', exact: true }).count(), 0);
      await f.page.unroute('**/api/sleep-log*', block); const sent = f.page.waitForRequest(request => isSleep(request) && request.method() === 'PUT');
      await retry(f).click(); assert.deepEqual((await sent).postDataJSON(), bodies[0]); await f.card().getByRole('button', { name: 'Wake Up', exact: true }).waitFor();
      const reopened = await rows(f.baby); assert.equal(reopened.length, 1); assert.equal(reopened[0].endTime, null); assert.equal(reopened[0].duration, null);
      assert.equal(reopened[0].startTime.toISOString(), f.session.startTime.toISOString()); assert.equal(await f.read(), null);
    });
    await scenario('Missing target after an uncertain Wake stays in review until explicit care-log inspection and dismissal', async () => {
      const f = await fixture('Missing Target', true); await f.load(); const block = rejectWrite([]); await f.page.route('**/api/sleep-log*', block);
      await f.card().getByRole('button', { name: 'Wake Up', exact: true }).click(); await f.card().getByRole('alert').filter({ hasText: 'was not confirmed' }).waitFor();
      const pending = await f.read(); assert.equal((await api('DELETE', f.session.id)).status, 200); await f.page.unroute('**/api/sleep-log*', block);
      const response = f.response('PUT'); await retry(f).click(); assert.equal((await response).status(), 404);
      await f.card().getByRole('alert').filter({ hasText: 'The sleep record was not found' }).waitFor(); await noTimerChanges(f); assert.deepEqual(await f.read(), pending);
      await reload(f).click(); const popup = f.target.waitForEvent('page'); await f.card().getByRole('button', { name: 'Review care log', exact: true }).click();
      const careLog = await popup; await careLog.waitForURL(`${base}/${family.slug}/log-entry`); await careLog.close();
      await f.card().getByRole('button', { name: 'Dismiss sleep review', exact: true }).click(); await f.card().getByRole('button', { name: 'Start Sleep', exact: true }).waitFor();
      assert.equal(await f.read(), null); assert.deepEqual(await rows(f.baby), []);
    });
    await scenario('A held Wake completion cannot change the selected sibling timer or its local action summary', async () => {
      const f = await fixture('Late Wake A', true), sibling = await babyRecord('Late Wake B'); await f.load();
      const held = deferred(), arrived = deferred(); releases.push(held.resolve); let holding = true;
      await f.page.route('**/api/sleep-log?*', async route => {
        if (!holding || route.request().method() !== 'PUT') return route.continue();
        const response = await route.fetch(); assert.equal(response.status(), 200); arrived.resolve(); await held.promise; await route.fulfill({ response });
      });
      await f.card().getByRole('button', { name: 'Wake Up', exact: true }).click(); await bounded(arrived.promise, 10_000, 'Held Wake completion');
      await choose(f.page, sibling); await f.card().getByRole('button', { name: 'Start Sleep', exact: true }).waitFor();
      const created = f.response('POST'); await clickStart(f); assert.equal((await created).status(), 200); await f.card().getByRole('button', { name: 'Wake Up', exact: true }).waitFor();
      const siblingBefore = await rows(sibling); holding = false; held.resolve(); await f.page.waitForLoadState('networkidle');
      assert.equal((await f.page.getByRole('button', { name: 'Switch Baby', exact: true }).innerText()).trim(), sibling.firstName);
      await f.card().getByRole('button', { name: 'Wake Up', exact: true }).waitFor(); assert.equal(await f.card().getByText('Sleep logged', { exact: true }).count(), 0);
      assert.deepEqual(await rows(sibling), siblingBefore); assert.equal((await rows(f.baby))[0].duration, 60);
      assert.equal(await f.page.evaluate(key => localStorage.getItem(key), keyFor(f.baby)), null);
    });
    await scenario('Current server authentication rejects a refreshed peer actor and each actor retains only its own sleep review', async () => {
      const f = await fixture('Actor Scope', true); await f.load(); const before = await rows(f.baby);
      const changeAuth = route => route.request().method() === 'PUT'
        ? route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${peerToken}` } }) : route.continue();
      await f.page.route('**/api/sleep-log?*', changeAuth); const rejected = f.response('PUT');
      await f.card().getByRole('button', { name: 'Wake Up', exact: true }).click(); assert.equal((await rejected).status(), 409);
      await f.card().getByRole('alert').filter({ hasText: 'The sleep record changed' }).waitFor(); const pending = await f.read(); assert.deepEqual(await rows(f.baby), before);
      await f.page.unroute('**/api/sleep-log?*', changeAuth);
      const switchActor = async (value, person) => {
        await f.page.evaluate(({ value, id }) => { localStorage.setItem('authToken', value); localStorage.setItem('caretakerId', id); window.dispatchEvent(new Event('focus')); }, { value, id: person.id });
      };
      await switchActor(peerToken, peer); await f.card().getByRole('button', { name: 'Wake Up', exact: true }).waitFor(); assert.equal(await retry(f).count(), 0);
      assert.deepEqual(await f.read(), pending); assert.deepEqual(await rows(f.baby), before);
      await switchActor(token, caregiver); await retry(f).waitFor(); await reload(f).click();
      const response = f.response('PUT'); await retry(f).click(); assert.equal((await response).status(), 200);
      await f.card().getByRole('button', { name: 'Start Sleep', exact: true }).waitFor(); assert.equal((await rows(f.baby))[0].endTime.toISOString(), pending.endTime);
    });
    await scenario('Unreadable saved sleep storage keeps timer mutations blocked even after a successful server lookup', async () => {
      const f = await fixture('Unreadable Storage', true); await f.load(); const bodies = [], block = rejectWrite(bodies);
      await f.page.route('**/api/sleep-log*', block); await f.card().getByRole('button', { name: 'Wake Up', exact: true }).click();
      await f.card().getByRole('alert').filter({ hasText: 'was not confirmed' }).waitFor(); const pending = await f.read(), before = await rows(f.baby);
      await f.page.addInitScript(() => {
        const get = Storage.prototype.getItem; window.__restoreSleepRead = () => { Storage.prototype.getItem = get; };
        Storage.prototype.getItem = function(key) { if (String(key).startsWith('nurserySleepIntentV1:')) throw new DOMException('Synthetic unavailable read'); return get.call(this, key); };
      });
      await f.page.reload({ waitUntil: 'networkidle' }); await f.card().getByRole('alert').filter({ hasText: 'could not read its saved sleep action' }).waitFor();
      await noTimerChanges(f); assert.equal(bodies.length, 1); assert.deepEqual(await rows(f.baby), before);
      await f.page.evaluate(() => window.__restoreSleepRead()); await reload(f).click(); await retry(f).waitFor(); assert.deepEqual(await f.read(), pending);
      assert.equal(bodies.length, 1, 'Reading a saved intent never retries it automatically');
    });
    await scenario('Failed storage writes retain the first Wake in memory and prevent dispatch until durable retry is possible', async () => {
      const f = await fixture('Write Storage', true); await f.load(); let writes = 0;
      f.page.on('request', request => { if (isSleep(request) && request.method() === 'PUT') writes++; });
      await f.page.evaluate(() => {
        const set = Storage.prototype.setItem; window.__restoreSleepWrite = () => { Storage.prototype.setItem = set; };
        Storage.prototype.setItem = function(key, value) { if (String(key).startsWith('nurserySleepIntentV1:')) throw new DOMException('Synthetic full storage'); return set.call(this, key, value); };
      });
      await f.card().getByRole('button', { name: 'Wake Up', exact: true }).click(); await f.card().getByRole('alert').filter({ hasText: 'No request was sent on this attempt' }).waitFor();
      assert.equal(writes, 0); assert.equal(await f.read(), null); await f.card().getByText('Sleep wake review · 1:00:00', { exact: true }).waitFor();
      await f.page.clock.setFixedTime(new Date(f.now + 600_000)); await f.page.evaluate(() => window.__restoreSleepWrite());
      const sent = f.page.waitForRequest(request => isSleep(request) && request.method() === 'PUT'); await retry(f).click();
      assert.equal((await sent).postDataJSON().endTime, new Date(f.now).toISOString()); await f.card().getByRole('button', { name: 'Start Sleep', exact: true }).waitFor();
      assert.equal((await rows(f.baby))[0].duration, 60); assert.equal(writes, 1);
    });
    await scenario('Unavailable or occupied Web Locks block writes and preserve the first action for an exact retry', async () => {
      const f = await fixture('Lock Recovery', true); await f.load(); let writes = 0;
      f.page.on('request', request => { if (isSleep(request) && request.method() === 'PUT') writes++; });
      await f.page.evaluate(() => { window.__sleepLocks = navigator.locks; Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }); });
      await f.card().getByRole('button', { name: 'Wake Up', exact: true }).click(); await f.card().getByRole('alert').filter({ hasText: 'Web Locks support' }).waitFor();
      assert.equal(writes, 0); assert.equal(await f.read(), null);
      await f.page.evaluate(() => Object.defineProperty(navigator, 'locks', { configurable: true, value: window.__sleepLocks }));
      await f.page.evaluate(key => { window.__sleepLockReady = false; void navigator.locks.request(key, () => {
        window.__sleepLockReady = true; return new Promise(resolve => { window.__releaseSleepLock = resolve; });
      }); }, keyFor(f.baby)); await f.page.waitForFunction(() => window.__sleepLockReady);
      await retry(f).click(); await f.card().getByRole('alert').filter({ hasText: 'Another tab is updating the saved sleep action' }).waitFor();
      assert.equal(writes, 0); assert.equal(await f.read(), null); await f.page.evaluate(() => window.__releaseSleepLock());
      await f.page.clock.setFixedTime(new Date(f.now + 600_000)); const sent = f.page.waitForRequest(request => isSleep(request) && request.method() === 'PUT'); await retry(f).click();
      assert.equal((await sent).postDataJSON().endTime, new Date(f.now).toISOString()); await f.card().getByRole('button', { name: 'Start Sleep', exact: true }).waitFor();
      assert.equal(writes, 1); assert.equal((await rows(f.baby))[0].duration, 60);
    });
    await scenario('Competing tabs keep one immutable Start and a late acknowledgement cannot erase a newer Wake review', async () => {
      const f = await fixture('Two Tabs'); await f.load(); const other = await preparePage(f.target, f.now), g = { page: other, card: () => sleepCard(other) };
      await other.goto(`${base}/${family.slug}/nursery-mode`, { waitUntil: 'networkidle' }); await g.card().getByRole('button', { name: 'Start Sleep', exact: true }).waitFor();
      const bodies = [], block = rejectWrite(bodies); await f.target.route('**/api/sleep-log*', block);
      await f.page.evaluate(key => { window.__sleepLockReady = false; void navigator.locks.request(key, () => {
        window.__sleepLockReady = true; return new Promise(resolve => { window.__releaseSleepLock = resolve; });
      }); }, keyFor(f.baby)); await f.page.waitForFunction(() => window.__sleepLockReady);
      await Promise.all([f.card().getByRole('button', { name: 'Start Sleep', exact: true }).click(), g.card().getByRole('button', { name: 'Start Sleep', exact: true }).click()]);
      await Promise.all([f.card().getByRole('button', { name: 'Crib', exact: true }).click(), g.card().getByRole('button', { name: 'Contact', exact: true }).click()]);
      await f.page.evaluate(() => window.__releaseSleepLock()); await retry(f).waitFor(); await retry(g).waitFor(); await reload(f).click(); await reload(g).click();
      assert.equal(bodies.length, 1, 'Only the winning immutable intent may dispatch'); const pending = await f.read(); assert.equal(pending.kind, 'start');
      assert.deepEqual(await other.evaluate(key => JSON.parse(localStorage.getItem(key)), keyFor(f.baby)), pending); assert.deepEqual(await rows(f.baby), []);
      await f.target.unroute('**/api/sleep-log*', block); const held = deferred(), arrived = deferred(); releases.push(held.resolve);
      await f.page.route('**/api/sleep-log', async route => {
        if (route.request().method() !== 'POST') return route.continue(); const response = await route.fetch(); assert.equal(response.status(), 200);
        arrived.resolve(); await held.promise; await route.fulfill({ response });
      });
      await retry(f).click(); await bounded(arrived.promise, 10_000, 'Held first-tab confirmation'); await reload(g).click(); await retry(g).click();
      await g.card().getByRole('button', { name: 'Wake Up', exact: true }).waitFor(); assert.equal(await f.read(), null);
      await other.route('**/api/sleep-log?*', rejectWrite([])); await g.card().getByRole('button', { name: 'Wake Up', exact: true }).click();
      await g.card().getByRole('alert').filter({ hasText: 'was not confirmed' }).waitFor(); const newer = await f.read(); assert.equal(newer.kind, 'wake');
      held.resolve(); await f.page.waitForLoadState('networkidle'); assert.deepEqual(await f.read(), newer);
      await f.card().getByText(/^Sleep wake review/).waitFor(); assert.equal((await rows(f.baby)).length, 1); assert.equal((await rows(f.baby))[0].endTime, null);
    });
    await scenario('A stalled Wake releases controls at its bounded deadline without changing the frozen endpoint or automatically retrying', async () => {
      const f = await fixture('Timeout', true); await f.load(); await f.page.clock.install({ time: new Date(f.now) });
      const held = deferred(), arrived = deferred(), bodies = []; releases.push(held.resolve);
      const stall = async route => {
        if (route.request().method() !== 'PUT') return route.continue(); bodies.push(route.request().postDataJSON()); arrived.resolve(); await held.promise;
        await route.abort('failed').catch(() => {});
      };
      await f.page.route('**/api/sleep-log?*', stall); await f.card().getByRole('button', { name: 'Wake Up', exact: true }).click(); await bounded(arrived.promise, 10_000, 'Stalled Wake arrival');
      const pending = await f.read(); await f.page.clock.runFor(20_100); await f.card().getByRole('alert').filter({ hasText: 'was not confirmed' }).waitFor();
      assert.equal(await retry(f).isDisabled(), false); assert.equal(bodies.length, 1); assert.deepEqual(await f.read(), pending); assert.equal((await rows(f.baby))[0].endTime, null);
      held.resolve(); await f.page.unroute('**/api/sleep-log?*', stall); const sent = f.page.waitForRequest(request => isSleep(request) && request.method() === 'PUT');
      await retry(f).click(); assert.deepEqual((await sent).postDataJSON(), bodies[0]); await f.card().getByRole('button', { name: 'Start Sleep', exact: true }).waitFor();
      assert.equal((await rows(f.baby))[0].duration, 60);
    });
    await scenario('Big Tiles retains recovery controls and renders the first Start in the application timezone without changing its UTC instant', async () => {
      const f = await fixture('Timezone');
      // The test clock wraps Intl with a constructor whose returned formatters
      // have a different prototype. Establish the app zone after clock setup,
      // then observe the real context refresh before expecting Pacific time.
      await f.load();
      const zoneChanged = f.page.waitForEvent('console', message => message.text().startsWith('Detected timezone: America/Los_Angeles'));
      const detected = await f.page.evaluate(() => {
        const original = Intl.DateTimeFormat;
        const configured = formatter => {
          const resolved = formatter.resolvedOptions.bind(formatter);
          Object.defineProperty(formatter, 'resolvedOptions', { value: () => ({ ...resolved(), timeZone: 'America/Los_Angeles' }) });
          return formatter;
        };
        Intl.DateTimeFormat = new Proxy(original, {
          apply: (target, receiver, args) => configured(Reflect.apply(target, receiver, args)),
          construct: (target, args) => configured(Reflect.construct(target, args)),
        });
        window.dispatchEvent(new Event('focus'));
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      });
      assert.equal(detected, 'America/Los_Angeles'); await zoneChanged; await layout(f.page, 'Big Tiles');
      const tile = f.page.locator('.nursery-tile').filter({ has: f.page.locator('.tlabel').filter({ hasText: /^Sleep$/ }) }); await tile.locator('.tmain').click();
      const modal = f.page.getByRole('dialog', { name: 'Sleep', exact: true }), bodies = []; await f.page.route('**/api/sleep-log*', rejectWrite(bodies));
      await modal.getByRole('button', { name: 'Crib', exact: true }).click();
      await modal.getByRole('alert').filter({ hasText: 'was not confirmed' }).waitFor(); const pending = await f.read();
      const expected = new Date(pending.startTime).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
      await modal.getByText(`Sleep start review · ${expected}`, { exact: true }).waitFor(); assert.equal(await modal.isVisible(), true);
      assert.equal(await f.page.evaluate(() => new Date().getTimezoneOffset()), 0); assert.equal(pending.startTime, new Date(f.now).toISOString());
      assert.equal(bodies[0].startTime, pending.startTime); await modal.getByRole('button', { name: 'Retry saved sleep action', exact: true }).waitFor();
      await f.page.screenshot({ path: 'test-results/sleep-review-big-tiles.png', animations: 'disabled' });
    });
    assert.deepEqual(errors, [], 'Sleep workflow browser errors');
    return checks;
  } finally {
    releases.splice(0).forEach(release => release());
    for (const target of owned.splice(0)) { await bounded(target.unrouteAll({ behavior: 'ignoreErrors' }), 3000, 'Sleep route cleanup'); await bounded(target.close(), 5000, 'Sleep context close'); }
    if (persistent) await persistent.close();
  }
}
