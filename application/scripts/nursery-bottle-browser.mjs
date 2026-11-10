// Actual nursery controls + IndexedDB + JWT HTTP + disposable SQLite only.
import assert from 'node:assert/strict';
import path from 'node:path';
import jwt from 'jsonwebtoken';

export async function verifyNurseryBottle({ base, db, family, caretaker, token, secret, context }) {
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(family.name, /synthetic/i);
  const checks = [], errors = [];
  const previousSettings = await db.settings.findFirstOrThrow({ where: { familyId: family.id }, select: { defaultBottleUnit: true, nurseryModeSettings: true } });
  await db.settings.updateMany({ where: { familyId: family.id }, data: { defaultBottleUnit: 'ML' } });
  const baby = await db.baby.create({ data: { id: 'nursery-bottle-child', familyId: family.id,
    firstName: 'Bottle Review', lastName: 'Synthetic', birthDate: new Date('2026-01-01Z') } });
  const sibling = await db.baby.create({ data: { id: 'nursery-bottle-sibling', familyId: family.id,
    firstName: 'Bottle Sibling', lastName: 'Synthetic', birthDate: new Date('2026-01-02Z') } });
  const peer = await db.caretaker.create({ data: { id: 'nursery-bottle-peer', familyId: family.id,
    name: 'Synthetic Bottle Caregiver', loginId: 'bottle-peer', role: 'ADMIN', type: 'parent', securityPin: 'synthetic-only', lastSeenVersion: '1.6.7' } });
  const peerToken = jwt.sign({ id: peer.id, name: peer.name, role: 'ADMIN', type: 'parent', familyId: family.id, familySlug: family.slug }, secret, { expiresIn: '10m' });
  await db.feedLog.createMany({ data: [
    { familyId: family.id, babyId: baby.id, caretakerId: caretaker.id, type: 'BOTTLE', time: new Date('2026-10-21T14:00:00Z'), amount: 120, unitAbbr: 'ML', bottleType: 'Formula' },
    { familyId: family.id, babyId: baby.id, caretakerId: caretaker.id, type: 'BOTTLE', time: new Date('2026-10-21T15:00:00Z'), amount: 4, unitAbbr: 'OZ', bottleType: 'Formula' },
  ] });
  const owned = await context.browser().newContext({ viewport: { width: 412, height: 915 }, timezoneId: 'America/Chicago', serviceWorkers: 'block' });
  await owned.addInitScript(({ token, family, baby, caretakerId }) => {
    if (!localStorage.getItem('authToken')) {
      localStorage.setItem('authToken', token); localStorage.setItem('caretakerId', caretakerId);
      localStorage.setItem('isAdmin', 'true'); localStorage.setItem('selectedFamily', JSON.stringify(family));
      localStorage.setItem(`selectedBaby_${family.id}`, JSON.stringify(baby));
    }
    localStorage.setItem('unlockTime', String(Date.now()));
  }, { token, family, baby, caretakerId: caretaker.id });
  const page = await owned.newPage(); page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(30_000);
  page.on('pageerror', error => errors.push(error.message));
  const feed = () => page.locator('.nursery-card').filter({ has: page.getByRole('heading', { name: 'Feed', exact: true }) });
  const dialog = () => page.getByRole('dialog', { name: 'Add bottle', exact: true });
  const form = () => dialog().getByRole('form', { name: 'Add bottle', exact: true });
  const pending = () => dialog().getByRole('region', { name: 'Pending bottles on this browser', exact: true });
  const bottleCount = () => db.feedLog.count({ where: { familyId: family.id, babyId: baby.id, type: 'BOTTLE' } });
  const choose = async child => {
    await page.getByRole('button', { name: 'Switch Baby', exact: true }).click();
    await page.getByRole('option', { name: child.firstName, exact: true }).click();
  };
  const load = async child => {
    await page.goto(`${base}/${family.slug}/nursery-mode`, { waitUntil: 'networkidle' });
    // Deliberately select the fixture through the real child switcher.
    await choose(child);
  };
  const open = async () => {
    await feed().getByRole('button', { name: 'Bottle', exact: true }).click();
    await dialog().waitFor();
  };
  const close = () => dialog().getByRole('button', { name: 'Close', exact: true }).click();
  const input = () => form().getByRole('spinbutton', { name: /^Consumed/ });
  const rows = () => page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('sat-tracker-journal-outbox-v1', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try { return await new Promise((resolve, reject) => {
      const request = database.transaction('bottles').objectStore('bottles').getAll();
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    }); } finally { database.close(); }
  });
  const firstPost = () => page.waitForResponse(response => response.url() === `${base}/api/bottle-journal` && response.request().method() === 'POST');
  const fill = async (amount, milk) => {
    await input().fill(String(amount));
    await form().getByLabel('Milk type', { exact: true }).selectOption(milk);
  };
  let targetPosts = 0, directFeedPosts = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && request.url() === `${base}/api/bottle-journal`) targetPosts++;
    if (request.method() === 'POST' && request.url() === `${base}/api/feed-log`) directFeedPosts++;
  });
  try {
    await page.clock.setFixedTime(new Date('2026-10-24T13:00:00Z'));
    await load(baby);
    // Other acceptance modules exercise Big Tiles with this caregiver. Choose
    // the starting layout deliberately through the same controls caregivers use.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const cardsSaved = page.waitForResponse(response => response.url() === `${base}/api/nursery-mode-settings` && response.request().method() === 'POST');
    await page.locator('.nursery-drawer').getByRole('button', { name: 'Cards', exact: true }).click();
    await page.locator('.nursery-drawer').getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal((await cardsSaved).status(), 200);
    await open();
    await dialog().getByText(baby.firstName, { exact: true }).waitFor();
    assert.equal(await input().inputValue(), '');
    assert.equal(await form().getByLabel('Milk type', { exact: true }).inputValue(), '');
    assert.equal(await form().getByLabel('Volume unit', { exact: true }).inputValue(), 'ML');
    assert.equal(await bottleCount(), 2); assert.equal(targetPosts, 0);
    await input().fill('37.5');
    await form().getByRole('button', { name: 'Save bottle', exact: true }).click();
    assert.equal(await form().getByLabel('Milk type', { exact: true }).evaluate(select => select.validity.valueMissing), true);
    assert.equal(targetPosts, 0); assert.equal(await bottleCount(), 2);
    await form().getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog().waitFor({ state: 'detached' });
    assert.equal((await rows()).length, 0); assert.equal(await bottleCount(), 2);
    checks.push('Nursery mixed-unit history never supplies an amount or milk type; required review and Cancel perform no canonical or queued write');

    await open(); await fill(37.5, 'Breast Milk');
    await page.screenshot({ path: path.join(process.cwd(), 'test-results', 'nursery-bottle-phone.png'), fullPage: true });
    await db.settings.updateMany({ where: { familyId: family.id }, data: { defaultBottleUnit: 'OZ' } });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(key => localStorage.getItem(key) === 'OZ', `sprout-track.defaultBottleUnit:${family.id}`);
    assert.equal(await input().inputValue(), '37.5');
    assert.equal(await form().getByLabel('Volume unit', { exact: true }).inputValue(), 'ML');
    const measuredResponse = firstPost();
    await form().getByRole('button', { name: 'Save bottle', exact: true }).click();
    const measured = await measuredResponse; assert.equal(measured.status(), 200);
    const measuredId = (await measured.json()).data.id;
    assert.deepEqual(measured.request().postDataJSON().bottle, {
      time: '2026-10-24T13:00:00.000Z', amount: 37.5, offeredAmount: null, unitAbbr: 'ML', bottleType: 'Breast Milk',
      formulaKcalOz: null, formulaName: null, bottleLabel: null, notes: null, sourceCaregiverName: null,
    });
    assert.equal((await db.feedLog.findUniqueOrThrow({ where: { id: measuredId } })).caretakerId, caretaker.id);
    await dialog().getByText('Bottle saved.', { exact: true }).waitFor();
    await form().waitFor({ state: 'detached' });
    assert.equal(await form().count(), 0, 'Confirmed result replaces the entry form');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.equal(directFeedPosts, 0);
    checks.push('A visible reviewed unit stays fixed across preference changes; an explicit 37.5 ML breast-milk save uses the durable journal and original caregiver');

    await close(); await open();
    assert.equal(await form().getByLabel('Volume unit', { exact: true }).inputValue(), 'OZ');
    await owned.setOffline(true); await fill(2.25, 'Formula');
    await form().getByRole('button', { name: 'Save bottle', exact: true }).click();
    await dialog().getByText('Bottle saved on this browser. Waiting for server confirmation.', { exact: true }).waitFor();
    await pending().getByText('2.25 OZ', { exact: true }).waitFor();
    await pending().getByText('Milk type: Formula', { exact: true }).waitFor();
    const queued = (await rows())[0];
    assert.equal(queued.babyId, baby.id); assert.equal(queued.bottle.bottleType, 'Formula');
    assert.equal(queued.scope, JSON.stringify([family.id, `caretaker:${caretaker.id}`, baby.id]));
    assert.equal(JSON.stringify(queued).includes(token), false); assert.equal(await bottleCount(), 3);
    const blockWrites = route => route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue();
    await page.route('**/api/bottle-journal', blockWrites);
    await owned.setOffline(false); await load(baby); await open();
    await pending().getByText('2.25 OZ', { exact: true }).waitFor();
    assert.equal((await rows())[0].requestId, queued.requestId);
    assert.deepEqual((await rows())[0].bottle, queued.bottle);
    checks.push('A real disconnection stores the exact nursery bottle locally; reload restores its quantity, chosen unit, milk type, original time and stable UUID');

    await close(); await choose(sibling); await open();
    assert.equal(await pending().count(), 0); assert.equal((await rows())[0].requestId, queued.requestId);
    await close();
    await page.evaluate(({ value, id }) => { localStorage.setItem('authToken', value); localStorage.setItem('caretakerId', id); }, { value: peerToken, id: peer.id });
    await load(baby); await open();
    assert.equal(await pending().count(), 0); assert.equal((await rows())[0].requestId, queued.requestId);
    assert.equal(await bottleCount(), 3);
    await close();
    await page.evaluate(({ value, id }) => { localStorage.setItem('authToken', value); localStorage.setItem('caretakerId', id); }, { value: token, id: caretaker.id });
    await load(baby); await open(); await pending().getByText('2.25 OZ', { exact: true }).waitFor();
    checks.push('The actual nursery child switcher and another signed-in caregiver cannot expose or submit the original bottle queue');

    // Recovery must stay reachable even when the breast timer owns the Feed tile.
    await page.clock.setFixedTime(new Date());
    const activeResponse = await fetch(`${base}/api/active-breastfeed`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ babyId: baby.id, side: 'LEFT' }), signal: AbortSignal.timeout(5000) });
    assert.equal(activeResponse.status, 200);
    const active = (await activeResponse.json()).data;
    await close(); await load(baby);
    await feed().getByRole('button', { name: 'Pending bottles on this browser', exact: true }).click();
    await pending().getByText('2.25 OZ', { exact: true }).waitFor();
    assert.ok(await db.activeBreastFeed.findUnique({ where: { id: active.id } }), 'Reviewing bottles must preserve the breast timer');
    await close();
    // Remove only this synthetic timer fixture; finalization has its own gate.
    await db.activeBreastFeed.delete({ where: { id: active.id } });
    await page.clock.setFixedTime(new Date('2026-10-24T13:00:00Z'));
    await load(baby); await open();
    await page.unroute('**/api/bottle-journal', blockWrites);
    const resumedResponse = firstPost();
    await pending().getByRole('button', { name: 'Retry this entry', exact: true }).click();
    assert.equal((await resumedResponse).status(), 200);
    await pending().waitFor({ state: 'detached' });
    const restored = await db.feedLog.findUniqueOrThrow({ where: { id: queued.requestId } });
    assert.equal(restored.amount, 2.25); assert.equal(restored.unitAbbr, 'OZ'); assert.equal(restored.bottleType, 'Formula');
    assert.equal(restored.time.toISOString(), queued.bottle.time); assert.equal(restored.caretakerId, caretaker.id);
    assert.equal(await bottleCount(), 4);
    checks.push('Pending bottle recovery remains available during an active breast timer and confirms one original bottle after reconnection');

    await close(); await open(); await fill(1.75, 'Other');
    let lost = false;
    const loseResponse = async route => {
      if (route.request().method() !== 'POST') return route.continue();
      if (!lost) { const response = await route.fetch(); assert.equal(response.status(), 200); lost = true; }
      await route.abort('failed');
    };
    await page.route('**/api/bottle-journal', loseResponse);
    await form().getByRole('button', { name: 'Save bottle', exact: true }).click();
    await dialog().getByText('Bottle saved on this browser. Waiting for server confirmation.', { exact: true }).waitFor();
    assert.equal(lost, true); const lostRow = (await rows())[0];
    const savedBeforeRetry = await db.feedLog.findUniqueOrThrow({ where: { id: lostRow.requestId } });
    await load(baby); await open(); await pending().getByText('1.75 OZ', { exact: true }).waitFor();
    await page.clock.setFixedTime(new Date('2026-10-24T14:00:00Z'));
    await page.unroute('**/api/bottle-journal', loseResponse);
    const replayResponse = firstPost();
    await pending().getByRole('button', { name: 'Retry this entry', exact: true }).click();
    assert.equal((await replayResponse).status(), 200); await pending().waitFor({ state: 'detached' });
    assert.deepEqual(await db.feedLog.findUniqueOrThrow({ where: { id: lostRow.requestId } }), savedBeforeRetry);
    assert.equal(await db.externalImportRecord.count({ where: { familyId: family.id, providerId: 'sat-tracker-journal', sourceRecordId: lostRow.requestId } }), 1);
    assert.equal(await bottleCount(), 5);
    checks.push('A lost successful nursery response retries the original UUID and timestamp after reload and a later clock, without duplicate intake or provenance');

    await close(); await open(); await fill(15, 'Formula');
    const postsBeforeStorageFailure = targetPosts;
    await page.evaluate(() => {
      const original = IDBDatabase.prototype.transaction;
      window.__restoreBottleStorage = () => { IDBDatabase.prototype.transaction = original; };
      IDBDatabase.prototype.transaction = function(stores, mode, options) {
        if (mode === 'readwrite' && (stores === 'bottles' || Array.from(stores).includes('bottles'))) throw new DOMException('Storage is full', 'QuotaExceededError');
        return original.call(this, stores, mode, options);
      };
    });
    await form().getByRole('button', { name: 'Save bottle', exact: true }).click();
    await dialog().getByRole('alert').filter({ hasText: 'Storage is full' }).first().waitFor();
    assert.equal(await input().inputValue(), '15'); assert.equal(await form().getByLabel('Milk type', { exact: true }).inputValue(), 'Formula');
    assert.equal(targetPosts, postsBeforeStorageFailure); assert.equal(await bottleCount(), 5);
    await page.evaluate(() => window.__restoreBottleStorage());
    const recoveredResponse = firstPost();
    await form().getByRole('button', { name: 'Save bottle', exact: true }).click();
    assert.equal((await recoveredResponse).status(), 200);
    await dialog().getByText('Bottle saved.', { exact: true }).waitFor();
    assert.equal(await bottleCount(), 6); assert.equal(directFeedPosts, 0);
    checks.push('A real IndexedDB write failure keeps nursery input and prevents network dispatch; explicit retry saves once after local storage recovers');

    await close(); await open(); await owned.setOffline(true); await fill(7, 'Formula');
    await form().getByRole('button', { name: 'Save bottle', exact: true }).click();
    await pending().getByText('7 OZ', { exact: true }).waitFor();
    const conflict = (await rows())[0];
    const competing = await fetch(`${base}/api/bottle-journal`, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify({ babyId: baby.id, requestId: conflict.requestId, expectedScope: conflict.scope,
      bottle: { ...conflict.bottle, amount: 9 } }), signal: AbortSignal.timeout(5000) });
    assert.equal(competing.status, 200); await competing.body?.cancel();
    await owned.setOffline(false);
    const review = 'Needs review. Check saved history and your access before retrying. Conflicting values will never overwrite a saved bottle.';
    await pending().getByText(review, { exact: true }).waitFor();
    await pending().getByRole('status').filter({ hasText: 'Needs review' }).waitFor();
    assert.equal((await rows())[0].state, 'blocked'); assert.equal((await rows())[0].status, 409);
    assert.deepEqual((await rows())[0].bottle, conflict.bottle);
    assert.equal((await db.feedLog.findUniqueOrThrow({ where: { id: conflict.requestId } })).amount, 9);
    const attempts = (await rows())[0].attempts;
    await load(baby); await open(); await pending().getByText(review, { exact: true }).waitFor();
    assert.equal((await rows())[0].attempts, attempts, 'Reload must not retry a blocked nursery entry');
    await close(); await page.setViewportSize({ width: 820, height: 1180 });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const layoutSaved = page.waitForResponse(response => response.url() === `${base}/api/nursery-mode-settings` && response.request().method() === 'POST');
    await page.locator('.nursery-drawer').getByRole('button', { name: 'Big Tiles', exact: true }).click();
    await page.locator('.nursery-drawer').getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal((await layoutSaved).status(), 200);
    const tile = page.locator('.nursery-tile').filter({ has: page.getByText('Feed', { exact: true }) });
    await tile.getByText('Pending bottles on this browser', { exact: true }).waitFor();
    await tile.locator('.tmain').click();
    await page.getByRole('dialog', { name: 'Feed', exact: true }).getByRole('button', { name: 'Bottle', exact: true }).click();
    await pending().getByText(review, { exact: true }).waitFor();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.screenshot({ path: path.join(process.cwd(), 'test-results', 'nursery-bottle-tablet.png'), fullPage: true });
    await pending().getByRole('button', { name: 'Discard pending entry', exact: true }).click();
    await pending().getByText('This may already be saved online. Discard only the local pending copy?', { exact: true }).waitFor();
    await pending().getByRole('button', { name: 'Confirm discard', exact: true }).click();
    await pending().waitFor({ state: 'detached' });
    assert.equal((await rows()).length, 0);
    assert.equal((await db.feedLog.findUniqueOrThrow({ where: { id: conflict.requestId } })).amount, 9);
    assert.equal(await bottleCount(), 7);
    checks.push('An actual nursery API conflict remains blocked through reload; visible review and confirmed local discard preserve the winning canonical bottle');
    await form().getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog().waitFor({ state: 'detached' });
    assert.equal((await rows()).length, 0); assert.equal(await bottleCount(), 7);
    checks.push('Cards and Big Tiles both open the accessible bottle dialog, surface pending recovery, fit phone/tablet widths and close Cancel without saving');
    assert.deepEqual(errors, [], 'Nursery bottle browser errors');
    return checks;
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await owned.close();
    await db.settings.updateMany({ where: { familyId: family.id }, data: previousSettings });
  }
}
