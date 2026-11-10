// Actual Nursery controls, real USER logins, and disposable local SQLite only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

const conflict = 'This entry changed or was removed. Undo could not be confirmed. Review the care log.';
const uncertain = 'Undo was not confirmed. Keep this action and retry or review the care log.';
const foodConflict = 'This food entry changed or its enjoyment update was not confirmed. Review the care log.';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 15_000); })]); }
  finally { clearTimeout(timer); }
}

export async function verifyNurseryUndo({ base, db, family: enclosingFamily, secret, context, onCheck }) {
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(enclosingFamily.name, /synthetic/i);
  const checks = [], errors = [], releases = new Set();
  const family = await db.family.create({ data: { name: 'Synthetic Conditional Undo', slug: `synthetic-undo-${randomUUID().slice(0, 8)}`, setupStage: 3 } });
  const people = await Promise.all(['01', '02'].map((loginId, index) => db.caretaker.create({ data: {
    familyId: family.id, loginId, name: `Synthetic Undo Caregiver ${index + 1}`, role: 'USER', type: 'parent',
    securityPin: `49327${index}`, lastSeenVersion: '1.6.7',
  } })));
  const [caretaker, peer] = people;
  await db.settings.create({ data: { familyId: family.id, familyName: family.name, authType: 'CARETAKER',
    defaultBottleUnit: 'ML', enableBreastMilkTracking: true,
    nurseryModeSettings: JSON.stringify({ global: { layout: 'cards', acts: { feed: true, pump: true, diaper: true, sleep: true, food: true } } }),
  } });
  const food = await db.food.create({ data: { familyId: family.id, name: 'Synthetic Undo Banana' } });
  async function login(person) {
    const response = await fetch(`${base}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginId: person.loginId, securityPin: person.securityPin, familySlug: family.slug }), signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.data.role, 'USER');
    const claims = jwt.verify(body.data.token, secret);
    assert.equal(claims.id, person.id); assert.equal(claims.familyId, family.id);
    return body.data.token;
  }
  const token = await login(caretaker), peerToken = await login(peer);
  const child = label => db.baby.create({ data: { familyId: family.id, firstName: `Synthetic Undo ${label}`,
    lastName: 'Acceptance', birthDate: new Date('2026-01-01T00:00:00Z') } });
  // The real selector must have more than one child even in the first case.
  const sibling = await child('Sibling');
  async function api(endpoint, method, body, auth = peerToken) {
    const response = await fetch(`${base}${endpoint}`, { method, headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    return { status: response.status, body: await response.json() };
  }
  async function fixture(label, options = {}) {
    const baby = await child(String(checks.length + 1)), now = Math.floor(Date.now() / 1000) * 1000;
    if (options.breast) await db.activeBreastFeed.create({ data: { familyId: family.id, babyId: baby.id, caretakerId: caretaker.id,
      activeSide: 'RIGHT', firstSide: 'LEFT', leftDuration: 60, rightDuration: options.singleSide ? 0 : 90, pauseDuration: 0,
      isPaused: true, sessionStartTime: new Date(now - 180_000), currentSideStartTime: null, pausedAt: new Date(now - 30_000),
    } });
    const owned = await context.browser().newContext({ viewport: options.phone ? { width: 412, height: 915 } : { width: 1440, height: 1100 },
      timezoneId: 'UTC', serviceWorkers: 'block' });
    await owned.addInitScript(({ token, family, baby, caretakerId }) => {
      if (!localStorage.getItem('authToken')) {
        localStorage.setItem('authToken', token); localStorage.setItem('caretakerId', caretakerId); localStorage.setItem('isAdmin', 'false');
        localStorage.setItem('selectedFamily', JSON.stringify(family)); localStorage.setItem(`selectedBaby_${family.id}`, JSON.stringify(baby));
      }
      localStorage.setItem('unlockTime', String(Date.now()));
    }, { token, family, baby, caretakerId: caretaker.id });
    const page = await owned.newPage(); page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(30_000);
    page.on('pageerror', error => errors.push(`${label}: ${error.message}`));
    if (!options.realClock) await page.clock.install({ time: new Date(now) });
    const card = name => page.locator('.nursery-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
    const toast = () => page.locator('.nursery-toast');
    const response = (endpoint, method) => {
      const pending = page.waitForResponse(result => new URL(result.url()).pathname === endpoint && result.request().method() === method);
      // Held-response assertions may fail before this promise is awaited.
      // Mark the rejection handled immediately so the owned cleanup still runs.
      void pending.catch(() => {}); return pending;
    };
    const select = async other => {
      await page.getByRole('button', { name: 'Switch Baby', exact: true }).click();
      await page.getByRole('option', { name: other.firstName, exact: true }).click();
    };
    await page.goto(`${base}/${family.slug}/nursery-mode`, { waitUntil: 'networkidle' });
    await select(baby); await card('Diaper').waitFor();
    return { baby, now, owned, page, card, toast, response, select,
      scope: JSON.stringify([family.id, `caretaker:${caretaker.id}`, baby.id]) };
  }
  async function run(name, action, options) {
    const f = await fixture(name, options);
    try {
      await action(f); checks.push(name); onCheck?.(name); console.log(`Conditional Undo passed: ${name}`);
    } catch (error) {
      await f.page.screenshot({ path: 'test-results/nursery-undo-failure.png', fullPage: true }).catch(() => {});
      throw new Error(`${name}: ${error.message}`, { cause: error });
    } finally {
      for (const release of releases) release(); releases.clear();
      await bounded(f.page.unrouteAll({ behavior: 'ignoreErrors' }), 'Undo route cleanup');
      await bounded(f.owned.close(), 'Undo context cleanup');
    }
  }
  async function diaper(f, label = 'Wet') {
    const response = f.response('/api/diaper-log', 'POST');
    await f.card('Diaper').getByRole('button', { name: label, exact: true }).click();
    const result = await response; assert.equal(result.status(), 200); const body = await result.json();
    assert.equal(body.undo.scope, f.scope); assert.equal(body.undo.records[0].id, body.data.id);
    return body;
  }
  async function undo(f, endpoint, expected = 200, button = 'Undo') {
    const response = f.response(endpoint, 'DELETE');
    await f.toast().getByRole('button', { name: button, exact: true }).click();
    const result = await response; assert.equal(result.status(), expected);
    return result;
  }
  async function hold(f, endpoint, method, status) {
    const arrived = deferred(), released = deferred(); releases.add(released.resolve);
    const requests = []; let saved;
    const handler = async route => {
      if (route.request().method() !== method) return route.continue();
      requests.push(route.request().postDataJSON());
      const response = status === undefined ? await route.fetch() : null;
      if (response) { assert.equal(response.status(), 200); saved = await response.json(); }
      arrived.resolve(); await released.promise;
      if (response) return route.fulfill({ response });
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ success: false }) });
    };
    await f.page.route(`**${endpoint}${method === 'POST' ? '' : '?*'}`, handler);
    return { requests, arrived: arrived.promise, release: released.resolve, get saved() { return saved; }, handler };
  }
  // Response completion plus two render frames is a bounded React checkpoint,
  // not a delay chosen to conceal a missing outcome.
  async function rendered(page, response) {
    await response.finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  async function stopBreast(f) {
    const response = f.response('/api/active-breastfeed', 'DELETE');
    await f.card('Feed').getByRole('button', { name: 'Stop', exact: true }).click();
    const result = await response; assert.equal(result.status(), 200); const body = await result.json();
    assert.equal(body.undo.kind, 'breast'); assert.equal(body.undo.scope, f.scope);
    await f.toast().getByRole('button', { name: 'Undo', exact: true }).waitFor(); return body;
  }
  async function pump(f) {
    await f.card('Pump').getByRole('button', { name: 'Start Both', exact: true }).click();
    await f.card('Pump').getByRole('button', { name: 'Stop', exact: true }).click();
    await f.card('Pump').locator('input').nth(0).fill('45'); await f.card('Pump').locator('input').nth(1).fill('55');
    const response = f.response('/api/pump-log', 'POST'); await f.card('Pump').getByRole('button', { name: 'Fed', exact: true }).click();
    const result = await response; assert.equal(result.status(), 200); const body = await result.json();
    assert.equal(body.undo.kind, 'pump'); assert.ok(body.undo.feed?.revision);
    await f.toast().getByRole('button', { name: 'Undo', exact: true }).waitFor(); return body;
  }
  async function logFood(f) {
    await f.card('Food').getByRole('button', { name: 'Log Food', exact: true }).click();
    const response = f.response('/api/food-log', 'POST');
    await f.card('Food').getByRole('button', { name: food.name, exact: true }).click();
    const result = await response; assert.equal(result.status(), 200); const body = await result.json();
    await f.card('Food').getByRole('button', { name: 'Loved', exact: true }).waitFor(); return body;
  }
  async function openBottle(f) {
    await f.card('Feed').getByRole('button', { name: 'Bottle', exact: true }).click();
    const dialog = f.page.getByRole('dialog', { name: 'Add bottle', exact: true });
    const form = dialog.getByRole('form', { name: 'Add bottle', exact: true });
    await form.getByRole('spinbutton', { name: /^Consumed/ }).fill('75');
    await form.getByLabel('Milk type', { exact: true }).selectOption('Formula');
    return { dialog, form };
  }

  await run('Exact original diaper Undo sends its captured revision and removes one row', async f => {
    const saved = await diaper(f); const result = await undo(f, '/api/diaper-log');
    assert.deepEqual(result.request().postDataJSON(), { nurseryUndo: saved.undo });
    await f.toast().waitFor({ state: 'detached' }); assert.equal(await db.diaperLog.findUnique({ where: { id: saved.data.id } }), null);
  });
  await run('Peer diaper correction survives Undo and stays reviewable beyond six seconds', async f => {
    const saved = await diaper(f);
    assert.equal((await api(`/api/diaper-log?id=${saved.data.id}`, 'PUT', { type: 'BOTH', notes: 'Peer verified correction' })).status, 200);
    const winner = await db.diaperLog.findUniqueOrThrow({ where: { id: saved.data.id } });
    await undo(f, '/api/diaper-log', 409); await f.toast().getByText(conflict, { exact: true }).waitFor();
    await f.page.clock.fastForward(7000); assert.equal(await f.toast().getAttribute('role'), 'alert');
    assert.equal(await f.toast().getByRole('button', { name: 'Retry Undo', exact: true }).count(), 0);
    assert.deepEqual(await db.diaperLog.findUnique({ where: { id: winner.id } }), winner);
    assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await f.page.screenshot({ path: 'test-results/nursery-undo-review-phone.png', fullPage: true });
    const popup = f.owned.waitForEvent('page'); await f.toast().getByRole('button', { name: 'Review care log', exact: true }).click();
    const review = await popup; await review.waitForURL(`${base}/${family.slug}/full-log`); await review.close();
    await f.toast().getByRole('button', { name: 'Dismiss Undo review', exact: true }).click();
    await f.toast().waitFor({ state: 'detached' }); assert.deepEqual(await db.diaperLog.findUnique({ where: { id: winner.id } }), winner);
  }, { phone: true });
  await run('Slow and failed Undo remain visible and an explicit retry uses only the original descriptor', async f => {
    const saved = await diaper(f), original = await db.diaperLog.findUniqueOrThrow({ where: { id: saved.data.id } });
    const held = await hold(f, '/api/diaper-log', 'DELETE', 503), result = f.response('/api/diaper-log', 'DELETE');
    await f.toast().getByRole('button', { name: 'Undo', exact: true }).click(); await bounded(held.arrived, 'Slow Undo arrival');
    const busy = f.toast().getByRole('button', { name: 'Undoing…', exact: true }); await busy.waitFor();
    await f.page.clock.fastForward(7000); assert.equal(await busy.isDisabled(), true);
    const box = await busy.boundingBox(); assert.ok(box); await f.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { clickCount: 2 });
    assert.equal(held.requests.length, 1); assert.deepEqual(await db.diaperLog.findUnique({ where: { id: original.id } }), original);
    held.release(); assert.equal((await result).status(), 503); await f.toast().getByText(uncertain, { exact: true }).waitFor();
    await f.page.clock.fastForward(7000); assert.equal(await f.toast().getByRole('button', { name: 'Retry Undo', exact: true }).count(), 1);
    await f.page.unroute('**/api/diaper-log?*', held.handler);
    const retry = await undo(f, '/api/diaper-log', 200, 'Retry Undo');
    assert.deepEqual(retry.request().postDataJSON(), held.requests[0]); assert.deepEqual(held.requests[0], { nurseryUndo: saved.undo });
    await f.toast().waitFor({ state: 'detached' }); assert.equal(await db.diaperLog.findUnique({ where: { id: original.id } }), null);
  });
  await run('A lost successful Undo followed by404 requires review and never reports false success', async f => {
    const saved = await diaper(f), bodies = [];
    const lose = async route => {
      if (route.request().method() !== 'DELETE') return route.continue();
      bodies.push(route.request().postDataJSON()); const result = await route.fetch(); assert.equal(result.status(), 200); await route.abort('failed');
    };
    await f.page.route('**/api/diaper-log?*', lose); await f.toast().getByRole('button', { name: 'Undo', exact: true }).click();
    await f.toast().getByText(uncertain, { exact: true }).waitFor(); assert.equal(await db.diaperLog.findUnique({ where: { id: saved.data.id } }), null);
    await f.page.unroute('**/api/diaper-log?*', lose); const missing = await undo(f, '/api/diaper-log', 404, 'Retry Undo');
    assert.deepEqual(missing.request().postDataJSON(), bodies[0]); await f.toast().getByText(conflict, { exact: true }).waitFor();
    assert.equal(await f.toast().getByRole('button', { name: 'Retry Undo', exact: true }).count(), 0);
  });
  await run('A held successful save cannot display the original child’s summary or Undo after a child switch', async f => {
    const other = sibling, held = await hold(f, '/api/diaper-log', 'POST');
    const response = f.response('/api/diaper-log', 'POST');
    await f.card('Diaper').getByRole('button', { name: 'Wet', exact: true }).click(); await bounded(held.arrived, 'Saved diaper arrival');
    await f.select(other); held.release(); await rendered(f.page, await response);
    assert.equal(await f.toast().count(), 0); assert.equal(await f.card('Diaper').locator('.nursery-card-meta .d').count(), 0);
    const original = await db.diaperLog.findUniqueOrThrow({ where: { id: held.saved.data.id } });
    assert.equal(original.babyId, f.baby.id);
    assert.equal(await db.diaperLog.count({ where: { babyId: other.id } }), 0);
    await f.select(f.baby);
    // The stale response cannot acknowledge the first intent. Returning to its
    // child must retain review until an explicit replay confirms that snapshot.
    const retry = f.card('Diaper').getByRole('button', { name: 'Retry saved care action', exact: true });
    await retry.waitFor();
    await f.card('Diaper').locator('.nursery-card-meta').filter({ hasText: 'Saved care action · Wet' }).waitFor();
    assert.equal(await f.toast().count(), 0, 'Returning to the original child does not invent an Undo descriptor');
    const pending = await f.page.evaluate(key => JSON.parse(localStorage.getItem(key)), `nurseryQuickCareIntentV1:diaper:${f.scope}`);
    assert.equal(pending.requestId, held.requests[0].requestId); assert.equal(pending.time, held.requests[0].time);
    await f.page.unroute('**/api/diaper-log', held.handler);
    const repeated = f.response('/api/diaper-log', 'POST'); await retry.click();
    const confirmed = await repeated; assert.equal(confirmed.status(), 200); const body = await confirmed.json();
    assert.deepEqual(confirmed.request().postDataJSON(), held.requests[0]);
    assert.equal(body.replayed, true); assert.deepEqual(body.undo, held.saved.undo);
    await f.toast().getByRole('button', { name: 'Undo', exact: true }).waitFor();
    assert.deepEqual(await db.diaperLog.findUnique({ where: { id: original.id } }), original);
    assert.equal(await db.diaperLog.count({ where: { babyId: f.baby.id } }), 1);
  });
  await run('A held Undo retains its descriptor while a newer same-child save keeps the winning summary', async f => {
    const first = await diaper(f), held = await hold(f, '/api/diaper-log', 'DELETE'), response = f.response('/api/diaper-log', 'DELETE');
    await f.toast().getByRole('button', { name: 'Undo', exact: true }).click(); await bounded(held.arrived, 'Committed Undo arrival');
    const second = await diaper(f, 'Dirty'); await f.toast().getByText('Wet diaper logged', { exact: true }).waitFor();
    await f.card('Diaper').locator('.nursery-card-meta .d').filter({ hasText: 'Dirty' }).waitFor();
    held.release(); await rendered(f.page, await response); await f.toast().waitFor({ state: 'detached' });
    await f.card('Diaper').locator('.nursery-card-meta .d').filter({ hasText: 'Dirty' }).waitFor();
    assert.equal(await db.diaperLog.findUnique({ where: { id: first.data.id } }), null);
    assert.equal((await db.diaperLog.findUniqueOrThrow({ where: { id: second.data.id } })).type, 'DIRTY');
  });
  await run('A late old-child Undo response cannot dismiss a newer child’s action', async f => {
    const other = sibling, first = await diaper(f), held = await hold(f, '/api/diaper-log', 'DELETE');
    const response = f.response('/api/diaper-log', 'DELETE'); await f.toast().getByRole('button', { name: 'Undo', exact: true }).click();
    await bounded(held.arrived, 'Old-child Undo arrival'); await f.select(other);
    const saved = f.response('/api/diaper-log', 'POST'); await f.card('Diaper').getByRole('button', { name: 'Dirty', exact: true }).click();
    const second = await (await saved).json(); await f.toast().getByText('Dirty diaper logged', { exact: true }).waitFor();
    held.release(); await rendered(f.page, await response); await f.toast().getByText('Dirty diaper logged', { exact: true }).waitFor();
    assert.equal(await db.diaperLog.findUnique({ where: { id: first.data.id } }), null);
    assert.equal((await db.diaperLog.findUniqueOrThrow({ where: { id: second.data.id } })).babyId, other.id);
    await f.page.unroute('**/api/diaper-log?*', held.handler);
    const undone = await undo(f, '/api/diaper-log'); assert.deepEqual(undone.request().postDataJSON(), { nurseryUndo: second.undo });
  });
  await run('A same-tab caregiver change cannot dispatch the previous caregiver’s Undo', async f => {
    const saved = await diaper(f), mutations = [];
    f.page.on('request', request => { if (request.method() === 'DELETE' && new URL(request.url()).pathname === '/api/diaper-log') mutations.push(request); });
    await f.toast().getByRole('button', { name: 'Undo', exact: true }).waitFor();
    await f.page.evaluate(value => localStorage.setItem('authToken', value), peerToken);
    await f.toast().getByRole('button', { name: 'Undo', exact: true }).click();
    await f.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await f.toast().waitFor({ state: 'detached' }); assert.equal(mutations.length, 0);
    assert.equal((await db.diaperLog.findUniqueOrThrow({ where: { id: saved.data.id } })).caretakerId, caretaker.id);
  });
  await run('Two breast sides use one atomic Undo request and survive a failed attempt before exact retry', async f => {
    const saved = await stopBreast(f); assert.equal(saved.undo.records.length, 2);
    const originals = await db.feedLog.findMany({ where: { babyId: f.baby.id }, orderBy: { id: 'asc' } }), bodies = [];
    const reject = route => {
      if (route.request().method() !== 'DELETE') return route.continue();
      bodies.push(route.request().postDataJSON()); return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false }) });
    };
    await f.page.route('**/api/feed-log?*', reject); await undo(f, '/api/feed-log', 503);
    await f.toast().getByText(uncertain, { exact: true }).waitFor(); assert.equal(bodies.length, 1);
    assert.deepEqual(await db.feedLog.findMany({ where: { babyId: f.baby.id }, orderBy: { id: 'asc' } }), originals);
    await f.page.unroute('**/api/feed-log?*', reject); const result = await undo(f, '/api/feed-log', 200, 'Retry Undo');
    assert.deepEqual(result.request().postDataJSON(), bodies[0]); assert.deepEqual(bodies[0], { nurseryUndo: saved.undo });
    await f.toast().waitFor({ state: 'detached' }); assert.equal(await db.feedLog.count({ where: { babyId: f.baby.id } }), 0);
  }, { breast: true });
  await run('An intervening breast-side correction prevents deletion of either original side', async f => {
    const saved = await stopBreast(f), right = saved.undo.records[1].id;
    assert.equal((await api(`/api/feed-log?id=${right}`, 'PUT', { notes: 'Peer corrected this side' })).status, 200);
    const winner = await db.feedLog.findMany({ where: { babyId: f.baby.id }, orderBy: { id: 'asc' } });
    await undo(f, '/api/feed-log', 409); await f.toast().getByText(conflict, { exact: true }).waitFor();
    assert.deepEqual(await db.feedLog.findMany({ where: { babyId: f.baby.id }, orderBy: { id: 'asc' } }), winner);
  }, { breast: true });
  await run('An unchanged pump and its exact feeding row are undone together while its receipt remains', async f => {
    const saved = await pump(f), receipts = await db.externalImportRecord.findMany({ where: { familyId: family.id } });
    const result = await undo(f, '/api/pump-log'); assert.deepEqual(result.request().postDataJSON(), { nurseryUndo: saved.undo });
    await f.toast().waitFor({ state: 'detached' }); assert.equal(await db.pumpLog.findUnique({ where: { id: saved.data.id } }), null);
    assert.equal(await db.feedLog.findUnique({ where: { id: saved.undo.feed.id } }), null);
    assert.deepEqual(await db.externalImportRecord.findMany({ where: { familyId: family.id } }), receipts);
  });
  await run('A corrected feeding amount blocks pump Undo and preserves both records', async f => {
    const saved = await pump(f), originalPump = await db.pumpLog.findUniqueOrThrow({ where: { id: saved.data.id } });
    assert.equal((await api(`/api/feed-log?id=${saved.undo.feed.id}`, 'PUT', { amount: 80, bottleType: 'Breast Milk', notes: 'Peer observed80mL' })).status, 200);
    const winner = await db.feedLog.findUniqueOrThrow({ where: { id: saved.undo.feed.id } });
    await undo(f, '/api/pump-log', 409); await f.toast().getByText(conflict, { exact: true }).waitFor();
    assert.deepEqual(await db.pumpLog.findUnique({ where: { id: saved.data.id } }), originalPump);
    assert.deepEqual(await db.feedLog.findUnique({ where: { id: winner.id } }), winner);
  });
  await run('The caregiver’s own enjoyment update advances Food Undo to exactly its confirmed revision', async f => {
    const saved = await logFood(f), response = f.response('/api/food-log', 'PUT');
    await f.card('Food').getByRole('button', { name: 'Loved', exact: true }).click();
    const updated = await response; assert.equal(updated.status(), 200); const body = await updated.json();
    assert.deepEqual(updated.request().postDataJSON(), { enjoyment: 'LOVED', nurseryUndo: saved.undo });
    assert.notEqual(body.undo.records[0].revision, saved.undo.records[0].revision);
    await f.card('Food').locator('.nursery-card-meta .d').filter({ hasText: 'Loved' }).waitFor();
    const result = await undo(f, '/api/food-log'); assert.deepEqual(result.request().postDataJSON(), { nurseryUndo: body.undo });
    await f.toast().waitFor({ state: 'detached' }); assert.ok((await db.foodLog.findUniqueOrThrow({ where: { id: saved.data.id } })).deletedAt);
  });
  await run('Peer Food changes reject enjoyment and the original Undo without adopting the peer revision', async f => {
    const saved = await logFood(f);
    assert.equal((await api(`/api/food-log?id=${saved.data.id}`, 'PUT', { notes: 'Peer verified food notes' })).status, 200);
    const winner = await db.foodLog.findUniqueOrThrow({ where: { id: saved.data.id } }), response = f.response('/api/food-log', 'PUT');
    await f.card('Food').getByRole('button', { name: 'Loved', exact: true }).click(); assert.equal((await response).status(), 409);
    await f.card('Food').getByText(foodConflict, { exact: true }).waitFor();
    const result = await undo(f, '/api/food-log', 409); assert.deepEqual(result.request().postDataJSON(), { nurseryUndo: saved.undo });
    await f.toast().getByText(conflict, { exact: true }).waitFor();
    assert.deepEqual(await db.foodLog.findUnique({ where: { id: winner.id } }), winner);
  });
  await run('A reviewed bottle uses its original write descriptor and preserves the replay receipt after Undo', async f => {
    const { dialog, form } = await openBottle(f), response = f.response('/api/bottle-journal', 'POST');
    await form.getByRole('button', { name: 'Save bottle', exact: true }).click();
    const result = await response; assert.equal(result.status(), 200); const saved = await result.json();
    await form.waitFor({ state: 'detached' }); await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    const receipts = await db.externalImportRecord.findMany({ where: { familyId: family.id } });
    const removed = await undo(f, '/api/feed-log'); assert.deepEqual(removed.request().postDataJSON(), { nurseryUndo: saved.data.undo });
    assert.equal(await db.feedLog.findUnique({ where: { id: saved.data.id } }), null);
    assert.deepEqual(await db.externalImportRecord.findMany({ where: { familyId: family.id } }), receipts);
  });
  await run('A bottle replay confirms the existing save without inventing a fresh Undo', async f => {
    const { dialog, form } = await openBottle(f); let original, resolveCapture, rejectCapture;
    const captured = new Promise((resolve, reject) => { resolveCapture = resolve; rejectCapture = reject; });
    // Pending controls render before delivery finishes. Capture failures must
    // reach the bounded assertion even if they occur before it starts waiting.
    void captured.catch(() => {});
    const lose = async route => {
      if (route.request().method() !== 'POST') return route.continue();
      try {
        const response = await route.fetch(); assert.equal(response.status(), 200);
        original = await response.json(); assert.equal(original.success, true);
        assert.ok(original.data?.id); assert.ok(original.data?.undo);
        await route.abort('failed'); resolveCapture();
      } catch (error) { rejectCapture(error); }
    };
    await f.page.route('**/api/bottle-journal', lose); await form.getByRole('button', { name: 'Save bottle', exact: true }).click();
    const pending = dialog.getByRole('region', { name: 'Pending bottles on this browser', exact: true });
    await pending.getByRole('button', { name: 'Retry this entry', exact: true }).waitFor();
    await bounded(captured, 'Capture and drop the original successful bottle response');
    assert.ok(original.data.undo); await f.page.unroute('**/api/bottle-journal', lose);
    const replay = f.response('/api/bottle-journal', 'POST'); await pending.getByRole('button', { name: 'Retry this entry', exact: true }).click();
    const replayed = await replay; assert.equal(replayed.status(), 200); const body = await replayed.json();
    assert.equal(body.data.id, original.data.id); assert.equal(body.data.undo, undefined);
    await pending.waitFor({ state: 'detached' }); await dialog.getByText('Bottle saved.', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click(); assert.equal(await f.toast().count(), 0);
    assert.equal(await db.feedLog.count({ where: { babyId: f.baby.id } }), 1);
  });
  await run('A held authentication refresh reaches the Undo deadline without a late delete and permits exact explicit retry', async f => {
    const saved = await diaper(f), original = await db.diaperLog.findUniqueOrThrow({ where: { id: saved.data.id } });
    // Establish the actual HTTP-only refresh cookie in this browser context.
    const login = await f.owned.request.post(`${base}/api/auth`, { data: {
      familySlug: family.slug, loginId: caretaker.loginId, securityPin: caretaker.securityPin,
    } });
    assert.equal(login.status(), 200); assert.ok((await f.owned.cookies()).some(cookie => cookie.name === 'refreshToken'));
    const entered = deferred(), release = deferred(); releases.add(release.resolve);
    const refreshing = async route => {
      entered.resolve(); await release.promise;
      const response = await route.fetch(); assert.equal(response.status(), 200); await route.fulfill({ response });
    };
    const bodies = [];
    const unauthorized = route => {
      if (route.request().method() !== 'DELETE') return route.continue();
      bodies.push(route.request().postDataJSON());
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ success: false }) });
    };
    await f.page.route('**/api/auth/refresh-token', refreshing); await f.page.route('**/api/diaper-log?*', unauthorized);
    const started = Date.now(); await f.toast().getByRole('button', { name: 'Undo', exact: true }).click();
    await bounded(entered.promise, 'Real auth refresh arrival');
    try { await f.toast().getByText(uncertain, { exact: true }).waitFor({ timeout: 25_000 }); }
    catch (error) {
      console.log(JSON.stringify({ heldRefreshElapsedMs: Date.now() - started, toast: await f.toast().innerText(),
        originalRowUnchanged: JSON.stringify(await db.diaperLog.findUnique({ where: { id: original.id } })) === JSON.stringify(original) }));
      throw error;
    }
    assert.equal(await f.toast().getByRole('button', { name: 'Retry Undo', exact: true }).isEnabled(), true);
    assert.deepEqual(await db.diaperLog.findUnique({ where: { id: original.id } }), original); assert.equal(bodies.length, 1);
    let lateDeletes = 0;
    const observe = route => { if (route.request().method() === 'DELETE') lateDeletes++; return route.continue(); };
    await f.page.unroute('**/api/diaper-log?*', unauthorized); await f.page.route('**/api/diaper-log?*', observe);
    const response = f.response('/api/auth/refresh-token', 'POST'); release.resolve(); await rendered(f.page, await response);
    assert.equal(lateDeletes, 0, 'Resolving refresh must not dispatch the aborted original DELETE');
    assert.deepEqual(await db.diaperLog.findUnique({ where: { id: original.id } }), original);
    await f.page.unroute('**/api/auth/refresh-token', refreshing); await f.page.unroute('**/api/diaper-log?*', observe);
    const retried = await undo(f, '/api/diaper-log', 200, 'Retry Undo');
    assert.deepEqual(retried.request().postDataJSON(), bodies[0]); assert.deepEqual(bodies[0], { nurseryUndo: saved.undo });
    await f.toast().waitFor({ state: 'detached' }); assert.equal(await db.diaperLog.findUnique({ where: { id: original.id } }), null);
  }, { realClock: true });
  assert.deepEqual(errors, [], 'Conditional Undo browser JavaScript errors');
  assert.equal(checks.length, 17);
  return checks;
}
