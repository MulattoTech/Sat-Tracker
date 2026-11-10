import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

export async function verifyBreastfeedingRecovery({ base, db, family, caretaker, secret, context }) {
  assert.equal(new URL(base).hostname, '127.0.0.1');
  assert.ok(family.slug.startsWith('synthetic-'));
  const checks = [], errors = [], ownedContexts = [];
  const auth = id => jwt.sign({ id, name: 'Synthetic breastfeeding caregiver', familyId: family.id,
    familySlug: family.slug, role: 'ADMIN', type: 'parent' }, secret, { expiresIn: '3h' });
  const token = auth(caretaker.id);
  const peer = await db.caretaker.create({ data: { familyId: family.id, name: 'Synthetic breastfeeding peer',
    type: 'Parent', role: 'ADMIN', loginId: `bf-${randomUUID().slice(0, 8)}`, securityPin: '867530' } });
  const peerToken = auth(peer.id);
  const rows = babyId => Promise.all([db.activeBreastFeed.findMany({ where: { babyId } }), db.feedLog.findMany({ where: { babyId }, orderBy: { startTime: 'asc' } })]);
  const babyRecord = label => db.baby.create({ data: { familyId: family.id, firstName: `Synthetic BF ${label}`,
    lastName: 'Acceptance', birthDate: new Date('2026-01-01T00:00:00.000Z') } });
  const active = (baby, now, extra = {}) => db.activeBreastFeed.create({ data: {
    familyId: family.id, babyId: baby.id, caretakerId: caretaker.id, activeSide: 'LEFT', firstSide: 'LEFT',
    leftDuration: 0, rightDuration: 0, pauseDuration: 0, isPaused: false,
    sessionStartTime: new Date(now - 60_000), currentSideStartTime: new Date(now - 60_000), ...extra,
  } });
  async function fixture(label, seed, controlledClock = false) {
    const baby = await babyRecord(label), now = Date.now();
    const session = seed ? await active(baby, now, seed === true ? {} : seed(now)) : null;
    const owned = await context.browser().newContext({ viewport: { width: 412, height: 915 }, timezoneId: 'UTC' });
    ownedContexts.push(owned);
    await owned.addInitScript(({ token, family, baby, caretakerId }) => {
      if (!localStorage.getItem('authToken')) localStorage.setItem('authToken', token);
      localStorage.setItem('unlockTime', String(Date.now()));
      localStorage.setItem('caretakerId', caretakerId); localStorage.setItem('isAdmin', 'true');
      localStorage.setItem('selectedFamily', JSON.stringify(family));
      if (!localStorage.getItem(`selectedBaby_${family.id}`)) localStorage.setItem(`selectedBaby_${family.id}`, JSON.stringify(baby));
    }, { token, family, baby, caretakerId: caretaker.id });
    const page = await owned.newPage();
    page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(30_000);
    page.on('pageerror', error => errors.push(error.message));
    if (controlledClock) await page.clock.install({ time: new Date(now) });
    else if (session) await page.clock.setFixedTime(new Date(now));
    const card = () => page.locator('.nursery-card').filter({ has: page.getByRole('heading', { name: 'Feed', exact: true }) });
    async function select(child) {
      const switcher = page.getByRole('button', { name: 'Switch Baby', exact: true });
      if (await switcher.getAttribute('aria-haspopup') === 'listbox') {
        await switcher.click(); await page.getByRole('option', { name: child.firstName, exact: true }).click();
      }
    }
    await page.goto(`${base}/${family.slug}/nursery-mode`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('.nursery-drawer').getByRole('button', { name: 'Cards', exact: true }).click();
    await page.locator('.nursery-drawer').getByRole('button', { name: 'Close', exact: true }).click();
    await select(baby);
    if (session) await card().getByRole('button', { name: 'Stop', exact: true }).waitFor();
    const scope = JSON.stringify([family.id, `caretaker:${caretaker.id}`, baby.id]);
    const read = () => page.evaluate(key => JSON.parse(sessionStorage.getItem(key) || 'null'), `nurseryBreastfeedStopV1:${scope}`);
    return { page, owned, baby, now, session, card, select, read };
  }
  const stopResponse = page => page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().includes('/api/active-breastfeed?'));
  const reject = bodies => route => {
    if (route.request().method() !== 'DELETE') return route.continue();
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Synthetic rejected stop' }) });
  };
  try {
    {
      const { page, baby, card, read } = await fixture('running');
      const starting = page.waitForResponse(response => response.url() === `${base}/api/active-breastfeed` && response.request().method() === 'POST');
      await card().getByRole('button', { name: /^Left Breast/ }).click();
      const started = await starting; assert.equal(started.status(), 200);
      const session = (await started.json()).data;
      await page.clock.setFixedTime(new Date(Date.parse(session.currentSideStartTime) + 120_000));
      await card().getByText(/2:00/).waitFor();
      const before = await rows(baby.id), bodies = [], rejection = reject(bodies);
      await page.route('**/api/active-breastfeed?*', rejection);
      const rejected = stopResponse(page);
      await card().getByRole('button', { name: 'Stop', exact: true }).click();
      assert.equal((await rejected).status(), 503);
      await Promise.race([card().getByRole('button', { name: 'Retry stopped feed', exact: true }).waitFor(), card().getByRole('button', { name: /^Left Breast/ }).waitFor()]);
      assert.equal(await card().getByRole('button', { name: 'Retry stopped feed', exact: true }).count(), 1,
        `A failed stop must keep the stop intent; visible controls were: ${await card().innerText()}`);
      assert.deepEqual(await rows(baby.id), before);
      assert.equal(bodies[0].leftDuration, 120); assert.equal(bodies[0].rightDuration, 0); assert.equal(bodies[0].pauseDuration, 0);
      const frozen = await read(); assert.equal(frozen.leftDuration, 120);
      await page.screenshot({ path: 'test-results/breastfeed-stop-review.png' });
      checks.push('Rejected nursery Stop keeps the exact first stop and leaves the real session and care rows unchanged');
      await page.clock.setFixedTime(new Date(Date.parse(session.currentSideStartTime) + 900_000));
      await page.reload({ waitUntil: 'networkidle' });
      await card().getByRole('button', { name: 'Retry stopped feed', exact: true }).waitFor();
      assert.deepEqual(await read(), frozen);
      await page.unroute('**/api/active-breastfeed?*', rejection);
      const request = page.waitForRequest(request => request.method() === 'DELETE' && request.url().includes('/api/active-breastfeed?'));
      const saved = stopResponse(page);
      await card().getByRole('button', { name: 'Retry stopped feed', exact: true }).click();
      assert.deepEqual((await request).postDataJSON(), bodies[0]); assert.equal((await saved).status(), 200);
      await card().getByRole('button', { name: /^Left Breast/ }).waitFor();
      const [sessions, feeds] = await rows(baby.id);
      assert.equal(sessions.length, 0); assert.equal(feeds.length, 1); assert.equal(feeds[0].feedDuration, 120);
      assert.equal(feeds[0].endTime.getTime() - feeds[0].startTime.getTime(), 120_000); assert.equal(await read(), null);
      checks.push('Refresh and a much later manual retry use the original stop payload and create exactly one two-minute feeding side');
    }
    {
      const f = await fixture('paused', now => ({ isPaused: true, currentSideStartTime: null, pausedAt: new Date(now - 15_000),
        leftDuration: 120, rightDuration: 60, pauseDuration: 30, activeSide: 'RIGHT', sessionStartTime: new Date(now - 225_000) }));
      const bodies = [], rejection = reject(bodies);
      await f.page.route('**/api/active-breastfeed?*', rejection);
      const rejected = stopResponse(f.page); await f.card().getByRole('button', { name: 'Stop', exact: true }).click(); await rejected;
      await f.card().getByRole('button', { name: 'Retry stopped feed', exact: true }).waitFor();
      assert.equal(bodies[0].pauseDuration, 45);
      await f.page.clock.setFixedTime(new Date(f.now + 900_000));
      await f.page.reload({ waitUntil: 'networkidle' });
      await f.page.unroute('**/api/active-breastfeed?*', rejection);
      const saved = stopResponse(f.page); await f.card().getByRole('button', { name: 'Retry stopped feed', exact: true }).click();
      assert.equal((await saved).status(), 200);
      const [sessions, feeds] = await rows(f.baby.id);
      assert.equal(sessions.length, 0); assert.equal(feeds.length, 2);
      assert.deepEqual(feeds.map(feed => [feed.feedDuration, feed.pauseDuration]), [[120, 45], [60, 45]]);
      assert.equal(feeds[1].startTime.getTime() - feeds[0].endTime.getTime(), 45_000);
      checks.push('A paused stop freezes both side durations and the pause gap across refresh and a delayed retry');
    }
    {
      const f = await fixture('lost response', true);
      let committed;
      const finished = new Promise(resolve => { committed = resolve; });
      const loseResponse = async route => {
        if (route.request().method() !== 'DELETE') return route.continue();
        const response = await route.fetch(); assert.equal(response.status(), 200);
        committed(); await route.abort('failed');
      };
      await f.page.route('**/api/active-breastfeed?*', loseResponse);
      await f.card().getByRole('button', { name: 'Stop', exact: true }).click(); await finished;
      await f.card().getByRole('alert').filter({ hasText: 'Stop was not confirmed.' }).waitFor();
      const savedRows = await rows(f.baby.id); assert.equal(savedRows[0].length, 0); assert.equal(savedRows[1].length, 1);
      const frozen = await f.read(); assert.equal(frozen.leftDuration, 60);
      await f.page.unroute('**/api/active-breastfeed?*', loseResponse);
      const missing = stopResponse(f.page); await f.card().getByRole('button', { name: 'Retry stopped feed', exact: true }).click();
      assert.equal((await missing).status(), 404);
      await f.card().getByRole('alert').filter({ hasText: 'No active session was found.' }).waitFor();
      assert.deepEqual(await f.read(), frozen); assert.deepEqual(await rows(f.baby.id), savedRows);
      assert.equal(await f.card().getByRole('button', { name: 'Retry stopped feed', exact: true }).isDisabled(), true);
      await f.card().getByRole('button', { name: 'Reload current session', exact: true }).click();
      const popup = f.owned.waitForEvent('page'); await f.card().getByRole('button', { name: 'Review care log', exact: true }).click();
      const careLog = await popup; await careLog.waitForURL(`${base}/${family.slug}/log-entry`); await careLog.close();
      await f.card().getByRole('button', { name: 'Dismiss stop review', exact: true }).click();
      await f.card().getByRole('button', { name: /^Left Breast/ }).waitFor();
      assert.equal(await f.read(), null); assert.deepEqual(await rows(f.baby.id), savedRows);
      checks.push('A lost successful response followed by404 remains an explicit review; care-log inspection and dismissal never create a duplicate feed');
    }
    {
      const f = await fixture('revision', true);
      const response = await fetch(`${base}/api/active-breastfeed?id=${f.session.id}&action=pause`, { method: 'PUT',
        headers: { Authorization: `Bearer ${peerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedUpdatedAt: f.session.updatedAt.toISOString() }) });
      assert.equal(response.status, 200); await response.body?.cancel();
      const winner = await rows(f.baby.id);
      const conflict = stopResponse(f.page); await f.card().getByRole('button', { name: 'Stop', exact: true }).click();
      assert.equal((await conflict).status(), 409);
      await f.card().getByRole('alert').filter({ hasText: 'The session changed.' }).waitFor();
      const frozen = await f.read(); assert.deepEqual(await rows(f.baby.id), winner);
      await f.card().getByRole('button', { name: 'Reload current session', exact: true }).click();
      await f.card().getByRole('button', { name: 'Discard stop and use current timer', exact: true }).click();
      await f.card().getByRole('button', { name: 'Resume Left', exact: true }).waitFor();
      assert.equal(await f.read(), null); assert.equal(frozen.expectedUpdatedAt, f.session.updatedAt.toISOString());
      assert.deepEqual(await rows(f.baby.id), winner);
      checks.push('Another caregiver’s pause wins over a stale stop; reload and explicit discard use the current timer without changing the winner');
    }
    {
      const otherBaby = await babyRecord('other child'), f = await fixture('scope', true);
      let release, reached;
      const held = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { reached = resolve; });
      const bodies = [];
      const hold = async route => {
        if (route.request().method() !== 'DELETE') return route.continue();
        bodies.push(route.request().postDataJSON()); reached(); await held;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false }) });
      };
      await f.page.route('**/api/active-breastfeed?*', hold);
      const rejected = stopResponse(f.page); await f.card().getByRole('button', { name: 'Stop', exact: true }).click(); await arrived;
      const frozen = await f.read();
      try {
        await f.select(otherBaby);
        await f.card().getByRole('button', { name: /^Left Breast/ }).waitFor();
      } finally { release(); }
      await rejected.catch(() => {});
      assert.equal(await f.card().getByRole('button', { name: 'Retry stopped feed', exact: true }).count(), 0);
      await f.select(f.baby); await f.card().getByRole('button', { name: 'Retry stopped feed', exact: true }).waitFor();
      assert.deepEqual(await f.read(), frozen);
      await f.page.unroute('**/api/active-breastfeed?*', hold);
      await f.page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Retry stopped feed' && !button.disabled));
      // Same-tab token change deliberately has no storage event. The action's
      // immediate scope check must block dispatch before any async auth refresh.
      await f.page.evaluate(token => localStorage.setItem('authToken', token), peerToken);
      await f.card().getByRole('button', { name: 'Retry stopped feed', exact: true }).click();
      await f.card().getByRole('button', { name: 'Stop', exact: true }).waitFor();
      assert.equal(bodies.length, 1); assert.deepEqual(await f.read(), frozen);
      await f.page.evaluate(token => { localStorage.setItem('authToken', token); window.dispatchEvent(new StorageEvent('storage', { key: 'authToken' })); }, token);
      await f.card().getByRole('button', { name: 'Retry stopped feed', exact: true }).waitFor();
      assert.deepEqual(await f.read(), frozen); assert.equal((await rows(f.baby.id))[1].length, 0);
      checks.push('Child changes and same-tab caregiver changes preserve the original stop under its owner and block a stale retry from another scope');
    }
    {
      const f = await fixture('auth refresh', true), before = await rows(f.baby.id);
      let attempts = 0;
      await f.page.route('**/api/auth/refresh-token', route => route.fulfill({ status: 200,
        contentType: 'application/json', body: JSON.stringify({ success: true, data: { token: peerToken } }) }));
      await f.page.route('**/api/active-breastfeed?*', route => {
        if (route.request().method() !== 'DELETE') return route.continue();
        attempts++;
        return attempts === 1 ? route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ success: false }) }) : route.continue();
      });
      const conflict = f.page.waitForResponse(response => response.status() === 409 && response.request().method() === 'DELETE' && response.url().includes('/api/active-breastfeed?'));
      await f.card().getByRole('button', { name: 'Stop', exact: true }).click();
      await conflict;
      await f.card().getByRole('button', { name: 'Stop', exact: true }).waitFor();
      assert.equal(attempts, 2); assert.deepEqual(await rows(f.baby.id), before);
      const frozen = await f.read(); assert.ok(frozen);
      await f.page.evaluate(token => { localStorage.setItem('authToken', token); window.dispatchEvent(new StorageEvent('storage', { key: 'authToken' })); }, token);
      await f.card().getByRole('button', { name: 'Retry stopped feed', exact: true }).waitFor();
      assert.deepEqual(await f.read(), frozen);
      checks.push('An authenticated fetch refresh to another caregiver is rejected by the real scope guard and preserves the original owner’s stop without a stuck busy view');
    }
    {
      const f = await fixture('unreadable stop', true), bodies = [], rejection = reject(bodies);
      await f.page.route('**/api/active-breastfeed?*', rejection);
      const rejected = stopResponse(f.page); await f.card().getByRole('button', { name: 'Stop', exact: true }).click(); await rejected;
      await f.card().getByRole('button', { name: 'Retry stopped feed', exact: true }).waitFor();
      const frozen = await f.read(), before = await rows(f.baby.id);
      await f.page.unroute('**/api/active-breastfeed?*', rejection);
      const mutations = [];
      f.page.on('request', request => { if (['PUT', 'DELETE', 'POST'].includes(request.method()) && request.url().includes('/api/active-breastfeed')) mutations.push(request.method()); });
      await f.page.addInitScript(() => {
        window.__bfOriginalGetItem = Storage.prototype.getItem;
        Storage.prototype.getItem = function(key) {
          if (this === sessionStorage && key.startsWith('nurseryBreastfeedStopV1:')) throw new Error('Synthetic unavailable stop read');
          return window.__bfOriginalGetItem.call(this, key);
        };
      });
      await f.page.reload({ waitUntil: 'networkidle' });
      await f.card().getByRole('alert').filter({ hasText: 'could not read its saved stop review' }).waitFor();
      assert.equal(await f.card().getByRole('button', { name: 'Retry stopped feed', exact: true }).isDisabled(), true);
      for (const name of ['Stop', 'Switch', 'Pause', 'Resume Left', 'Resume Right']) {
        assert.equal(await f.card().getByRole('button', { name, exact: true }).count(), 0);
      }
      await f.card().getByRole('button', { name: 'Reload current session', exact: true }).click();
      await f.card().getByRole('alert').filter({ hasText: 'could not read its saved stop review' }).waitFor();
      assert.deepEqual(mutations, []); assert.deepEqual(await rows(f.baby.id), before);
      await f.page.evaluate(() => { Storage.prototype.getItem = window.__bfOriginalGetItem; });
      await f.card().getByRole('button', { name: 'Reload current session', exact: true }).click();
      await f.page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Retry stopped feed' && !button.disabled));
      assert.deepEqual(await f.read(), frozen); assert.deepEqual(mutations, []);
      checks.push('An unreadable saved stop stays blocked after a successful session GET; explicit storage reread restores the exact intent without timer mutations');
    }
    {
      const f = await fixture('timeout', true, true), before = await rows(f.baby.id);
      const held = [];
      let arrived, release;
      let arrival = new Promise(resolve => { arrived = resolve; });
      let gate = new Promise(resolve => { release = resolve; });
      let holdMethod = 'DELETE';
      const stall = async route => {
        if (route.request().method() !== holdMethod) return route.continue();
        held.push(route.request().method()); arrived(); await gate;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false }) }).catch(() => {});
      };
      await f.page.route('**/api/active-breastfeed?*', stall);
      try {
        await f.card().getByRole('button', { name: 'Stop', exact: true }).click(); await arrival;
        const frozen = await f.read();
        await f.page.clock.fastForward(20_001);
        await f.card().getByRole('alert').filter({ hasText: 'Stop was not confirmed.' }).waitFor();
        assert.equal(await f.card().getByRole('button', { name: 'Retry stopped feed', exact: true }).isEnabled(), true);
        assert.deepEqual(await f.read(), frozen); assert.deepEqual(await rows(f.baby.id), before);
        release();
        // The same bounded behavior applies while inspecting a stalled GET.
        holdMethod = 'GET';
        arrival = new Promise(resolve => { arrived = resolve; });
        gate = new Promise(resolve => { release = resolve; });
        await f.card().getByRole('button', { name: 'Reload current session', exact: true }).click(); await arrival;
        await f.page.clock.fastForward(20_001);
        await f.card().getByRole('alert').filter({ hasText: 'Could not reload the breastfeeding session.' }).waitFor();
        assert.deepEqual(await f.read(), frozen); assert.deepEqual(await rows(f.baby.id), before);
        assert.equal(held.filter(method => method === 'DELETE').length, 1); assert.ok(held.includes('GET'));
        release(); await f.page.unroute('**/api/active-breastfeed?*', stall);
        const saved = stopResponse(f.page); await f.card().getByRole('button', { name: 'Retry stopped feed', exact: true }).click();
        assert.equal((await saved).status(), 200);
        const [sessions, feeds] = await rows(f.baby.id);
        assert.equal(sessions.length, 0); assert.equal(feeds.length, 1); assert.equal(feeds[0].feedDuration, frozen.leftDuration);
        checks.push('Stalled Stop and Reload requests both time out with the first stop intact; only an explicit retry creates the original-duration feed');
      } finally { release(); }
    }
    {
      const f = await fixture('blocked storage', true);
      let deletes = 0;
      f.page.on('request', request => { if (request.method() === 'DELETE' && request.url().includes('/api/active-breastfeed?')) deletes++; });
      await f.page.evaluate(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
          if (this === sessionStorage && key.startsWith('nurseryBreastfeedStopV1:')) throw new Error('Synthetic blocked stop storage');
          return original.call(this, key, value);
        };
      });
      const before = await rows(f.baby.id);
      await f.card().getByRole('button', { name: 'Stop', exact: true }).click();
      await f.card().getByRole('alert').filter({ hasText: 'No request was sent on this attempt.' }).waitFor();
      assert.equal(deletes, 0); assert.deepEqual(await rows(f.baby.id), before); assert.equal(await f.read(), null);
      assert.match(await f.card().innerText(), /Stop review.*L: 1:00/s);
      checks.push('Blocked session storage retains the first stop on screen and prevents every finalization request');
    }
    {
      const f = await fixture('big tiles', true);
      await f.page.getByRole('button', { name: 'Settings', exact: true }).click();
      await f.page.locator('.nursery-drawer').getByRole('button', { name: 'Big Tiles', exact: true }).click();
      await f.page.locator('.nursery-drawer').getByRole('button', { name: 'Close', exact: true }).click();
      const tile = f.page.locator('.nursery-tile').filter({ has: f.page.locator('.tlabel').filter({ hasText: /^Feed$/ }) });
      await tile.locator('.tmain').click();
      const modal = f.page.getByRole('dialog', { name: 'Feed', exact: true });
      const rejection = reject([]); await f.page.route('**/api/active-breastfeed?*', rejection);
      const rejected = stopResponse(f.page); await modal.getByRole('button', { name: 'Stop', exact: true }).click(); await rejected;
      await modal.getByRole('alert').filter({ hasText: 'Stop was not confirmed.' }).waitFor();
      assert.equal(await modal.isVisible(), true);
      await modal.getByText('Stop review · L: 1:00 R: 0:00', { exact: true }).waitFor();
      await modal.getByRole('button', { name: 'Retry stopped feed', exact: true }).waitFor();
      await f.page.screenshot({ path: 'test-results/breastfeed-stop-modal.png' });
      checks.push('Big Tiles keeps the feed dialog, exact times and explicit recovery controls open after a failed stop');
    }
    assert.deepEqual(errors, []);
    return checks;
  } catch (error) {
    error.message = `Breastfeeding recovery after ${checks.at(-1) || 'initial stop'}: ${error.message}`;
    throw error;
  } finally {
    for (const owned of ownedContexts) {
      for (const page of owned.pages()) await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
      await owned.close();
    }
  }
}
