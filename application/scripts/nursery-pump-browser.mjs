// Real Nursery controls, authentication, API and disposable SQLite. Never live storage.
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

const waiting = 'Saving could not be confirmed. Your pumping session is kept. Retry the saved request.';
const storageError = 'This browser could not keep your pumping session. Keep this page open and free storage before retrying.';
const counts = async db => ({ pumps: await db.pumpLog.count(), feeds: await db.feedLog.count(), receipts: await db.externalImportRecord.count() });

export async function verifyNurseryPumpRecovery({ base, db, family, baby, caretaker, token, secret, context }) {
  assert.equal(new URL(base).hostname, '127.0.0.1', 'Nursery acceptance only uses the owned local server');
  const browser = context.browser();
  const checks = [], errors = [];
  const scope = JSON.stringify([family.id, `caretaker:${caretaker.id}`, baby.id]);
  const key = `nurseryPumpSessionV2:${scope}`;
  const before = await counts(db);
  const previousSettings = await db.settings.findFirstOrThrow({ where: { familyId: family.id },
    select: { enableBreastMilkTracking: true, defaultBottleUnit: true } });
  await db.settings.updateMany({ where: { familyId: family.id }, data: { enableBreastMilkTracking: true, defaultBottleUnit: 'ML' } });
  const sibling = await db.baby.create({ data: { id: 'nursery-browser-sibling', familyId: family.id,
    firstName: 'Nursery Sibling', lastName: 'Synthetic', birthDate: new Date('2026-01-01Z') } });
  const peer = await db.caretaker.create({ data: { id: 'nursery-browser-peer', familyId: family.id,
    name: 'Other Synthetic Caregiver', loginId: 'nursery-peer', role: 'ADMIN', type: 'parent', securityPin: '123456', lastSeenVersion: '1.6.7' } });
  const peerToken = jwt.sign({ id: peer.id, familyId: family.id, name: peer.name, role: 'ADMIN', type: 'parent', familySlug: family.slug }, secret, { expiresIn: '10m' });
  const options = { viewport: { width: 412, height: 915 }, timezoneId: 'America/Chicago' };
  let owned = await browser.newContext(options), page;
  const initialize = target => target.addInitScript(({ token, family, baby, caretakerId }) => {
    localStorage.setItem('authToken', token); localStorage.setItem('unlockTime', String(Date.now()));
    localStorage.setItem('caretakerId', caretakerId); localStorage.setItem('isAdmin', 'true');
    localStorage.setItem('selectedFamily', JSON.stringify(family));
    localStorage.setItem(`selectedBaby_${family.id}`, JSON.stringify(baby));
  }, { token, family, baby, caretakerId: caretaker.id });
  const open = async () => {
    page = await owned.newPage(); page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(30_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.setFixedTime(new Date('2026-10-22T13:00:00Z'));
    await page.goto(`${base}/${family.slug}/nursery-mode`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Switch Baby', exact: true }).click();
    await page.getByRole('option', { name: baby.firstName, exact: true }).click();
  };
  const pumpFor = target => target.locator('.nursery-card').filter({ has: target.getByRole('heading', { name: 'Pump', exact: true }) });
  const pump = () => pumpFor(page);
  const read = target => target.evaluate(key => JSON.parse(localStorage.getItem(key) || 'null'), key);
  const alert = text => pump().getByRole('alert').filter({ hasText: text }).waitFor();
  const values = async (left, right, disabled = false) => {
    assert.equal(await pump().locator('input').nth(0).inputValue(), left);
    assert.equal(await pump().locator('input').nth(1).inputValue(), right);
    assert.equal(await pump().locator('input').nth(0).isDisabled(), disabled);
  };
  const switchBaby = async child => {
    await page.getByRole('button', { name: 'Switch Baby', exact: true }).click();
    await page.getByRole('option', { name: child.firstName, exact: true }).click();
  };
  const stock = async () => {
    const response = await fetch(`${base}/api/breast-milk-balance?babyId=${baby.id}&unit=ML`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200); return (await response.json()).data.balance;
  };
  let releaseHeld;
  try {
    const stockBefore = await stock();
    await initialize(owned); await open();
    await pump().getByRole('button', { name: 'Start Left', exact: true }).click();
    await page.clock.setFixedTime(new Date('2026-10-22T13:02:00Z'));
    await pump().getByRole('button', { name: 'Switch', exact: true }).click();
    await page.clock.setFixedTime(new Date('2026-10-22T13:06:00Z'));
    await pump().getByRole('button', { name: 'Stop', exact: true }).click();
    await pump().locator('input').nth(0).fill('-1'); await pump().locator('input').nth(1).fill('55');
    await pump().getByRole('button', { name: 'Fed', exact: true }).click();
    await alert('Enter a valid non-negative pumping amount.');
    const original = await read(page);
    assert.ok(original, `The initial session must be durable: ${JSON.stringify(await page.evaluate(() => ({ secure: isSecureContext, locks: !!navigator.locks,
      drafts: Object.keys(localStorage).filter(key => key.startsWith('nurseryPumpSession')).map(key => [key, localStorage.getItem(key)]) })))}`);
    assert.equal(original.phase, 'selecting_action'); assert.equal(original.pumpAction, 'FED');
    assert.equal(original.sideDuration.left, 120); assert.equal(original.elapsed, 240);
    await page.reload({ waitUntil: 'networkidle' }); await values('-1', '55');
    assert.deepEqual(await counts(db), before);
    checks.push('Nursery validation keeps both amounts, original start/stop, side durations and chosen disposition through reload');

    let rejectedStatus = 400;
    const rejectedBodies = [];
    const reject = async route => {
      if (route.request().method() !== 'POST') return route.continue();
      rejectedBodies.push(route.request().postDataJSON());
      return route.fulfill({ status: rejectedStatus, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Synthetic rejected pumping save' }) });
    };
    await page.route('**/api/pump-log', reject);
    await pump().locator('input').nth(0).fill('45');
    await pump().getByRole('button', { name: 'Fed', exact: true }).click();
    await alert('Synthetic rejected pumping save'); await values('45', '55');
    await page.screenshot({ path: 'test-results/nursery-pump-rejected-save.png' });
    assert.equal((await read(page)).requestId, original.requestId);
    assert.equal(await page.getByText('Pump logged', { exact: true }).count(), 0);
    await db.settings.updateMany({ where: { familyId: family.id }, data: { defaultBottleUnit: 'OZ' } });
    await page.reload({ waitUntil: 'networkidle' }); await values('45', '55');
    assert.equal((await read(page)).unitAbbr, 'ML', 'Changing preferences must not reinterpret an existing amount');
    rejectedStatus = 403;
    await pump().getByRole('button', { name: 'Fed', exact: true }).click();
    await alert('Sign in again to save this pumping session. Your input has been kept.'); await values('45', '55');
    assert.deepEqual(await counts(db), before);

    // A real expired token follows the application's refresh/logout path; the
    // owner-scoped draft must remain available on the subsequent sign-in.
    await page.unroute('**/api/pump-log', reject);
    const expired = jwt.sign({ id: caretaker.id, familyId: family.id, role: 'ADMIN', type: 'parent' }, secret, { expiresIn: -1 });
    await page.evaluate(value => localStorage.setItem('authToken', value), expired);
    const unauthorized = page.waitForResponse(response => response.url() === `${base}/api/pump-log` && response.request().method() === 'POST');
    await pump().getByRole('button', { name: 'Fed', exact: true }).click();
    assert.equal((await unauthorized).status(), 401);
    await page.waitForURL(url => url.searchParams.get('src') === 'logout-401');
    assert.equal((await read(page)).requestId, original.requestId);
    await page.goto(`${base}/${family.slug}/nursery-mode`, { waitUntil: 'networkidle' }); await values('45', '55');
    checks.push('400/403 rejection and real expired-auth logout preserve the draft, show useful feedback and never report a false success');

    // A different caregiver and a different selected child never inherit or
    // submit the original caregiver's session.
    await page.evaluate(value => { localStorage.setItem('authToken', value); window.dispatchEvent(new StorageEvent('storage', { key: 'authToken' })); }, peerToken);
    await pump().getByRole('button', { name: 'Start Both', exact: true }).waitFor();
    assert.equal((await read(page)).requestId, original.requestId);
    await page.evaluate(value => { localStorage.setItem('authToken', value); window.dispatchEvent(new StorageEvent('storage', { key: 'authToken' })); }, token);
    await pump().getByRole('button', { name: 'Fed', exact: true }).waitFor(); await values('45', '55');
    await switchBaby(sibling); await pump().getByRole('button', { name: 'Start Both', exact: true }).waitFor();
    await switchBaby(baby); await pump().getByRole('button', { name: 'Fed', exact: true }).waitFor(); await values('45', '55');
    checks.push('Caregiver and child switches isolate the session and restore original attribution when returning');

    rejectedStatus = 500; await page.route('**/api/pump-log', reject);
    await pump().getByRole('button', { name: 'Fed', exact: true }).click(); await alert(waiting); await values('45', '55', true);
    await page.waitForFunction(() => [...document.querySelectorAll('.nursery-card.question .nursery-card-actions button')].every(button => {
      const rect = button.getBoundingClientRect(); return rect.left >= -1 && rect.right <= innerWidth + 1;
    }), undefined, { timeout: 3000 });
    await page.screenshot({ path: 'test-results/nursery-pump-pending-recovery.png' });
    const frozen = await read(page); assert.equal(frozen.pending.requestId, original.requestId);
    await page.unroute('**/api/pump-log', reject);
    const timedOut = new Promise(resolve => { releaseHeld = resolve; });
    const stall = async route => {
      if (route.request().method() !== 'POST') return route.continue();
      await timedOut; await route.abort('failed').catch(() => {});
    };
    await page.route('**/api/pump-log', stall);
    const timeoutStarted = Date.now();
    await pump().getByRole('button', { name: 'Retry saved pumping session', exact: true }).click();
    await pump().getByRole('alert').filter({ hasText: waiting }).waitFor({ timeout: 25_000 });
    assert.ok(Date.now() - timeoutStarted >= 19_000, 'The actual request timeout must fire while the response is held');
    releaseHeld(); releaseHeld = null; await page.unroute('**/api/pump-log', stall);
    assert.deepEqual((await read(page)).pending, frozen.pending); assert.deepEqual(await counts(db), before);
    await owned.setOffline(true);
    await pump().getByRole('button', { name: 'Retry saved pumping session', exact: true }).click(); await alert(waiting);
    assert.deepEqual((await read(page)).pending, frozen.pending); assert.deepEqual(await counts(db), before);
    const state = await owned.storageState(); await owned.close();
    owned = await browser.newContext({ ...options, storageState: state }); await initialize(owned); await open();
    await alert(waiting); await values('45', '55', true);
    assert.deepEqual((await read(page)).pending, frozen.pending); assert.deepEqual(await counts(db), before);
    checks.push('Server failure, actual request timeout and offline retry retain one frozen request across a complete browser-context restart without automatic resubmission');

    let committed;
    const loseResponse = async route => {
      if (route.request().method() !== 'POST') return route.continue();
      assert.deepEqual(route.request().postDataJSON(), frozen.pending);
      const response = await route.fetch(); assert.equal(response.status(), 200);
      committed = await response.json(); await route.abort('failed');
    };
    await page.route('**/api/pump-log', loseResponse);
    await pump().getByRole('button', { name: 'Retry saved pumping session', exact: true }).click(); await alert(waiting);
    assert.ok(committed?.data?.id, 'Response must be lost after the real transaction commits');
    const afterCommit = { pumps: before.pumps + 1, feeds: before.feeds + 1, receipts: before.receipts + 1 };
    assert.deepEqual(await counts(db), afterCommit);
    const saved = await db.pumpLog.findUniqueOrThrow({ where: { id: committed.data.id } });
    assert.equal(saved.babyId, baby.id); assert.equal(saved.caretakerId, caretaker.id);
    assert.equal(saved.startTime.toISOString(), original.startTime); assert.equal(saved.endTime.toISOString(), original.endTime);
    assert.equal(saved.duration, 6); assert.equal(saved.totalAmount, 100); assert.equal(saved.unitAbbr, 'ML'); assert.equal(saved.pumpAction, 'FED');
    const linked = await db.feedLog.findMany({ where: { sourcePumpId: saved.id } });
    assert.equal(linked.length, 1); assert.equal(linked[0].amount, 100); assert.equal(linked[0].caretakerId, caretaker.id);
    assert.equal(await stock(), stockBefore);
    await page.unroute('**/api/pump-log', loseResponse);
    rejectedStatus = 403; await page.route('**/api/pump-log', reject);
    await pump().getByRole('button', { name: 'Retry saved pumping session', exact: true }).click();
    await alert('Sign in again to save this pumping session. Your input has been kept.');
    await values('45', '55', true); assert.deepEqual((await read(page)).pending, frozen.pending);
    await page.unroute('**/api/pump-log', reject);
    await page.reload({ waitUntil: 'networkidle' }); await alert(waiting);
    await page.clock.setFixedTime(new Date('2026-10-23T18:00:00Z'));
    const replay = page.waitForResponse(response => response.url() === `${base}/api/pump-log` && response.request().method() === 'POST');
    await pump().getByRole('button', { name: 'Retry saved pumping session', exact: true }).click();
    const replayResponse = await replay; assert.equal(replayResponse.status(), 200);
    assert.deepEqual(replayResponse.request().postDataJSON(), frozen.pending); assert.equal((await replayResponse.json()).data.id, saved.id);
    await pump().getByRole('button', { name: 'Start Both', exact: true }).waitFor();
    assert.equal(await read(page), null); assert.deepEqual(await counts(db), afterCommit);
    assert.deepEqual(await db.pumpLog.findUniqueOrThrow({ where: { id: saved.id } }), saved);
    assert.deepEqual(await db.feedLog.findMany({ where: { sourcePumpId: saved.id } }), linked); assert.equal(await stock(), stockBefore);
    checks.push('Lost successful response retries the exact original request after reload and a later clock, producing one pump/feed with unchanged time, inventory and caregiver');

    await db.settings.updateMany({ where: { familyId: family.id }, data: { defaultBottleUnit: 'ML' } });
    await page.reload({ waitUntil: 'networkidle' });
    await pump().getByRole('button', { name: 'Start Both', exact: true }).click();
    await pump().getByRole('button', { name: 'Stop', exact: true }).click();
    await pump().locator('input').nth(0).fill('20'); await pump().locator('input').nth(1).fill('30');
    const preStorage = await read(page);
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      window.__nurseryRestoreStorage = () => { Storage.prototype.setItem = original; };
      Storage.prototype.setItem = function(key, value) { if (key.startsWith('nurseryPumpSessionV2:')) throw new DOMException('Synthetic quota', 'QuotaExceededError'); return original.call(this, key, value); };
    });
    let sent = 0;
    const countPosts = request => { if (request.url() === `${base}/api/pump-log` && request.method() === 'POST') sent++; };
    page.on('request', countPosts);
    await pump().getByRole('button', { name: 'Stored', exact: true }).click(); await alert(storageError);
    await values('20', '30'); assert.equal(sent, 0, 'An unpersisted request must not be sent');
    await page.evaluate(() => window.__nurseryRestoreStorage()); page.off('request', countPosts);
    assert.equal((await read(page)).requestId, preStorage.requestId);
    checks.push('Storage quota failure keeps visible input and blocks network dispatch before losing the retry identity');
    await page.evaluate(() => {
      const original = navigator.locks;
      window.__nurseryRestoreLocks = () => Object.defineProperty(navigator, 'locks', { configurable: true, value: original });
      Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    });
    page.on('request', countPosts);
    await pump().getByRole('button', { name: 'Stored', exact: true }).click();
    await alert('This browser cannot safely coordinate saved pumping sessions.'); await values('20', '30');
    assert.equal(sent, 0, 'No POST may bypass unavailable cross-tab serialization');
    await page.evaluate(() => window.__nurseryRestoreLocks()); page.off('request', countPosts);
    checks.push('Unavailable Web Locks explains the browser limitation and blocks unsafe dispatch while retaining the visible draft');

    // Hold tab A's definitive rejection while tab B deliberately dismisses its
    // draft and starts another session. Tab A must adopt, never overwrite B.
    let captured;
    const held = new Promise(resolve => { releaseHeld = resolve; });
    await page.route('**/api/pump-log', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      captured = route.request().postDataJSON(); await held;
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Synthetic late rejection' }) });
    });
    await pump().getByRole('button', { name: 'Stored', exact: true }).click();
    await page.waitForFunction(key => !!JSON.parse(localStorage.getItem(key)).pending, key);
    const other = await owned.newPage(); other.setDefaultTimeout(15_000);
    await other.clock.setFixedTime(new Date('2026-10-23T18:00:00Z'));
    await other.goto(`${base}/${family.slug}/nursery-mode`, { waitUntil: 'networkidle' });
    const otherPump = pumpFor(other);
    other.once('dialog', dialog => { assert.match(dialog.message(), /does not delete any care records/); void dialog.accept(); });
    await otherPump.getByRole('button', { name: 'Dismiss saved session', exact: true }).click();
    await otherPump.getByRole('button', { name: 'Start Both', exact: true }).click();
    await otherPump.getByRole('button', { name: 'Stop', exact: true }).click();
    await other.waitForFunction(([key, requestId]) => {
      const saved = JSON.parse(localStorage.getItem(key) || 'null');
      return saved?.phase === 'selecting_action' && saved?.requestId !== requestId;
    }, [key, captured.requestId]);
    // Force the exact ordering that used to echo A's adopted blank snapshot
    // over B's queued input edits. The production Web Lock is used, not mocked.
    await other.evaluate(async key => {
      let acquired;
      const ready = new Promise(resolve => { acquired = resolve; });
      const hold = new Promise(resolve => { window.__releaseNurseryLock = resolve; });
      void navigator.locks.request(key, async () => { acquired(); await hold; });
      await ready;
    }, key);
    await otherPump.locator('input').nth(0).fill('70'); await otherPump.locator('input').nth(1).fill('80');
    await other.waitForFunction(async key => (await navigator.locks.query()).pending.filter(lock => lock.name === key).length >= 2, key);
    const newer = await read(other); assert.notEqual(newer.requestId, captured.requestId);
    releaseHeld(); releaseHeld = null;
    await alert('A newer pumping session is saved on this browser. It has been kept.');
    await other.evaluate(() => window.__releaseNurseryLock());
    await other.waitForFunction(async key => {
      const locks = await navigator.locks.query();
      return ![...locks.pending, ...locks.held].some(lock => lock.name === key);
    }, key);
    assert.deepEqual(await read(page), { ...newer, amountLeft: '70', amountRight: '80' });
    await page.waitForFunction(() => [...document.querySelectorAll('.nursery-amount-field input')].map(input => input.value).join(',') === '70,80');
    await values('70', '80'); assert.deepEqual(await counts(db), afterCommit);
    await page.unroute('**/api/pump-log');
    await other.close();
    checks.push('Real cross-tab Web Lock interleaving prevents a late rejection or adopted snapshot from overwriting newer input; deliberate local dismissal never deletes care records');

    // Storage can become unreadable after dispatch. A missing key and a failed
    // read are not interchangeable; keep the only in-memory copy on failure.
    await page.route('**/api/pump-log', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      await page.evaluate(() => {
        const original = Storage.prototype.getItem;
        window.__nurseryRestoreRead = () => { Storage.prototype.getItem = original; };
        Storage.prototype.getItem = function(key) { if (key.startsWith('nurseryPumpSessionV2:')) throw new DOMException('Synthetic blocked storage', 'SecurityError'); return original.call(this, key); };
      });
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false }) });
    });
    await pump().getByRole('button', { name: 'Stored', exact: true }).click(); await alert(waiting); await values('70', '80', true);
    await page.evaluate(() => window.__nurseryRestoreRead()); await page.unroute('**/api/pump-log');
    await page.reload({ waitUntil: 'networkidle' }); await alert(waiting); await values('70', '80', true);
    await pump().getByRole('button', { name: 'Retry saved pumping session', exact: true }).click();
    await pump().getByRole('button', { name: 'Start Both', exact: true }).waitFor();
    assert.deepEqual(await counts(db), { pumps: before.pumps + 2, feeds: before.feeds + 1, receipts: before.receipts + 2 });
    assert.equal(await stock(), stockBefore + 150);
    checks.push('An unreadable local draft after server failure retains the in-memory fields; restored storage and manual retry save one correct stock entry');

    const legacyKey = `nurseryPumpSessionV1:${baby.id}`;
    const legacy = { phase: 'paused', activeSide: 'both', startTime: '2026-10-23T17:50:00.000Z',
      sideDuration: { left: 0, right: 0 }, pauseAccumulated: 180, resumeTime: null, elapsed: 180, amountLeft: '12', amountRight: '13' };
    await page.evaluate(({ key, legacy }) => localStorage.setItem(key, JSON.stringify(legacy)), { key: legacyKey, legacy });
    await page.reload({ waitUntil: 'networkidle' });
    await pump().getByRole('button', { name: 'Review in mL as this caregiver', exact: true }).waitFor();
    assert.equal(await read(page), null, 'An unscoped legacy timer must not silently acquire a caregiver');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.locator('.nursery-drawer').getByRole('button', { name: 'Big Tiles', exact: true }).click();
    await page.locator('.nursery-drawer').getByRole('button', { name: 'Close', exact: true }).click();
    const tile = page.locator('.nursery-tile').filter({ has: page.locator('.tlabel').filter({ hasText: /^Pump$/ }) });
    await tile.locator('.tmain').click();
    const modal = page.getByRole('dialog', { name: 'Pump', exact: true });
    await modal.getByRole('button', { name: 'Review in mL as this caregiver', exact: true }).click();
    await modal.getByRole('button', { name: 'Stop', exact: true }).click();
    assert.equal(await modal.locator('input').nth(0).inputValue(), '12'); assert.equal(await modal.locator('input').nth(1).inputValue(), '13');
    rejectedStatus = 403; await page.route('**/api/pump-log', reject);
    await modal.getByRole('button', { name: 'Stored', exact: true }).click();
    await modal.getByRole('alert').filter({ hasText: 'Sign in again to save this pumping session.' }).waitFor();
    assert.equal(await modal.isVisible(), true, 'A failed Big Tiles save must keep its amount dialog open');
    assert.equal(await modal.locator('input').nth(0).inputValue(), '12');
    await page.screenshot({ path: 'test-results/nursery-pump-modal-recovery.png' });
    await page.unroute('**/api/pump-log', reject);
    const legacySaved = page.waitForResponse(response => response.url() === `${base}/api/pump-log` && response.request().method() === 'POST');
    await modal.getByRole('button', { name: 'Stored', exact: true }).click();
    assert.equal((await legacySaved).status(), 200);
    await page.waitForFunction(([current, old]) => localStorage.getItem(current) === null && localStorage.getItem(old) === null, [key, legacyKey]);
    assert.deepEqual(await counts(db), { pumps: before.pumps + 3, feeds: before.feeds + 1, receipts: before.receipts + 3 });
    assert.equal(await stock(), stockBefore + 175);
    checks.push('Legacy timers require explicit caregiver/unit review; Big Tiles keeps the amount dialog open after rejection and clears both drafts only after confirmed saving');
    assert.deepEqual(errors, []);
    return checks;
  } catch (error) {
    error.message = `Nursery recovery after ${checks.at(-1) || 'initial timer'}: ${error.message}`;
    throw error;
  } finally {
    releaseHeld?.();
    await owned.setOffline(false).catch(() => {});
    await owned.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    for (const target of owned.pages()) await target.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    await owned.close();
    await db.settings.updateMany({ where: { familyId: family.id }, data: previousSettings });
  }
}
