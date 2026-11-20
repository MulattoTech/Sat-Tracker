// Real USER sign-ins and protected requests against the runner's disposable app.
// Faults delay or fail actual network responses; authentication success is never mocked.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
};
const bounded = async (promise, label, ms = 15_000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Logout browser timed out: ${label}`)), ms);
  })]); } finally { clearTimeout(timer); }
};
const until = async (condition, label) => {
  const deadline = Date.now() + 15_000;
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error(`Logout browser timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

export async function verifyLogoutLifecycle({ base, db, scratch, reportDir }) {
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(scratch, 'The acceptance runner must own a disposable scratch directory');
  const runId = process.env.SAT_TRACKER_ACCEPTANCE_RUN_ID || randomUUID(), fixtures = [], checks = [], errors = [], captureErrors = [], cleanupErrors = [];
  const report = { runId, startedAt: new Date().toISOString(), syntheticOnly: true,
    authentication: 'Actual PIN UI, POST /api/auth USER logins and real protected API requests',
    scope: 'One document per transition; old-document cancellation is distinguished from same-document generation unit coverage',
    storageCoverage: 'Exact byte preservation only: synthetic scoped care payloads use real product keys; this module does not restore or dispatch those care requests',
    checks, evidence: [], errors, captureErrors, cleanup: { errors: cleanupErrors, fixtureIds: [] } };
  const persist = () => {
    if (!reportDir) return;
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(path.join(reportDir, 'logout-lifecycle-browser-report.json'), JSON.stringify(report, null, 2));
  };
  let server, browser, browserProcess, processExit, activeFixture;
  const documentId = page => page.evaluate(() => window.__logoutLifecycleProbe.documentId);
  const token = page => page.evaluate(() => localStorage.getItem('authToken'));
  const refreshCookie = async context => (await context.cookies(base)).find(cookie => cookie.name === 'refreshToken')?.value ?? null;
  const signOut = page => page.getByRole('region', { name: 'Signing out...', exact: true });
  const loginPanel = page => page.locator('.login-container');
  const independentStatus = async (f, bearer) => {
    const response = await fetch(`${base}/api/medicine-log?babyId=${f.baby.id}`, {
      headers: { Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(15_000),
    });
    await response.arrayBuffer(); return response.status;
  };
  const revokeBearer = async (f, bearer) => {
    // Node fetch has no shared browser cookie jar. Only the access token is revoked.
    const response = await fetch(`${base}/api/auth/logout`, { method: 'POST',
      headers: { Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(15_000) });
    const result = await response.json(); assert.equal(response.status, 200); assert.equal(result.success, true);
    assert.equal(await independentStatus(f, bearer), 401);
  };
  const login = async (f, actor) => {
    const panel = loginPanel(f.page);
    await panel.getByRole('heading', { name: 'Login ID & Security PIN', exact: true }).waitFor();
    const id = panel.getByLabel('Login ID', { exact: true }), pin = panel.getByLabel('Security PIN', { exact: true });
    if (await f.page.evaluate(() => !window.__logoutLifecycleProbe.fontsReleased)) {
      await f.page.waitForFunction(() => window.__logoutLifecycleProbe.fontReads > 0);
    }
    for (let index = 0; index < actor.loginId.length; index++) {
      await panel.getByRole('button', { name: actor.loginId[index], exact: true }).click();
      if (index === 0 && await f.page.evaluate(() => !window.__logoutLifecycleProbe.fontsReleased)) {
        await until(async () => await id.inputValue() === actor.loginId[0], 'first real login ID digit');
        await f.page.evaluate(() => window.__logoutLifecycleProbe.releaseFonts());
        await f.page.waitForFunction(() => document.querySelector('.login-container .login-title')?.style.opacity === '1');
        await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      assert.equal(await id.inputValue(), actor.loginId.slice(0, index + 1));
    }
    for (let index = 0; index < actor.securityPin.length; index++) {
      await panel.getByRole('button', { name: actor.securityPin[index], exact: true }).click();
      assert.equal(await pin.inputValue(), actor.securityPin.slice(0, index + 1));
    }
    const [response] = await Promise.all([
      f.page.waitForResponse(value => new URL(value.url()).pathname === '/api/auth' && value.request().method() === 'POST'),
      panel.getByRole('button', { name: 'Go', exact: true }).click(),
    ]);
    const body = await response.json();
    assert.equal(response.status(), 200); assert.equal(body.success, true);
    assert.equal(body.data.id, actor.id); assert.equal(body.data.role, 'USER');
    await f.page.getByLabel('Select Baby', { exact: true }).waitFor();
    // The selector can render while the initial root-to-log-entry navigation
    // and its second wave of API loads are still running. Fault injection must
    // start after those actual requests finish, not at that early UI marker.
    await f.page.waitForURL(url => url.pathname === `/${f.family.slug}/log-entry`);
    await f.page.waitForLoadState('networkidle');
    await until(() => f.activeApiRequests.size === 0, 'authenticated initial API requests completed');
    f.evidence.loginBoundaries.push({ path: new URL(f.page.url()).pathname,
      activeApiRequests: f.activeApiRequests.size, refreshPosts: f.counts.refresh });
    assert.equal(await independentStatus(f, await token(f.page)), 200);
    f.evidence.realUserLogins++;
  };
  const pendingStorage = f => {
    const scope = JSON.stringify([f.family.id, `caretaker:${f.actors[0].id}`, f.baby.id]);
    const time = new Date().toISOString(), common = { scope, familyId: f.family.id, babyId: f.baby.id };
    return { local: {
      [`nurseryQuickCareIntentV1:diaper:${scope}`]: JSON.stringify({ ...common, version: 1, kind: 'diaper', requestId: randomUUID(), time, type: 'WET' }),
      [`nurserySleepIntentV1:${scope}`]: JSON.stringify({ ...common, kind: 'start', requestId: randomUUID(), requestedAt: time, startTime: time, type: 'NAP', location: 'Crib' }),
      [`medicineDosePendingV1:${scope}`]: JSON.stringify({ version: 1, medicineName: 'Synthetic unsent dose', isSupplement: false,
        request: { requestId: randomUUID(), expectedScope: scope, babyId: f.baby.id, medicineId: `${f.family.id}-unsent-dose`, time, doseAmount: 1, unitAbbr: 'ML', notes: null } }),
      [`nurseryPumpSessionV2:${scope}`]: JSON.stringify({ phase: 'paused', activeSide: 'both', scope, startTime: time,
        sideDuration: { left: 5, right: 5 }, pauseAccumulated: 0, resumeTime: null, elapsed: 5, amountLeft: '1', amountRight: '1' }),
    }, session: {
      [`nurseryBreastfeedStopV1:${scope}`]: JSON.stringify({ ...common, sessionId: `${f.family.id}-unsent-stop`,
        expectedUpdatedAt: time, stoppedAt: time, leftDuration: 5, rightDuration: 0, pauseDuration: 0 }),
    } };
  };
  const assertPending = async f => {
    const unchanged = await f.page.evaluate(saved => Object.entries(saved.local).every(([key, value]) => localStorage.getItem(key) === value)
      && Object.entries(saved.session).every(([key, value]) => sessionStorage.getItem(key) === value), f.pending);
    assert.equal(unchanged, true, 'Logout must preserve exact scoped care recovery records');
    f.evidence.pendingCareStoragePreserved = true;
  };
  const beginScenario = (f, phase) => {
    assert.equal(f.activeApiRequests.size, 0, 'Scenario baseline requires completed authenticated API loads');
    assert.equal(f.counts.auth, 1, 'Scenario baseline follows one real USER login');
    assert.equal(f.counts.logout, 0, 'Bootstrap must not dispatch logout');
    // Root bootstrap may attempt a cookie-only refresh before any login. Keep
    // that lifetime count, then measure controlled requests from this boundary.
    f.scenarioBaseline = { ...f.counts };
    (f.evidence.scenarioBaselines ??= []).push({ phase, activeApiRequests: 0, counts: { ...f.scenarioBaseline } });
  };
  const fixture = async name => {
    const id = `logout-${runId}-${fixtures.length}`;
    const f = { name, id, holds: [], logoutBearers: [], activeApiRequests: new Set(), counts: { auth: 0, refresh: 0, logout: 0 },
      evidence: { name, realUserLogins: 0, loginBoundaries: [], failedRequests: [], documentsRequested: [] } };
    fixtures.push(f); activeFixture = f; report.evidence.push(f.evidence);
    f.family = await db.family.create({ data: { id, slug: id, name: `Synthetic logout ${name}`, setupStage: 3 } });
    report.cleanup.fixtureIds.push(id);
    f.actors = [];
    for (const [index, loginId] of ['01', '02'].entries()) f.actors.push(await db.caretaker.create({ data: {
      id: `${id}-actor-${index}`, familyId: id, loginId, securityPin: index ? '654321' : '123456',
      name: `Synthetic logout ${index ? 'Beta' : 'Alpha'}`, type: 'parent', role: 'USER', lastSeenVersion: '1.6.7',
    } }));
    f.baby = await db.baby.create({ data: { id: `${id}-baby`, familyId: id, firstName: 'Synthetic logout child', lastName: 'Fixture', birthDate: new Date('2026-01-01T00:00:00Z') } });
    await db.settings.create({ data: { familyId: id, familyName: f.family.name, authType: 'CARETAKER' } });
    f.context = await browser.newContext({ serviceWorkers: 'block', timezoneId: 'UTC', viewport: { width: 1440, height: 1100 } });
    await f.context.addInitScript(() => {
      const fonts = document.fonts, nativeReady = fonts.ready;
      let releaseFonts;
      const fontGate = new Promise(resolve => { releaseFonts = resolve; });
      const probe = window.__logoutLifecycleProbe = { documentId: crypto.randomUUID(), fontReads: 0, fontsReleased: false, nativeLogouts: [],
        releaseFonts: () => { probe.fontsReleased = true; releaseFonts(); } };
      Object.defineProperty(fonts, 'ready', { configurable: true, get: () => {
        probe.fontReads++; return nativeReady.then(() => fontGate).then(() => fonts);
      } });
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (...args) => {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        if (typeof url !== 'string' || new URL(url, location.href).pathname !== '/api/auth/logout') return nativeFetch(...args);
        const entry = { signalAborted: false, nativeRejected: false, settled: false };
        probe.nativeLogouts.push(entry);
        args[1]?.signal?.addEventListener('abort', () => { entry.signalAborted = true; }, { once: true });
        return nativeFetch(...args).then(response => { entry.settled = true; entry.status = response.status; return response; }, error => {
          entry.settled = true; entry.nativeRejected = true; entry.errorName = error.name; throw error;
        });
      };
    });
    f.page = await f.context.newPage(); f.page.setDefaultTimeout(15_000); f.page.setDefaultNavigationTimeout(25_000);
    f.page.on('pageerror', error => errors.push({ case: name, message: error.message }));
    f.page.on('requestfinished', request => f.activeApiRequests.delete(request));
    f.page.on('requestfailed', request => {
      f.activeApiRequests.delete(request);
      f.evidence.failedRequests.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText });
    });
    f.page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === base && url.pathname.startsWith('/api/')) f.activeApiRequests.add(request);
      if (request.method() === 'POST') {
        if (url.pathname === '/api/auth') f.counts.auth++;
        if (url.pathname === '/api/auth/refresh-token') f.counts.refresh++;
        if (url.pathname === '/api/auth/logout') { f.counts.logout++; f.logoutBearers.push(request.headers().authorization); }
      }
      if (request.isNavigationRequest() && request.frame() === f.page.mainFrame()) f.evidence.documentsRequested.push({ path: url.pathname, reason: url.searchParams.get('src') });
    });
    await f.page.goto(`${base}/${f.family.slug}`, { waitUntil: 'networkidle' }); await login(f, f.actors[0]);
    f.ownerToken = await token(f.page); f.initialDocument = await documentId(f.page); f.pending = pendingStorage(f);
    await f.page.evaluate(saved => {
      for (const [key, value] of Object.entries(saved.local)) localStorage.setItem(key, value);
      for (const [key, value] of Object.entries(saved.session)) sessionStorage.setItem(key, value);
    }, f.pending);
    beginScenario(f, 'post-authentication');
    return f;
  };
  const abortFailedCapture = async (f, route, stage, error, expectedStatus, actualStatus) => {
    // Playwright fetch errors may include request headers in their call log.
    // Record the stage/status/type, never raw response bodies or error logs.
    const failure = { case: f.name, path: new URL(route.request().url()).pathname, stage,
      errorName: ['Error', 'AssertionError', 'SyntaxError', 'TypeError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error',
      expectedStatus, actualStatus: actualStatus ?? null, observedAt: new Date().toISOString() };
    captureErrors.push(failure); persist();
    try { await route.abort('failed'); failure.requestAborted = true; }
    catch { failure.abortAfterTerminalRequest = true; }
    persist();
    return new Error(`Unexpected ${stage} failure while capturing ${failure.path} (${failure.errorName}; expected ${expectedStatus}, received ${actualStatus ?? 'no response'})`);
  };
  const holdActual = async (f, url, expectedStatus, validate = body => assert.equal(body.success, true)) => {
    const h = { ready: deferred(), release: deferred(), finished: deferred(), evidence: {} };
    f.holds.push(h);
    h.handler = async route => {
      let stage = 'fetch', actualStatus;
      try {
        h.response = await route.fetch(); actualStatus = h.response.status();
        stage = 'body'; h.body = await h.response.json();
        stage = 'status'; assert.equal(h.response.status(), expectedStatus);
        stage = 'body-validation'; validate(h.body);
        h.evidence.status = h.response.status(); h.evidence.bodyValidated = true;
        h.evidence.clearsRefreshCookie = /refreshToken=;.*Max-Age=0/i.test(h.response.headers()['set-cookie'] ?? '');
        h.ready.resolve(); await h.release.promise;
        try { await route.fulfill({ response: h.response }); h.evidence.fulfillReturned = true; }
        catch { h.evidence.fulfillRejectedAfterNavigationOrAbort = true; }
      } catch (error) {
        h.error = await abortFailedCapture(f, route, stage, error, expectedStatus, actualStatus);
        h.ready.reject(h.error);
      }
      finally { h.finished.resolve(); }
    };
    // Retiring this registration does not cancel its captured in-flight route:
    // that response can still be released after navigation/native abort.
    await f.page.route(url, h.handler, { times: 1 }); return h;
  };
  const release = async h => {
    h.release.resolve(); await bounded(h.finished.promise, 'held response terminal');
    if (h.error) throw h.error;
  };
  const triggerProtected = async (f, label) => {
    const url = `/api/medicine-log?babyId=${f.baby.id}&logoutLifecycleProbe=${label}`;
    await f.page.evaluate(url => {
      window.__logoutLifecycleProbe.protected = { settled: false };
      void fetch(url).then(response => response.arrayBuffer().then(() => {
        window.__logoutLifecycleProbe.protected = { settled: true, status: response.status };
      })).catch(error => { window.__logoutLifecycleProbe.protected = { settled: true, errorName: error.name }; });
    }, url);
    return `${base}${url}`;
  };
  const blocked = async f => {
    await signOut(f.page).waitFor(); assert.equal(await loginPanel(f.page).count(), 0, 'Old document must not expose a login form');
    assert.equal(await f.page.getByLabel('Select Baby', { exact: true }).count(), 0, 'Child controls must not remain interactive');
  };
  const manualLogout = f => f.page.getByRole('button', { name: 'Logout', exact: true }).click({ noWaitAfter: true });
  const newLoginDocument = async f => {
    await loginPanel(f.page).getByRole('heading', { name: 'Login ID & Security PIN', exact: true }).waitFor();
    assert.equal(await documentId(f.page) !== f.initialDocument, true, 'Sign-out must complete a full document navigation');
    assert.equal(await token(f.page), null); assert.equal(await refreshCookie(f.context), null);
    await assertPending(f);
  };
  const verifyNewOwner = async (f, before) => {
    assert.equal(await documentId(f.page) === before.document, true, 'An old response must not navigate the new owner');
    assert.equal(await token(f.page) === before.token, true, 'An old response must not clear or replace the new token');
    assert.equal(await refreshCookie(f.context) === before.cookie, true, 'An old response must not clear the new refresh cookie');
    assert.equal(await f.page.evaluate(() => localStorage.getItem('caretakerId')) === f.actors[1].id, true);
    assert.equal(await independentStatus(f, before.token), 200);
    const cookieControl = await f.page.evaluate(async ({ babyId, actorId }) => {
      const response = await fetch('/api/auth/refresh-token', { method: 'POST' });
      const body = await response.json();
      const identityMatches = Boolean(body.data?.token && JSON.parse(atob(body.data.token.split('.')[1])).id === actorId);
      const protectedResponse = body.data?.token ? await fetch(`/api/medicine-log?babyId=${babyId}`, { headers: { Authorization: `Bearer ${body.data.token}` } }) : null;
      await protectedResponse?.arrayBuffer();
      return { refreshStatus: response.status, success: body.success === true, identityMatches, protectedStatus: protectedResponse?.status ?? null };
    }, { babyId: f.baby.id, actorId: f.actors[1].id });
    assert.deepEqual(cookieControl, { refreshStatus: 200, success: true, identityMatches: true, protectedStatus: 200 });
    await assertPending(f); f.evidence.newOwner = { tokenPreserved: true, cookiePreserved: true, documentPreserved: true, ...cookieControl };
  };
  const captureNewOwner = async f => {
    const state = { token: await token(f.page), cookie: await refreshCookie(f.context), document: await documentId(f.page) };
    assert.ok(state.token); assert.ok(state.cookie); return state;
  };
  const finishCase = async (f, description) => {
    assert.equal(f.logoutBearers.every(value => value === `Bearer ${f.ownerToken}`), true, 'Every logout attempt must retain its original owner');
    assert.equal(await independentStatus(f, f.ownerToken), 401, 'Current-owner logout must actually invalidate its original bearer');
    f.evidence.originalBearerInvalidated = true; f.evidence.logoutBearersMatchOriginal = true;
    f.evidence.requestCounts = { ...f.counts }; checks.push(description); persist();
    await bounded(f.context.close(), 'case context cleanup'); f.closed = true;
  };

  try {
    persist();
    server = await chromium.launchServer({ headless: true, executablePath: process.env.BABYTRACKER_TEST_BROWSER_PATH || undefined });
    browserProcess = server.process(); report.cleanup.browserPid = browserProcess.pid;
    processExit = new Promise(resolve => browserProcess.once('exit', (code, signal) => resolve({ code, signal })));
    browser = await chromium.connect(server.wsEndpoint());

    {
      const f = await fixture('manual-automatic-deduplication');
      await f.page.clock.install({ time: new Date() }); await f.page.clock.pauseAt(new Date());
      const failedRefresh = await holdActual(f, `${base}/api/auth/refresh-token`, 401, body => assert.equal(body.success, false));
      const held = await holdActual(f, `${base}/api/auth/logout`, 200);
      await revokeBearer(f, f.ownerToken); await f.context.clearCookies({ name: 'refreshToken' });
      assert.equal(await refreshCookie(f.context), null);
      await triggerProtected(f, 'failed-refresh');
      await bounded(failedRefresh.ready.promise, 'single actual failed refresh captured');
      assert.equal(f.counts.refresh - f.scenarioBaseline.refresh, 1); assert.equal(f.counts.logout, 0);
      await release(failedRefresh);
      await f.page.unroute(`${base}/api/auth/refresh-token`, failedRefresh.handler);
      await until(() => f.page.evaluate(() => window.__logoutLifecycleProbe.protected?.status === 401), 'protected 401 with the browser clock paused');
      assert.equal(f.counts.refresh - f.scenarioBaseline.refresh, 1); assert.equal(f.counts.logout, 0);
      f.evidence.controlledRefreshPosts = f.counts.refresh - f.scenarioBaseline.refresh;
      await manualLogout(f); await bounded(held.ready.promise, 'manual logout committed'); await blocked(f);
      await f.page.clock.runFor(150); assert.equal(f.counts.logout, 1);
      assert.equal(await documentId(f.page) === f.initialDocument, true);
      await f.page.clock.resume(); await release(held); await newLoginDocument(f); await login(f, f.actors[1]);
      await verifyNewOwner(f, await captureNewOwner(f)); assert.equal(f.counts.logout, 1);
      f.evidence.failedRefresh = failedRefresh.evidence; f.evidence.heldLogout = held.evidence;
      f.evidence.automaticTimerWindowAdvancedWhileManualClaimed = true;
      await finishCase(f, 'Manual logout and a queued failed-refresh logout share one POST and one full document transition before a real new USER login');
    }
    {
      const f = await fixture('old-protected-response');
      await revokeBearer(f, f.ownerToken);
      const url = `${base}/api/medicine-log?babyId=${f.baby.id}&logoutLifecycleProbe=old-protected`;
      const held = await holdActual(f, url, 401, body => assert.equal(body.success, false));
      await triggerProtected(f, 'old-protected'); await bounded(held.ready.promise, 'old protected 401 committed');
      await manualLogout(f); await newLoginDocument(f); await login(f, f.actors[1]);
      const owner = await captureNewOwner(f); await release(held); await verifyNewOwner(f, owner);
      assert.equal(f.counts.logout, 1);
      f.evidence.oldProtectedResponse = held.evidence;
      f.evidence.oldRequestCancelledByFullNavigation = f.evidence.failedRequests.some(value => value.path === '/api/medicine-log' && /ABORTED/i.test(value.error ?? ''));
      assert.equal(f.evidence.oldRequestCancelledByFullNavigation, true, 'Record the real old-document cancellation boundary');
      await finishCase(f, 'A held old-document protected 401 is cancelled by full logout navigation and cannot clear or navigate a real replacement USER session');
    }
    {
      const f = await fixture('refresh-drain-and-expiry-ticks');
      // Recreate app interval handlers under the clock only after a real login.
      await f.page.clock.install({ time: new Date() }); await f.page.reload({ waitUntil: 'networkidle' });
      await f.page.getByLabel('Select Baby', { exact: true }).waitFor(); f.initialDocument = await documentId(f.page);
      await until(() => f.activeApiRequests.size === 0, 'authenticated reload API requests completed');
      beginScenario(f, 'after-authenticated-reload');
      const cookie = await refreshCookie(f.context); assert.ok(cookie);
      await revokeBearer(f, f.ownerToken); assert.equal(await refreshCookie(f.context) === cookie, true);
      const refresh = await holdActual(f, `${base}/api/auth/refresh-token`, 200, body => { assert.equal(body.success, true); assert.equal(typeof body.data?.token, 'string'); });
      const logout = await holdActual(f, `${base}/api/auth/logout`, 200);
      await triggerProtected(f, 'held-refresh'); await bounded(refresh.ready.promise, 'real valid-cookie refresh committed');
      const expiry = await f.page.evaluate(() => JSON.parse(atob(localStorage.getItem('authToken').split('.')[1])).exp * 1000);
      await f.page.clock.setSystemTime(new Date(expiry + 1)); await f.page.clock.runFor(2500);
      assert.equal(f.counts.refresh - f.scenarioBaseline.refresh, 1); assert.equal(f.counts.logout, 0);
      f.evidence.controlledRefreshPosts = f.counts.refresh - f.scenarioBaseline.refresh;
      assert.equal(await signOut(f.page).count(), 0); await f.page.getByLabel('Select Baby', { exact: true }).waitFor();
      assert.equal(await token(f.page) === f.ownerToken, true);
      await manualLogout(f); await blocked(f); assert.equal(f.counts.logout, 0, 'Logout must await the already-started refresh');
      await f.page.clock.setSystemTime(new Date()); await release(refresh); await bounded(logout.ready.promise, 'logout after refresh terminal');
      assert.equal(f.counts.logout, 1); assert.equal(await token(f.page) === f.ownerToken, true, 'A claimed logout must prevent refresh token publication');
      await release(logout); await newLoginDocument(f); await login(f, f.actors[1]);
      await verifyNewOwner(f, await captureNewOwner(f)); assert.equal(f.counts.logout, 1);
      f.evidence.clientExpiryCondition = { actualJwtExpiryMs: expiry, controlledClockAfterExpiryMs: 2501, intervalAdvanceMs: 2500, serverClockUnchanged: true };
      f.evidence.heldRefresh = refresh.evidence; f.evidence.heldLogout = logout.evidence;
      f.evidence.noLogoutBeforeManualClaim = true; f.evidence.noLogoutBeforeRefreshTerminal = true; f.evidence.refreshTokenNotRepublished = true;
      await finishCase(f, 'Repeated expired-token checks join one real held refresh; explicit logout drains it before clearing cookies without republishing the old owner');
    }
    {
      const f = await fixture('logout-timeout-new-owner');
      await f.page.clock.install({ time: new Date() });
      const held = await holdActual(f, `${base}/api/auth/logout`, 200);
      await manualLogout(f); await bounded(held.ready.promise, 'held logout committed before timeout'); await blocked(f);
      await f.page.clock.runFor(15_100);
      await signOut(f.page).getByRole('button', { name: 'Return to sign-in', exact: true }).waitFor();
      await signOut(f.page).getByRole('button', { name: 'Retry sign-out', exact: true }).waitFor();
      await f.page.waitForFunction(() => window.__logoutLifecycleProbe.nativeLogouts.some(value => value.signalAborted && value.nativeRejected && value.settled));
      await until(() => f.evidence.failedRequests.some(value => value.path === '/api/auth/logout' && /ABORTED/i.test(value.error ?? '')), 'native logout abort event');
      assert.equal(f.counts.auth, 1); await blocked(f);
      f.evidence.nativeTimeout = await f.page.evaluate(() => window.__logoutLifecycleProbe.nativeLogouts);
      await signOut(f.page).getByRole('button', { name: 'Return to sign-in', exact: true }).click({ noWaitAfter: true });
      await newLoginDocument(f); await login(f, f.actors[1]); const owner = await captureNewOwner(f);
      await release(held); await verifyNewOwner(f, owner); assert.equal(f.counts.logout, 1);
      f.evidence.heldLogout = held.evidence; f.evidence.deadlineAdvanceMs = 15_100;
      await finishCase(f, 'A held real logout reaches its bounded native abort before Return to sign-in, and its late response cannot remove a new USER token or refresh cookie');
    }
    {
      const f = await fixture('explicit-retry-and-navigation-recovery');
      // Use native timers here. New evaluations and locator actions can wait
      // behind pending navigation, so observe the retained document from a
      // callback installed before navigation and consume its reports in Node.
      const navigationUI = { timer: 'native', phaseAllowanceMs: 15_100, observationBudgetMs: 15_000, samples: [] };
      f.evidence.navigationUI = navigationUI;
      let latestSnapshot, lastSignature, snapshotSequence = 0;
      const snapshotWaiters = new Set(), trustedReturn = deferred();
      await f.page.exposeBinding('__recordLogoutNavigationUI', (_, event) => {
        if (event.kind === 'click') {
          navigationUI.click = { ...event, observedAt: new Date().toISOString() };
          trustedReturn.resolve(navigationUI.click); persist(); return;
        }
        latestSnapshot = { ...event, sequence: ++snapshotSequence, observedAt: new Date().toISOString() };
        const signature = JSON.stringify([event.documentId, event.regionCount, event.regionVisible,
          event.loginFormCount, event.childSelectorCount, event.alertTexts, event.buttons]);
        if (signature !== lastSignature) {
          lastSignature = signature; navigationUI.samples.push(latestSnapshot); persist();
        }
        for (const inspect of snapshotWaiters) inspect();
      });
      await f.page.evaluate(() => {
        const report = event => { void window.__recordLogoutNavigationUI(event).catch(() => {}); };
        const visible = node => {
          if (!node) return false;
          const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
            && style.display !== 'none' && Number(style.opacity) > 0;
        };
        const snapshot = () => {
          const regions = [...document.querySelectorAll('section[aria-label="Signing out..."]')], region = regions[0];
          report({ kind: 'snapshot', documentId: window.__logoutLifecycleProbe.documentId, browserTime: Date.now(),
            regionCount: regions.length, regionVisible: visible(region),
            loginFormCount: document.querySelectorAll('.login-container').length,
            childSelectorCount: document.querySelectorAll('[aria-label="Select Baby"]').length,
            alertTexts: [...(region?.querySelectorAll('[role="alert"]') || [])].map(node => node.textContent.trim()),
            viewport: { width: innerWidth, height: innerHeight },
            buttons: [...(region?.querySelectorAll('button') || [])].map(button => {
              const rect = button.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
              const hit = document.elementFromPoint(x, y);
              return { text: button.textContent.trim(), disabled: button.disabled, visible: visible(button),
                center: { x, y }, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                centerHitMatches: Boolean(hit && (hit === button || button.contains(hit))) };
            }) });
        };
        new MutationObserver(snapshot).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
        setInterval(snapshot, 250); snapshot();
        document.addEventListener('click', event => {
          const button = event.target instanceof Element ? event.target.closest('button') : null;
          if (button?.closest('section[aria-label="Signing out..."]') && button.textContent.trim() === 'Return to sign-in') {
            report({ kind: 'click', documentId: window.__logoutLifecycleProbe.documentId, browserTime: Date.now(),
              trusted: event.isTrusted, targetText: button.textContent.trim(), disabled: button.disabled,
              point: { x: event.clientX, y: event.clientY } });
          }
        }, true);
      });
      const waitSnapshot = async (predicate, label, milliseconds = 15_000) => {
        const ready = deferred(), inspect = () => { if (latestSnapshot && predicate(latestSnapshot)) ready.resolve(latestSnapshot); };
        snapshotWaiters.add(inspect); inspect();
        try { return await bounded(ready.promise, label, milliseconds); } finally { snapshotWaiters.delete(inspect); }
      };
      const assertBlockedSnapshot = snapshot => {
        assert.equal(snapshot.documentId, f.initialDocument); assert.equal(snapshot.regionCount, 1);
        assert.equal(snapshot.regionVisible, true); assert.equal(snapshot.loginFormCount, 0); assert.equal(snapshot.childSelectorCount, 0);
      };
      await waitSnapshot(snapshot => snapshot.documentId === f.initialDocument, 'prearmed original-document observer');
      const nav = { ready: deferred(), recovery: deferred(), release: deferred(), finished: deferred(), evidence: {} }; f.holds.push(nav);
      const captureFailure = deferred();
      let navigationCount = 0, responses = 0;
      await f.page.route(`${base}/${f.family.slug}?*`, async route => {
        if (!route.request().isNavigationRequest() || route.request().frame() !== f.page.mainFrame()) return route.continue();
        navigationCount++;
        const destination = new URL(route.request().url());
        const request = { number: navigationCount, path: destination.pathname, reason: destination.searchParams.get('src'), observedAtMs: Date.now() };
        if (navigationCount > 1) { nav.recovery.resolve(request); return route.continue(); }
        nav.evidence.firstRequest = request; nav.startedAt = Date.now(); nav.snapshotFloor = snapshotSequence;
        nav.ready.resolve(); await nav.release.promise;
        try { await route.continue(); nav.evidence.continueReturned = true; }
        catch { nav.evidence.cancelledByReturnNavigation = true; }
        finally { nav.finished.resolve(); }
      });
      await f.page.route(`${base}/api/auth/logout`, async route => {
        let stage = 'fetch', actualStatus;
        try {
          const response = await route.fetch(); actualStatus = response.status();
          stage = 'body'; const body = await response.json();
          stage = 'status'; assert.equal(response.status(), 200);
          stage = 'body-validation'; assert.equal(body.success, true); responses++;
          stage = 'fulfill';
          if (responses === 1) await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Synthetic lost logout confirmation' }) });
          else await route.fulfill({ response });
        } catch (error) {
          captureFailure.reject(await abortFailedCapture(f, route, stage, error, 200, actualStatus));
        }
      });
      await manualLogout(f);
      await Promise.race([signOut(f.page).getByRole('button', { name: 'Retry sign-out', exact: true }).waitFor(), captureFailure.promise]);
      await blocked(f);
      assert.equal(f.counts.logout, 1); assert.equal(await token(f.page) === f.ownerToken, true); await assertPending(f);
      await signOut(f.page).getByRole('button', { name: 'Retry sign-out', exact: true }).click({ noWaitAfter: true });
      await Promise.race([bounded(nav.ready.promise, 'destination navigation held after retry'), captureFailure.promise]);
      const fresh = snapshot => snapshot.sequence > nav.snapshotFloor && snapshot.browserTime > nav.startedAt
        && snapshot.documentId === f.initialDocument;
      const blockedState = await waitSnapshot(fresh, 'fresh blocked original-document observation');
      assertBlockedSnapshot(blockedState); navigationUI.blocked = blockedState; assert.equal(f.counts.logout, 2);
      // Preserve the prior 15.1s phase advance plus 15s observation allowance,
      // now elapsed natively. This does not change the application's 15s timer.
      const watchdogDeadline = nav.startedAt + navigationUI.phaseAllowanceMs + navigationUI.observationBudgetMs;
      const watchdogState = await waitSnapshot(snapshot => fresh(snapshot) && snapshot.sequence > blockedState.sequence
        && snapshot.alertTexts.includes('The sign-in page did not open. Try again.'), 'native navigation watchdog observation', Math.max(0, watchdogDeadline - Date.now()));
      assertBlockedSnapshot(watchdogState); navigationUI.watchdog = watchdogState;
      navigationUI.elapsedToWatchdogMs = Date.now() - nav.startedAt;
      const clickState = await waitSnapshot(snapshot => fresh(snapshot) && snapshot.sequence > watchdogState.sequence,
        'fresh visible recovery control');
      assertBlockedSnapshot(clickState);
      assert.deepEqual(clickState.alertTexts, ['The sign-in page did not open. Try again.']);
      assert.equal(clickState.buttons.filter(button => button.text === 'Retry sign-out').length, 0);
      const buttons = clickState.buttons.filter(button => button.text === 'Return to sign-in');
      assert.equal(buttons.length, 1); assert.equal(clickState.buttons.length, 1); const button = buttons[0];
      assert.equal(button.disabled, false); assert.equal(button.visible, true); assert.equal(button.centerHitMatches, true);
      assert.ok(Number.isFinite(button.center.x) && Number.isFinite(button.center.y)
        && button.center.x > 0 && button.center.x < clickState.viewport.width
        && button.center.y > 0 && button.center.y < clickState.viewport.height);
      assert.equal(navigationCount, 1); navigationUI.beforeClick = clickState; persist();
      await bounded(f.page.mouse.click(button.center.x, button.center.y), 'trusted Return to sign-in pointer action');
      const action = await bounded(trustedReturn.promise, 'original-document trusted Return click');
      assert.equal(action.trusted, true); assert.equal(action.documentId, f.initialDocument);
      assert.equal(action.targetText, 'Return to sign-in'); assert.equal(action.disabled, false);
      const recoveryRequest = await bounded(nav.recovery.promise, 'Return-triggered second main-frame navigation');
      assert.equal(navigationCount, 2); assert.equal(recoveryRequest.number, 2);
      assert.equal(recoveryRequest.path, `/${f.family.slug}`); assert.equal(recoveryRequest.reason, 'logout-user');
      assert.ok(recoveryRequest.observedAtMs >= action.browserTime);
      nav.evidence.recoveryRequest = recoveryRequest;
      await release(nav); await newLoginDocument(f); assert.equal(f.counts.logout, 2, 'Navigation recovery must not send another logout');
      await login(f, f.actors[1]); await verifyNewOwner(f, await captureNewOwner(f));
      assert.equal(navigationCount, 2);
      f.evidence.firstRealLogoutStatus = 200; f.evidence.injectedFirstResponseStatus = 500;
      f.evidence.realLogoutResponses = responses; f.evidence.destinationRequests = navigationCount; f.evidence.navigationRecovery = nav.evidence;
      await finishCase(f, 'Explicit Retry retains the first bearer after a failed confirmation; held-navigation recovery returns to sign-in without resending logout or deleting pending care');
    }
    assert.equal(checks.length, 5); assert.deepEqual(errors, [], 'Logout lifecycle browser JavaScript errors');
    assert.deepEqual(captureErrors, [], 'Logout lifecycle route capture errors');
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.error = { message: error.message, stack: error.stack };
    if (reportDir && activeFixture?.page && !activeFixture.page.isClosed()) {
      try {
        const filename = `logout-lifecycle-failure-${activeFixture.name}.png`;
        await activeFixture.page.screenshot({ path: path.join(reportDir, filename), fullPage: true }); report.screenshot = filename;
      } catch { /* The failing old document may already have been destroyed. */ }
    }
    throw error;
  } finally {
    for (const f of fixtures) {
      f.evidence.requestCounts = { ...f.counts };
      for (const h of f.holds) h.release.resolve();
      if (f.context && !f.closed) try { await bounded(f.context.close(), 'failed case context cleanup', 5000); }
      catch (error) { cleanupErrors.push({ resource: 'owned browser context', case: f.name, message: error.message }); }
    }
    if (browser) try { await bounded(browser.close(), 'browser connection close', 5000); }
    catch (error) { cleanupErrors.push({ resource: 'owned browser connection', message: error.message }); }
    if (server) {
      try { await bounded(server.close(), 'browser server close', 5000); }
      catch { browserProcess?.kill('SIGKILL'); report.cleanup.browserForced = true; }
      try { report.cleanup.browserExit = await bounded(processExit, 'owned browser process exit', 5000); }
      catch (error) { cleanupErrors.push({ resource: 'owned browser process', message: error.message }); }
    }
    for (const f of fixtures) if (f.family) {
      try {
        await db.settings.deleteMany({ where: { familyId: f.family.id } });
        await db.baby.deleteMany({ where: { familyId: f.family.id } });
        await db.caretaker.deleteMany({ where: { familyId: f.family.id } });
        await db.family.delete({ where: { id: f.family.id } });
      } catch (error) { cleanupErrors.push({ resource: 'owned synthetic family', id: f.family.id, message: error.message }); }
    }
    report.cleanup.ownedFamiliesRemoved = await db.family.count({ where: { id: { in: report.cleanup.fixtureIds } } }) === 0;
    if (captureErrors.length || cleanupErrors.length || !report.cleanup.ownedFamiliesRemoved) {
      report.status = 'FAIL'; report.error ??= { message: captureErrors.length ? 'Unexpected browser route capture failure' : 'Owned logout lifecycle cleanup did not complete' };
    }
    report.completedAt = new Date().toISOString(); persist();
  }
  assert.deepEqual(captureErrors, [], 'Logout lifecycle route capture errors');
  assert.deepEqual(cleanupErrors, [], 'Logout lifecycle owned-resource cleanup');
  assert.equal(report.cleanup.ownedFamiliesRemoved, true);
  return checks;
}
