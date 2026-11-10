// Real Chromium/IndexedDB + HTTP + canonical SQLite acceptance. The caller must
// supply its fresh disposable application; never run against a deployed family.
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import jwt from 'jsonwebtoken';

export async function verifyJournalOutbox({ base, db, family, baby, caretaker, token, secret, scratch }) {
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  const profile = path.join(scratch, 'journal-outbox-browser-profile');
  const checks = [];
  let context;
  const url = `${base}/${family.slug}/bottle-journal`;
  const launch = async () => {
    context = await chromium.launchPersistentContext(profile, { headless: true,
      executablePath: process.env.BABYTRACKER_TEST_BROWSER_PATH || undefined,
      serviceWorkers: 'block', timezoneId: 'America/Chicago', viewport: { width: 412, height: 915 } });
    await context.addInitScript(({ token, family, baby, caretaker }) => {
      if (!localStorage.getItem('authToken')) {
        localStorage.setItem('authToken', token); localStorage.setItem('caretakerId', caretaker.id);
        localStorage.setItem('isAdmin', 'true'); localStorage.setItem('selectedFamily', JSON.stringify(family));
        localStorage.setItem(`selectedBaby_${family.id}`, JSON.stringify(baby));
      }
      localStorage.setItem('unlockTime', String(Date.now()));
    }, { token, family, baby, caretaker });
    return context.pages()[0] || await context.newPage();
  };
  const rows = page => page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('sat-tracker-journal-outbox-v1', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try { return await new Promise((resolve, reject) => {
      const request = db.transaction('bottles').objectStore('bottles').getAll();
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    }); } finally { db.close(); }
  });
  const fill = async (page, amount, time) => {
    const form = page.getByRole('form', { name: 'Add bottle', exact: true });
    await form.getByLabel('Feeding date and time', { exact: true }).fill(time);
    await form.getByRole('spinbutton', { name: /^Consumed/ }).fill(String(amount));
    await form.getByRole('button', { name: 'Save bottle', exact: true }).click();
  };
  const pending = page => page.getByRole('region', { name: 'Pending bottles on this browser', exact: true });
  const blockJournal = route => route.abort('internetdisconnected');
  const waitForCount = async count => {
    const deadline = Date.now() + 20_000;
    while (await db.feedLog.count() !== count) {
      if (Date.now() > deadline) throw new Error(`Expected ${count} canonical feeds after queued synchronization`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  const originalCount = await db.feedLog.count();
  try {
    let page = await launch();
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Bottle Journal', exact: true }).waitFor();
    await context.setOffline(true);
    await fill(page, 41, '2026-10-21T10:01');
    await pending(page).getByText('41 ML', { exact: true }).waitFor();
    assert.equal(await db.feedLog.count(), originalCount);
    const originalQueue = await rows(page);
    assert.equal(originalQueue.length, 1);
    assert.equal(JSON.stringify(originalQueue).includes(token), false, 'The outbox must never store auth tokens');
    const queuedId = originalQueue[0].requestId;
    checks.push('A real browser disconnection saves an unsent bottle locally without a canonical write');

    // The queue survives reload and a complete browser process restart. A cold
    // offline app shell is a separate requirement: serve shell/auth reads here,
    // while journal HTTP remains unavailable throughout both recovery steps.
    await context.route('**/api/bottle-journal*', blockJournal);
    await context.setOffline(false);
    await page.reload({ waitUntil: 'networkidle' });
    await pending(page).getByText('41 ML', { exact: true }).waitFor();
    await context.close(); context = undefined;
    page = await launch();
    await context.route('**/api/bottle-journal*', blockJournal);
    await page.goto(url, { waitUntil: 'networkidle' });
    await pending(page).getByText('41 ML', { exact: true }).waitFor();
    assert.equal((await rows(page))[0].requestId, queuedId);
    assert.equal(await db.feedLog.count(), originalCount);
    checks.push('IndexedDB retains the exact request through reload and persistent-profile browser restart');

    const second = await db.caretaker.create({ data: { familyId: family.id, loginId: '92', name: 'Synthetic second caregiver', role: 'ADMIN', type: 'parent', securityPin: 'synthetic-only', lastSeenVersion: '1.6.7' } });
    const otherToken = jwt.sign({ id: second.id, name: second.name, role: 'ADMIN', type: 'parent', familyId: family.id, familySlug: family.slug }, secret, { expiresIn: '10m' });
    await page.evaluate(({ value, id }) => { localStorage.setItem('authToken', value); localStorage.setItem('caretakerId', id); }, { value: otherToken, id: second.id });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Bottle Journal', exact: true }).waitFor();
    await context.unroute('**/api/bottle-journal*', blockJournal);
    await page.getByRole('button', { name: 'Sync now', exact: true }).click();
    await page.getByText('Last synced', { exact: false }).waitFor();
    assert.equal(await pending(page).count(), 0, 'Another caregiver must not see or submit the previous queue');
    assert.equal(await db.feedLog.count(), originalCount);
    assert.equal((await rows(page))[0].requestId, queuedId, 'Changing caregiver must retain the original local draft');
    const guarded = await fetch(`${base}/api/bottle-journal`, { method: 'POST', headers: { Authorization: `Bearer ${otherToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ babyId: baby.id, bottle: originalQueue[0].bottle, requestId: queuedId, expectedScope: originalQueue[0].scope }) });
    assert.equal(guarded.status, 409); await guarded.body?.cancel();
    assert.equal(await db.feedLog.count(), originalCount);
    checks.push('A different valid caregiver cannot see, auto-submit, or replay the original caregiver outbox through the real API');

    await page.evaluate(({ value, id }) => { localStorage.setItem('authToken', value); localStorage.setItem('caretakerId', id); }, { value: token, id: caretaker.id });
    await page.reload({ waitUntil: 'networkidle' });
    await waitForCount(originalCount + 1);
    await pending(page).waitFor({ state: 'detached' });
    const restored = await db.feedLog.findUniqueOrThrow({ where: { id: queuedId } });
    assert.equal(restored.amount, 41); assert.equal(restored.caretakerId, caretaker.id);
    assert.equal(restored.time.toISOString(), '2026-10-21T15:01:00.000Z');
    checks.push('Reconnect under the original caregiver creates exactly one canonical feed with original time and attribution');

    // Hold the response after a real successful server transaction, then destroy
    // its delivery. Retry the persisted UUID through UI, not a hand-built mock.
    let lost = false;
    const loseResponse = async route => {
      if (route.request().method() !== 'POST' || lost) return route.continue();
      const response = await route.fetch(); assert.equal(response.status(), 200);
      lost = true; await route.abort('failed');
    };
    await page.route('**/api/bottle-journal', loseResponse);
    await fill(page, 42, '2026-10-21T10:02');
    await page.getByText('Bottle saved on this browser. Waiting for server confirmation.', { exact: true }).waitFor();
    assert.equal(lost, true); await waitForCount(originalCount + 2);
    const lostId = (await rows(page))[0].requestId;
    await page.unroute('**/api/bottle-journal', loseResponse);
    await pending(page).getByRole('button', { name: 'Retry this entry', exact: true }).click();
    await pending(page).waitFor({ state: 'detached' });
    assert.equal(await db.feedLog.count(), originalCount + 2);
    assert.equal((await db.feedLog.findUniqueOrThrow({ where: { id: lostId } })).amount, 42);
    checks.push('Lost successful response retries the stored UUID without a duplicate FeedLog or provenance record');

    // Independent pages share IDB, but concurrent transactions cannot replace
    // each other's pending entries and send leases prevent simultaneous claims.
    const tab = await context.newPage(); await tab.goto(url, { waitUntil: 'networkidle' });
    await context.setOffline(true);
    await Promise.all([fill(page, 43, '2026-10-21T10:03'), fill(tab, 44, '2026-10-21T10:04')]);
    assert.equal((await rows(page)).length, 2);
    await context.setOffline(false);
    await waitForCount(originalCount + 4);
    await pending(page).waitFor({ state: 'detached' });
    await pending(tab).waitFor({ state: 'detached' });
    assert.equal(await db.externalImportRecord.count({ where: { sourceRecordId: queuedId } }), 1);
    assert.equal(await db.externalImportRecord.count({ where: { sourceRecordId: lostId } }), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    checks.push('Concurrent offline tabs preserve both entries, synchronize each once, and fit a 412px viewport');

    await tab.close();
    await context.setOffline(true);
    await fill(page, 45, '2026-10-21T10:05');
    await pending(page).getByText('45 ML', { exact: true }).waitFor();
    const conflict = (await rows(page))[0];
    const competing = await fetch(`${base}/api/bottle-journal`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ babyId: baby.id, requestId: conflict.requestId, bottle: { ...conflict.bottle, amount: 46 } }) });
    assert.equal(competing.status, 200); await competing.body?.cancel();
    await context.setOffline(false);
    const review = 'Needs review. Check saved history and your access before retrying. Conflicting values will never overwrite a saved bottle.';
    await pending(page).getByText(review, { exact: true }).waitFor();
    const attempts = (await rows(page))[0].attempts;
    await page.getByRole('button', { name: 'Sync now', exact: true }).click();
    await page.getByRole('button', { name: 'Sync now', exact: true }).waitFor({ state: 'visible' });
    assert.equal((await rows(page))[0].attempts, attempts, 'Ordinary sync must not replay a blocked conflict');
    assert.equal((await db.feedLog.findUniqueOrThrow({ where: { id: conflict.requestId } })).amount, 46);
    await pending(page).getByRole('button', { name: 'Discard pending entry', exact: true }).click();
    await pending(page).getByRole('button', { name: 'Confirm discard', exact: true }).click();
    await pending(page).waitFor({ state: 'detached' });
    assert.equal(await db.feedLog.count(), originalCount + 5, 'Discarding a local pending copy must preserve canonical records');
    checks.push('A real API 409 blocks automatic retries; explicit local discard preserves the existing canonical record');

    // A second caregiver may delete a bottle after the first response was lost.
    // The permanent receipt must turn a retry into a reviewable conflict, not a
    // replacement record or a server error that retries indefinitely.
    let deletedResponseLost = false;
    const loseDeletedResponse = async route => {
      if (route.request().method() !== 'POST') return route.continue();
      if (!deletedResponseLost) {
        const response = await route.fetch(); assert.equal(response.status(), 200);
        deletedResponseLost = true;
      }
      await route.abort('failed');
    };
    await page.route('**/api/bottle-journal', loseDeletedResponse);
    await fill(page, 47, '2026-10-21T10:07');
    await page.getByText('Bottle saved on this browser. Waiting for server confirmation.', { exact: true }).waitFor();
    assert.equal(deletedResponseLost, true);
    await waitForCount(originalCount + 6);
    const deletedQueue = (await rows(page))[0];
    const receiptBeforeDelete = await db.externalImportRecord.findFirstOrThrow({ where: {
      familyId: family.id, providerId: 'sat-tracker-journal', sourceRecordId: deletedQueue.requestId,
    } });
    const deletion = await fetch(`${base}/api/feed-log?id=${encodeURIComponent(deletedQueue.requestId)}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${otherToken}` },
    });
    assert.equal(deletion.status, 200); await deletion.body?.cancel();
    assert.equal(await db.feedLog.findUnique({ where: { id: deletedQueue.requestId } }), null);
    await page.unroute('**/api/bottle-journal', loseDeletedResponse);
    const replayResponse = page.waitForResponse(response => response.url() === `${base}/api/bottle-journal`
      && response.request().method() === 'POST');
    await pending(page).getByRole('button', { name: 'Retry this entry', exact: true }).click();
    assert.equal((await replayResponse).status(), 409, 'A deleted journal receipt must yield a reviewable conflict, never a retryable 500');
    await pending(page).getByText(review, { exact: true }).waitFor();
    const deletedBlocked = (await rows(page))[0];
    assert.equal(deletedBlocked.requestId, deletedQueue.requestId);
    assert.deepEqual(deletedBlocked.bottle, deletedQueue.bottle);
    assert.equal(deletedBlocked.state, 'blocked'); assert.equal(deletedBlocked.status, 409);
    assert.equal(await db.feedLog.count(), originalCount + 5);
    assert.deepEqual(await db.externalImportRecord.findUnique({ where: { id: receiptBeforeDelete.id } }), receiptBeforeDelete);
    checks.push('A lost journal response followed by another caregiver’s canonical deletion blocks the original retry without resurrection or receipt mutation');

    await page.reload({ waitUntil: 'networkidle' });
    await pending(page).getByText(review, { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Sync now', exact: true }).click();
    await page.getByRole('button', { name: 'Sync now', exact: true }).waitFor({ state: 'visible' });
    assert.equal((await rows(page))[0].attempts, deletedBlocked.attempts, 'A blocked deleted-record retry must survive reload without automatic retries');
    await pending(page).getByRole('button', { name: 'Discard pending entry', exact: true }).click();
    await pending(page).getByText('This may already be saved online. Discard only the local pending copy?', { exact: true }).waitFor();
    await pending(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal((await rows(page))[0].requestId, deletedQueue.requestId);
    await pending(page).getByRole('button', { name: 'Discard pending entry', exact: true }).click();
    await pending(page).getByRole('button', { name: 'Confirm discard', exact: true }).click();
    await pending(page).waitFor({ state: 'detached' });
    assert.equal((await rows(page)).length, 0);
    assert.equal(await db.feedLog.count(), originalCount + 5);
    assert.deepEqual(await db.externalImportRecord.findUnique({ where: { id: receiptBeforeDelete.id } }), receiptBeforeDelete);
    checks.push('Deleted-record conflicts remain blocked across reload; reviewed local discard removes only the queued copy and preserves the permanent receipt');
    return checks;
  } finally { if (context) await context.close(); }
}
