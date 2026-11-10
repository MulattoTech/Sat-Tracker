// Two authenticated synthetic caregiver contexts; no physical-device claim.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

export async function verifyPumpingConflicts({ base, db, family, baby, caretaker, token, secret, context }) {
  assert.equal(new URL(base).hostname, '127.0.0.1', 'Conflict checks require the owned synthetic server');
  assert.ok(family.slug.startsWith('synthetic-'), 'Conflict fixtures must belong to the disposable acceptance family');
  const checks = [];
  const request = (path, method, body, bearer = token) => fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
  });
  const created = await request('/api/pump-log', 'POST', {
    babyId: baby.id, startTime: '2026-10-21T15:00:00.000Z', endTime: '2026-10-21T15:20:00.000Z',
    totalAmount: 137, unitAbbr: 'ML', pumpAction: 'FED', notes: 'Synthetic revision fixture',
  });
  assert.equal(created.status, 200);
  const opened = (await created.json()).data;
  const path = `/api/pump-log?id=${opened.id}`;
  const second = await db.caretaker.create({ data: {
    id: randomUUID(), familyId: family.id, loginId: 'pump-revision', name: 'Synthetic Second Reviewer',
    role: 'ADMIN', type: 'parent', securityPin: randomUUID(), lastSeenVersion: '1.6.7',
  } });
  const secondToken = jwt.sign({ id: second.id, name: second.name, role: 'ADMIN', type: 'parent',
    familyId: family.id, familySlug: family.slug }, secret, { expiresIn: '5m' });
  const other = await context.browser().newContext({ viewport: { width: 412, height: 915 }, timezoneId: 'America/Chicago' });
  await other.addInitScript(({ token, family, baby, caretakerId }) => {
    localStorage.setItem('authToken', token); localStorage.setItem('unlockTime', String(Date.now()));
    localStorage.setItem('caretakerId', caretakerId); localStorage.setItem('isAdmin', 'true');
    localStorage.setItem('selectedFamily', JSON.stringify(family));
    localStorage.setItem(`selectedBaby_${family.id}`, JSON.stringify(baby));
  }, { token: secondToken, family, baby, caretakerId: second.id });
  const firstPage = await context.newPage();
  const secondPage = await other.newPage();
  const pageErrors = [];
  for (const page of [firstPage, secondPage]) {
    page.setDefaultTimeout(20_000);
    page.setDefaultNavigationTimeout(30_000);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.clock.setFixedTime(new Date('2026-10-21T18:00:00.000Z'));
  }
  const openEditor = async (page, amount = 137) => {
    await page.goto(`${base}/${family.slug}/full-log`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: new RegExp(`Breast Pumping.*Total Amount: ${amount}`) }).click();
    await page.getByRole('dialog', { name: 'Breast Pumping Record', exact: true }).getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit Pump', exact: true });
    await editor.getByLabel('Total Amount', { exact: true }).waitFor();
    return editor;
  };
  const submit = async (page, editor, expectedStatus, targetPath = path) => {
    const [response] = await Promise.all([
      page.waitForResponse(value => value.url() === `${base}${targetPath}` && value.request().method() === 'PUT'),
      editor.getByRole('button', { name: 'Update', exact: true }).click(),
    ]);
    assert.equal(response.status(), expectedStatus);
    return response.request().postDataJSON();
  };
  const snapshot = async () => ({
    pump: await db.pumpLog.findUniqueOrThrow({ where: { id: opened.id } }),
    feeds: await db.feedLog.findMany({ where: { sourcePumpId: opened.id }, orderBy: { id: 'asc' } }),
    stock: (await (await request(`/api/breast-milk-balance?babyId=${baby.id}&unit=ML`, 'GET')).json()).data.balance,
  });
  try {
    const editor = await openEditor(firstPage);
    const otherEditor = await openEditor(secondPage);
    await editor.getByLabel('Total Amount', { exact: true }).fill('40');
    await editor.getByLabel('Notes', { exact: true }).fill('Synthetic unsaved correction');
    await otherEditor.getByLabel('Total Amount', { exact: true }).fill('268');
    assert.equal((await submit(secondPage, otherEditor, 200)).expectedUpdatedAt, opened.updatedAt);
    await otherEditor.waitFor({ state: 'hidden' });
    const winner = await snapshot();
    assert.equal(winner.pump.totalAmount, 268);
    assert.equal(winner.pump.caretakerId, caretaker.id, 'An edit must preserve the original caregiver attribution');
    assert.equal(winner.feeds.length, 1); assert.equal(winner.feeds[0].amount, 268);
    assert.equal((await submit(firstPage, editor, 409)).expectedUpdatedAt, opened.updatedAt);
    const conflict = editor.getByRole('region', { name: 'Pumping correction conflict', exact: true });
    await conflict.getByText('This pumping record changed. Your changes were not saved.', { exact: true }).waitFor();
    assert.equal(await editor.getByLabel('Total Amount', { exact: true }).inputValue(), '40');
    assert.equal(await editor.getByLabel('Notes', { exact: true }).inputValue(), 'Synthetic unsaved correction');
    assert.equal(await editor.getByRole('button', { name: 'Update', exact: true }).isDisabled(), true);
    assert.deepEqual(await snapshot(), winner);
    checks.push('Two synthetic caregiver contexts reject a later stale pumping form while preserving its draft, winning pump, owned feed, attribution and stock');

    // A failed explicit reload does not clear input or enable a blind retry.
    const rejectReload = route => route.request().method() === 'GET'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false }) })
      : route.continue();
    await firstPage.route(`${base}${path}`, rejectReload);
    await conflict.getByRole('button', { name: 'Load latest record', exact: true }).click();
    await conflict.getByText('Could not load the latest record. Your unsaved input is unchanged. Check your connection and sign-in, then try again.', { exact: true }).waitFor();
    assert.equal(await editor.getByLabel('Total Amount', { exact: true }).inputValue(), '40');
    assert.deepEqual(await snapshot(), winner);
    await firstPage.unroute(`${base}${path}`, rejectReload);

    await conflict.getByRole('button', { name: 'Load latest record', exact: true }).click();
    await conflict.getByRole('heading', { name: 'Latest saved values', exact: true }).waitFor();
    await conflict.getByText('268', { exact: true }).waitFor();
    assert.equal(await editor.getByLabel('Total Amount', { exact: true }).inputValue(), '40');
    assert.equal(await editor.getByRole('button', { name: 'Update', exact: true }).isDisabled(), true);
    // A further completed edit can invalidate even the explicitly loaded copy.
    const newer = await request(path, 'PUT', { totalAmount: 369, expectedUpdatedAt: winner.pump.updatedAt.toISOString() }, secondToken);
    assert.equal(newer.status, 200);
    const newest = await snapshot();
    await conflict.getByRole('button', { name: 'Replace draft with latest values', exact: true }).click();
    assert.equal(await editor.getByLabel('Total Amount', { exact: true }).inputValue(), '268');
    await editor.getByLabel('Total Amount', { exact: true }).fill('450');
    assert.equal((await submit(firstPage, editor, 409)).expectedUpdatedAt, winner.pump.updatedAt.toISOString());
    assert.deepEqual(await snapshot(), newest);
    assert.equal(await editor.getByLabel('Total Amount', { exact: true }).inputValue(), '450');
    await conflict.getByRole('button', { name: 'Load latest record', exact: true }).click();
    await conflict.getByText('369', { exact: true }).waitFor();
    await conflict.getByRole('button', { name: 'Replace draft with latest values', exact: true }).click();
    assert.equal(await editor.getByLabel('Total Amount', { exact: true }).inputValue(), '369');
    await editor.getByLabel('Total Amount', { exact: true }).fill('300');
    assert.equal((await submit(firstPage, editor, 200)).expectedUpdatedAt, newest.pump.updatedAt.toISOString());
    await editor.waitFor({ state: 'hidden' });
    const final = await snapshot();
    assert.equal(final.pump.totalAmount, 300); assert.equal(final.pump.babyId, baby.id);
    assert.equal(final.pump.caretakerId, caretaker.id); assert.equal(final.pump.notes, opened.notes);
    assert.equal(final.feeds.length, 1); assert.equal(final.feeds[0].id, winner.feeds[0].id);
    assert.equal(final.feeds[0].amount, 300); assert.equal(final.stock, winner.stock);
    assert.deepEqual(pageErrors, []);
    checks.push('Explicit conflict reload preserves drafts on fetch failure, requires deliberate replacement, rejects a newly stale revision and saves one reviewed correction without duplicate feeds');

    for (const [amount, kind] of [[138, 'ambiguous'], [139, 'removed']]) {
      const response = await request('/api/pump-log', 'POST', { babyId: baby.id,
        startTime: '2026-10-21T15:00:00.000Z', endTime: '2026-10-21T15:20:00.000Z',
        totalAmount: amount, unitAbbr: 'ML', pumpAction: 'FED', notes: `Synthetic ${kind} feeding ownership`,
      });
      assert.equal(response.status, 200);
      const ownershipPump = (await response.json()).data;
      const ownershipPath = `/api/pump-log?id=${ownershipPump.id}`;
      const feed = await db.feedLog.findUniqueOrThrow({ where: { sourcePumpId: ownershipPump.id } });
      if (kind === 'ambiguous') {
        await db.feedLog.update({ where: { id: feed.id }, data: { sourcePumpId: null } });
        const { id, createdAt, updatedAt, ...legacy } = feed;
        await db.feedLog.create({ data: { ...legacy, sourcePumpId: null } });
      } else {
        await db.feedLog.update({ where: { id: feed.id }, data: { deletedAt: new Date() } });
      }
      const rows = async () => ({ pump: await db.pumpLog.findUniqueOrThrow({ where: { id: ownershipPump.id } }),
        feeds: await db.feedLog.findMany({ where: { familyId: family.id, babyId: baby.id }, orderBy: { id: 'asc' } }),
        stock: (await (await request(`/api/breast-milk-balance?babyId=${baby.id}&unit=ML`, 'GET')).json()).data.balance });
      const before = await rows();
      const ownershipEditor = await openEditor(firstPage, amount);
      await ownershipEditor.getByLabel('Notes', { exact: true }).fill('Synthetic draft retained for care-history review');
      await submit(firstPage, ownershipEditor, 409, ownershipPath);
      const ownershipPanel = ownershipEditor.getByRole('region', { name: 'Pumping correction conflict', exact: true });
      const reason = kind === 'ambiguous'
        ? 'The feeding record for this pumping session cannot be identified safely. Review the pumping and feeding history before changing it.'
        : 'The feeding record linked to this pumping session was removed. Review the pumping and feeding history before changing it.';
      await ownershipPanel.getByText(reason, { exact: true }).waitFor();
      await ownershipPanel.getByRole('button', { name: 'Load latest record', exact: true }).click();
      await ownershipPanel.getByRole('heading', { name: 'Latest saved values', exact: true }).waitFor();
      assert.equal(await ownershipEditor.getByLabel('Notes', { exact: true }).inputValue(), 'Synthetic draft retained for care-history review');
      assert.equal(await ownershipEditor.getByRole('button', { name: 'Update', exact: true }).isDisabled(), true);
      assert.equal(await ownershipPanel.getByRole('button', { name: 'Replace draft with latest values', exact: true }).count(), 0);
      await ownershipPanel.getByText('Loading the latest pump does not resolve feeding ownership. Review the feeding history before reopening this correction.', { exact: true }).waitFor();
      assert.deepEqual(await rows(), before);
      checks.push(`A ${kind} owned-feed conflict explains the care-history review, preserves the draft and rows, and keeps saving blocked after loading unchanged pump values`);
    }
    assert.deepEqual(pageErrors, []);
    return checks;
  } finally {
    for (const close of [() => firstPage.unrouteAll({ behavior: 'ignoreErrors' }), () => firstPage.close(), () => other.close()]) {
      let timeout;
      try {
        await Promise.race([close(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Pumping conflict browser cleanup exceeded five seconds')), 5000); })]);
      } finally { clearTimeout(timeout); }
    }
  }
}
