// Real photo UI/HTTP acceptance against an owned disposable server and families.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export const PHOTO_BROWSER_CHECKS = 12;
async function bounded(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' exceeded its deadline')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(condition, label, ms = 5000) {
  const deadline = Date.now() + ms;
  do { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < deadline);
  throw new Error('Timed out waiting for ' + label);
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

export async function verifyPhotoIntegrity({ base, db, browser, reportDir, signal }) {
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  const runId = process.env.SAT_TRACKER_ACCEPTANCE_RUN_ID;
  assert.ok(runId, 'Photo evidence must have the release invocation ID');
  assert.match(runId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Photo fixture paths require a UUID invocation ID');
  const prefix = 'synthetic-photo-browser-' + runId;
  const now = new Date(), at = new Date(now); at.setUTCHours(12, 34, 56, 789);
  const family = { id: prefix, slug: 'photo-' + runId, name: 'Synthetic photo family', setupStage: 3 };
  const foreign = { ...family, id: prefix + '-foreign', slug: 'photo-f-' + runId, name: 'Synthetic foreign photo family' };
  const families = [family.id, foreign.id];
  const carer = { id: prefix + '-carer', familyId: family.id, name: 'Synthetic Photo Reviewer', loginId: '43', securityPin: '684239',
    role: 'USER', type: 'parent', lastSeenVersion: '1.6.7' };
  const foreignCarer = { ...carer, id: prefix + '-foreign-carer', familyId: foreign.id };
  const baby = { id: prefix + '-baby', familyId: family.id, firstName: 'PhotoPrimary', lastName: 'Fixture', birthDate: new Date(now.getTime() - 90 * 86400000) };
  const sibling = { ...baby, id: prefix + '-sibling', firstName: 'PhotoSibling' };
  const foreignBaby = { ...baby, id: prefix + '-foreign-baby', familyId: foreign.id, firstName: 'PhotoForeign' };
  const fileDirs = families.map(id => path.join(process.cwd(), 'Files/photos', id));
  const png = await sharp({ create: { width: 36, height: 24, channels: 3, background: { r: 24, g: 130, b: 164 } } }).png().toBuffer();
  const report = { runId, syntheticOnly: true, startedAt: new Date().toISOString(),
    authentication: 'Actual USER PIN UI login and separately authenticated foreign-family control',
    scope: 'Real encrypted files, eight target types, retained limits, mixed HTTP writes, visible safe repairs, lifecycle guards, direct pagination-independent reads and stale-response isolation',
    checks: [], evidence: [], screenshots: [], errors: [], captureErrors: [], status: 'FAIL',
    cleanup: { errors: [], contextClosed: false, fixtureFamiliesRemoved: false, ownedFilesRemoved: false } };
  let context, page, token, foreignToken, failure, primary, primaryLog, ownPhotos = [], siblingPhoto, foreignPhoto;
  let caption = 'PHOTO_INTEGRITY_PRIMARY', hiddenTarget, hiddenEdge, hiddenLogEdge, capTarget;
  const pageErrors = [], releases = new Set();
  const check = async (name, action) => {
    try { signal?.throwIfAborted(); await action(); signal?.throwIfAborted(); report.checks.push(name); console.log('Photo integrity passed: ' + name); }
    catch (error) { throw new Error(name + ': ' + error.message, { cause: error }); }
  };
  const fileSnapshot = () => fileDirs.flatMap(directory => existsSync(directory) ? readdirSync(directory).sort().map(name => ({
    file: path.basename(directory) + '/' + name, sha256: createHash('sha256').update(readFileSync(path.join(directory, name))).digest('hex'),
  })) : []);
  const snapshot = async () => ({ photos: await db.photo.findMany({ orderBy: { id: 'asc' } }),
    links: await db.photoLink.findMany({ orderBy: { id: 'asc' } }), logs: await db.photoLog.findMany({ orderBy: { id: 'asc' } }),
    milestones: await db.milestone.findMany({ orderBy: { id: 'asc' } }), babies: await db.baby.findMany({ orderBy: { id: 'asc' } }), files: fileSnapshot() });
  const api = async (endpoint, method = 'GET', body, auth = token) => {
    const response = await fetch(base + '/api/' + endpoint, { method,
      headers: { Authorization: 'Bearer ' + auth, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() };
  };
  const ok = (result, expected = 200) => { assert.equal(result.status, expected, JSON.stringify(result.body)); if (expected === 200) assert.equal(result.body.success, true); return result.body.data; };
  const upload = async (count = 1, options = {}) => {
    const form = new FormData(); form.append('babyId', options.babyId || baby.id); form.append('takenAt', at.toISOString());
    if (options.milestoneId) form.append('milestoneId', options.milestoneId);
    for (let index = 0; index < count; index++) form.append('files', new File([png], `synthetic-photo-${index}.png`, { type: 'image/png' }));
    const response = await fetch(base + '/api/photos/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + (options.token || token) }, body: form,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
    return { status: response.status, body: await response.json() };
  };
  const milestone = (name, child = baby, owner = family) => db.milestone.create({ data: { id: prefix + '-' + name,
    familyId: owner.id, babyId: child.id, date: at, title: 'SYNTHETIC_PRIVATE_' + name, category: 'MOTOR' } });
  const panelClosed = panel => panel.evaluateAll(nodes => nodes.length === 0 || nodes.every(node => node.classList.contains('translate-x-full')));
  // Log Entry and Timeline each keep their own closed PhotoForm/PhotoDetail
  // mounted. Target the open drawer, then still wait for real actionability.
  const activeDrawer = name => page.getByRole('dialog', { name, exact: true }).and(page.locator('.form-page-container:not(.translate-x-full)'));
  const responseFor = (endpoint, method) => page.waitForResponse(response => new URL(response.url()).pathname === '/api/' + endpoint && response.request().method() === method);
  const screenshot = async name => { const file = path.join(reportDir, name); await page.screenshot({ path: file, fullPage: false, timeout: 5000 }); report.screenshots.push(file); };
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const logEntry = () => page.goto(`${base}/${family.slug}/log-entry?babyId=${baby.id}`, { waitUntil: 'networkidle' });
  const openPhotoForm = async () => {
    await page.getByRole('button', { name: 'Photo', exact: true }).click();
    const form = activeDrawer('Photo Tracker');
    await until(async () => !await panelClosed(form), 'Photo Tracker opening');
    await form.getByPlaceholder("What's happening in this photo?", { exact: true }).click({ trial: true });
    return form;
  };
  const openPrimaryEditor = async () => {
    await logEntry();
    const row = page.locator('.timeline-event.photo').filter({ has: page.getByTitle(caption, { exact: true }) });
    await row.locator('.event-title').click();
    const details = page.getByRole('dialog', { name: 'Activity', exact: true });
    await until(async () => !await panelClosed(details), 'photo log details');
    await details.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = activeDrawer('Photo Tracker');
    const input = editor.getByPlaceholder("What's happening in this photo?", { exact: true });
    await input.click({ trial: true });
    await until(async () => await input.inputValue() === caption && await editor.getByRole('button', { name: 'View photo', exact: true }).count() === 1, 'exact PhotoLog hydration');
    return editor;
  };
  const openLibraryPhoto = async () => {
    const form = await openPhotoForm();
    await form.getByRole('tab', { name: 'Photo Library', exact: true }).click();
    await form.getByPlaceholder('Search captions, milestones…', { exact: true }).fill(caption);
    await form.locator('.photo-library-row').filter({ hasText: caption }).click();
    const detail = activeDrawer('Photo');
    await until(async () => !await panelClosed(detail) && (await detail.locator('.photo-detail-caption').textContent()) === caption, 'direct Photo detail');
    await detail.getByRole('button', { name: 'Edit caption', exact: true }).click({ trial: true });
    return detail;
  };
  const fullLog = async () => {
    await page.goto(`${base}/${family.slug}/full-log?babyId=${baby.id}`, { waitUntil: 'networkidle' });
    await page.getByPlaceholder('Search activities...', { exact: true }).waitFor();
  };
  const openFeed = async (notes, count, hydrate = true) => {
    await page.getByPlaceholder('Search activities...', { exact: true }).fill(notes);
    await until(async () => await page.locator('.full-log-timeline-activity-item').count() === 1, 'exact feed lookup ' + notes);
    await page.locator('.full-log-timeline-activity-item').click();
    const details = page.getByRole('dialog', { name: 'Feed Record', exact: true });
    await until(async () => !await panelClosed(details), 'feed details');
    await details.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit Feeding', exact: true });
    await until(async () => !await panelClosed(editor), 'feed editor');
    await editor.getByRole('button', { name: 'Cancel', exact: true }).last().click({ trial: true });
    if (hydrate) await until(async () => await editor.getByRole('button', { name: 'View photo', exact: true }).count() === count, 'exact direct feed attachments');
    return editor;
  };
  const closeFeed = async editor => { await editor.getByRole('button', { name: 'Cancel', exact: true }).last().click(); await until(() => panelClosed(editor), 'feed editor closure'); };

  try {
    await db.appConfig.create({ data: { id: prefix + '-config', adminPass: 'synthetic-unused', rootDomain: 'synthetic.invalid', enablePhotos: true } });
    await db.unit.create({ data: { unitAbbr: 'ML', unitName: 'Milliliters' } });
    for (const owner of [family, foreign]) {
      assert.ok(owner.slug.length <= 50); assert.match(owner.slug, /^[a-z0-9-]+$/);
      await db.family.create({ data: owner });
      await db.settings.create({ data: { familyId: owner.id, familyName: owner.name, authType: 'CARETAKER',
        nurseryModeSettings: JSON.stringify({ global: { layout: 'cards', acts: { feed: true, diaper: true, sleep: true } } }) } });
    }
    await db.baby.createMany({ data: [baby, sibling, foreignBaby] });
    await db.caretaker.createMany({ data: [carer, foreignCarer] });
    const foreignLogin = await fetch(base + '/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ familySlug: foreign.slug, loginId: carer.loginId, securityPin: carer.securityPin }), signal: AbortSignal.timeout(10000) });
    assert.equal(foreignLogin.status, 200); const foreignAuth = await foreignLogin.json(); assert.equal(foreignAuth.data.id, foreignCarer.id); foreignToken = foreignAuth.data.token;
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block', reducedMotion: 'reduce' });
    signal?.addEventListener('abort', () => { void context.close().catch(() => {}); }, { once: true });
    signal?.throwIfAborted();
    page = await context.newPage(); page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(20000);
    page.on('pageerror', error => pageErrors.push(error.message)); await page.clock.setFixedTime(now);
    await page.goto(`${base}/${family.slug}`, { waitUntil: 'networkidle' });
    const login = page.locator('.login-container'); await login.getByRole('heading', { name: 'Login ID & Security PIN', exact: true }).waitFor();
    assert.match(carer.loginId, /^\d{2}$/); assert.match(carer.securityPin, /^\d{6,10}$/);
    for (const digit of carer.loginId) await login.getByRole('button', { name: digit, exact: true }).click();
    assert.equal(await login.getByLabel('Login ID', { exact: true }).inputValue(), carer.loginId);
    for (const digit of carer.securityPin) await login.getByRole('button', { name: digit, exact: true }).click();
    const [authenticated] = await Promise.all([responseFor('auth', 'POST'), login.getByRole('button', { name: 'Go', exact: true }).click()]);
    const auth = await authenticated.json(); assert.equal(authenticated.status(), 200); assert.equal(auth.data.id, carer.id); assert.equal(auth.data.role, 'USER');
    token = auth.data.token; await page.getByLabel('Select Baby', { exact: true }).waitFor();
    await logEntry();
    await check('Actual USER Photo Tracker upload and save create an owned PhotoLog and readable encrypted images', async () => {
      const form = await openPhotoForm();
      await form.locator('.photo-attachments input[type=file][multiple]').setInputFiles({ name: 'synthetic-owned-photo.png', mimeType: 'image/png', buffer: png });
      await form.getByPlaceholder("What's happening in this photo?", { exact: true }).fill(caption);
      const [saved, uploaded] = await Promise.all([responseFor('photo-log', 'POST'), responseFor('photos/upload', 'POST'), form.getByRole('button', { name: 'Save Photo', exact: true }).click()]);
      assert.equal(saved.status(), 200); assert.equal(uploaded.status(), 200);
      const uploadBody = await uploaded.json(); assert.deepEqual(uploadBody.data.errors, []); assert.equal(uploadBody.data.photos.length, 1);
      primary = await db.photo.findUniqueOrThrow({ where: { id: uploadBody.data.photos[0].id } });
      primaryLog = await db.photoLog.findUniqueOrThrow({ where: { id: (await saved.json()).data.id } });
      assert.equal(primary.familyId, family.id); assert.equal(primary.babyId, baby.id); assert.equal(primary.caption, caption);
      assert.equal(primaryLog.babyId, baby.id); assert.equal(primaryLog.familyId, family.id);
      assert.equal(await db.photoLink.count({ where: { photoId: primary.id, activityType: 'photo', activityId: primaryLog.id } }), 1);
      for (const [name, size] of [[primary.storedName, primary.fileSize], [primary.thumbStoredName, primary.thumbSize]]) {
        const bytes = readFileSync(path.join(fileDirs[0], name)); assert.equal(bytes.length, size + 32); assert.notDeepEqual(bytes, png);
      }
      const image = await fetch(base + '/api/photos/file/' + primary.id, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000) });
      assert.equal(image.status, 200); const metadata = await sharp(Buffer.from(await image.arrayBuffer())).metadata(); assert.equal(metadata.width, 36); assert.equal(metadata.height, 24);
      await until(() => panelClosed(form), 'Photo Tracker save'); await screenshot('photo-integrity-created-desktop.png');
    });

    await check('All eight actual attachment targets reject foreign, sibling and deleted ownership across link, tag, upload and PhotoLog writers', async () => {
      for (const count of [4, 3]) { const uploaded = ok(await upload(count)); assert.deepEqual(uploaded.errors, []); ownPhotos.push(...uploaded.photos.map(photo => photo.id)); }
      siblingPhoto = ok(await upload(1, { babyId: sibling.id })).photos[0].id;
      foreignPhoto = ok(await upload(1, { babyId: foreignBaby.id, token: foreignToken })).photos[0].id;
      const owner = { familyId: family.id, babyId: baby.id, caretakerId: carer.id };
      await db.food.create({ data: { id: prefix + '-food', familyId: family.id, name: 'Synthetic photo food' } });
      await db.photoLog.create({ data: { ...owner, id: prefix + '-target-photo', time: at } });
      await db.feedLog.create({ data: { ...owner, id: prefix + '-target-feed', time: at, type: 'BOTTLE', amount: 30, unitAbbr: 'ML', notes: 'PHOTO_TARGET_FEED' } });
      await db.milestone.create({ data: { ...owner, id: prefix + '-target-milestone', date: at, title: 'PHOTO_TARGET_MILESTONE', category: 'MOTOR' } });
      await db.bathLog.create({ data: { ...owner, id: prefix + '-target-bath', time: at } });
      await db.playLog.create({ data: { ...owner, id: prefix + '-target-play', startTime: at, type: 'TUMMY_TIME' } });
      await db.measurement.create({ data: { ...owner, id: prefix + '-target-measurement', date: at, type: 'WEIGHT', value: 4, unit: 'kg' } });
      await db.foodLog.create({ data: { ...owner, id: prefix + '-target-foodLog', time: at, foodId: prefix + '-food' } });
      await db.diaperLog.create({ data: { ...owner, id: prefix + '-target-diaper', time: at, type: 'WET' } });
      for (const activityType of ['photo', 'feed', 'milestone', 'bath', 'play', 'measurement', 'foodLog', 'diaper']) {
        const ref = { activityType, activityId: prefix + '-target-' + activityType };
        for (const photoId of [siblingPhoto, foreignPhoto]) { const before = await snapshot(); ok(await api('photos/links', 'POST', { photoId, ...ref }), 404); assert.deepEqual(await snapshot(), before); }
        ok(await api('photos/links', 'POST', { photoId: ownPhotos[0], ...ref }));
        const linked = ok(await api('photos/attachments?' + new URLSearchParams(ref))); assert.equal(linked.photos[0].id, ownPhotos[0]); assert.equal(linked.retainedLinkCount, 1);
      }
      for (const target of [await milestone('sibling-target', sibling), await milestone('foreign-target', foreignBaby, foreign)]) {
        const before = await snapshot();
        ok(await api('photos/' + ownPhotos[1], 'PATCH', { caption: 'Must not persist', milestoneId: target.id }), 404);
        ok(await upload(1, { milestoneId: target.id }), 404); assert.deepEqual(await snapshot(), before);
      }
      for (const id of [siblingPhoto, foreignPhoto]) {
        const before = await snapshot();
        ok(await api('photo-log', 'POST', { babyId: baby.id, time: at.toISOString(), photoIds: [primary.id, id] }), 404);
        ok(await api('photo-log?id=' + primaryLog.id, 'PUT', { photoIds: [id], time: new Date(at.getTime() + 1000).toISOString() }), 404);
        assert.deepEqual(await snapshot(), before);
      }
      await db.baby.update({ where: { id: baby.id }, data: { deletedAt: at } });
      const before = await snapshot(); ok(await api('photos/links', 'POST', { photoId: ownPhotos[1], activityType: 'diaper', activityId: prefix + '-target-diaper' }), 404);
      ok(await api('photos/' + primary.id), 404); assert.deepEqual(await snapshot(), before);
      await db.baby.update({ where: { id: baby.id }, data: { deletedAt: null } });
    });

    await check('Retained hidden, trashed and scalar-only milestone reservations enforce four slots and idempotent retries at capacity', async () => {
      capTarget = await milestone('capacity'); const ref = { activityType: 'milestone', activityId: capTarget.id };
      await db.photoLink.createMany({ data: ownPhotos.slice(0, 3).map(photoId => ({ photoId, ...ref })) });
      await db.photo.update({ where: { id: ownPhotos[2] }, data: { deletedAt: at } });
      await db.photo.update({ where: { id: ownPhotos[3] }, data: { milestoneId: capTarget.id } });
      const before = await snapshot(); ok(await api('photos/links', 'POST', { photoId: ownPhotos[0], ...ref })); assert.deepEqual(await snapshot(), before);
      ok(await api('photos/links', 'POST', { photoId: ownPhotos[4], ...ref }), 400);
      ok(await api('photos/' + ownPhotos[4], 'PATCH', { caption: 'Rejected caption', milestoneId: capTarget.id }), 400);
      const rejected = ok(await upload(1, { milestoneId: capTarget.id })); assert.deepEqual(rejected.photos, []); assert.equal(rejected.errors.length, 1); assert.deepEqual(await snapshot(), before);
      const read = ok(await api('photos/attachments?' + new URLSearchParams(ref))); assert.equal(read.maxPhotos, 4); assert.equal(read.retainedLinkCount, 4); assert.equal(read.photos.length, 3); assert.ok(read.photos.some(photo => photo.id === ownPhotos[3]));
      ok(await api('photos/links', 'POST', { photoId: ownPhotos[3], ...ref }));
      assert.equal(await db.photoLink.count({ where: ref }), 4);
      report.evidence.push({ capacity: 4, returnedLivePhotos: 3, duplicateRowsUnchanged: true, rejectedUploadFilesRemoved: true });
    });

    await check('Simultaneous actual upload, link and primary-tag HTTP writers admit one final slot without partial metadata or files', async () => {
      const target = await milestone('mixed-writers'), ref = { activityType: 'milestone', activityId: target.id };
      await db.photoLink.createMany({ data: [ownPhotos[0], ownPhotos[1], ownPhotos[3]].map(photoId => ({ photoId, ...ref })) });
      const photosBefore = await db.photo.count(), filesBefore = fileSnapshot().length;
      const results = await Promise.all([api('photos/links', 'POST', { photoId: ownPhotos[4], ...ref }),
        api('photos/' + ownPhotos[5], 'PATCH', { caption: 'Mixed writer caption', milestoneId: target.id }), upload(1, { milestoneId: target.id })]);
      const uploaded = ok(results[2]); const admitted = Number(results[0].status === 200) + Number(results[1].status === 200) + uploaded.photos.length;
      assert.equal(admitted, 1); assert.equal(await db.photoLink.count({ where: ref }), 4);
      for (const result of results.slice(0, 2)) assert.ok([200, 400].includes(result.status), JSON.stringify(result));
      assert.equal(await db.photo.count(), photosBefore + uploaded.photos.length); assert.equal(fileSnapshot().length, filesBefore + uploaded.photos.length * 2);
      if (results[1].status !== 200) assert.equal((await db.photo.findUniqueOrThrow({ where: { id: ownPhotos[5] } })).caption, null);
      report.evidence.push({ mixedHttpWriters: 3, admitted, finalRetainedCount: 4, actualDatabaseOverlapProvedSeparately: 'photoIntegrityConcurrency and PostgreSQL pg_stat_activity receipts' });
    });

    await check('Sanitized legacy links stay hidden and a rejected caption-only real edit preserves its draft, raw edges and exact time', async () => {
      hiddenTarget = await milestone('hidden-foreign', foreignBaby, foreign);
      await db.photo.update({ where: { id: primary.id }, data: { milestoneId: hiddenTarget.id } });
      hiddenEdge = await db.photoLink.create({ data: { photoId: primary.id, activityType: 'milestone', activityId: hiddenTarget.id } });
      hiddenLogEdge = await db.photoLink.create({ data: { photoId: siblingPhoto, activityType: 'photo', activityId: primaryLog.id } });
      const direct = ok(await api('photos/' + primary.id));
      assert.equal(direct.milestoneId, null); assert.equal(direct.milestoneTitle, null); assert.equal(direct.unavailableMilestone, true);
      assert.deepEqual(direct.unavailableLinkIds, [hiddenEdge.id]);
      const representations = [direct, ok(await api('photos?babyId=' + baby.id)), ok(await api('photo-log?id=' + primaryLog.id)),
        ok(await api('photos/attachments?' + new URLSearchParams({ activityType: 'photo', activityId: primaryLog.id }))),
        ok(await api('timeline?babyId=' + baby.id))];
      for (const value of representations) {
        const serialized = JSON.stringify(value); assert.equal(serialized.includes(hiddenTarget.title), false);
        assert.equal(serialized.includes(hiddenTarget.id), false); assert.equal(serialized.includes(foreignBaby.id), false);
      }
      assert.equal(representations[2].retainedLinkCount, 2); assert.equal(representations[2].photos.length, 1);
      const editor = await openPrimaryEditor();
      assert.equal((await editor.getByTestId('photo-reserved-slots').textContent()).trim(), 'Unavailable or trashed attachments reserve photo slots (1).');
      assert.equal((await editor.getByRole('combobox').textContent()).trim(), 'No milestone');
      const original = await snapshot(), oldPhoto = await db.photo.findUniqueOrThrow({ where: { id: primary.id } });
      const nextCaption = 'PHOTO_RETAINED_CAPTION café';
      await editor.getByPlaceholder("What's happening in this photo?", { exact: true }).fill(nextCaption);
      const rejected = async route => {
        if (route.request().method() !== 'PATCH') return route.continue();
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Synthetic photo edit rejected' }) });
      };
      const logWrites = []; const observe = request => { if (new URL(request.url()).pathname === '/api/photo-log' && request.method() === 'PUT') logWrites.push(request.postDataJSON()); };
      page.on('request', observe); await page.route('**/api/photos/' + primary.id, rejected);
      const [failed] = await Promise.all([responseFor('photos/' + primary.id, 'PATCH'), editor.getByRole('button', { name: 'Save Photo', exact: true }).click()]);
      assert.equal(failed.status(), 409); await editor.getByText('Synthetic photo edit rejected', { exact: true }).waitFor();
      assert.equal(await editor.getByPlaceholder("What's happening in this photo?", { exact: true }).inputValue(), nextCaption);
      assert.deepEqual(await snapshot(), original); await screenshot('photo-integrity-retained-draft-desktop.png');
      await page.unroute('**/api/photos/' + primary.id, rejected);
      const [saved] = await Promise.all([responseFor('photos/' + primary.id, 'PATCH'), editor.getByRole('button', { name: 'Save Photo', exact: true }).click()]);
      assert.equal(saved.status(), 200); assert.deepEqual(saved.request().postDataJSON(), { caption: nextCaption });
      await until(() => panelClosed(editor), 'caption-only save'); page.off('request', observe); assert.deepEqual(logWrites, []);
      const updated = await db.photo.findUniqueOrThrow({ where: { id: primary.id } });
      assert.equal(updated.caption, nextCaption); assert.equal(updated.milestoneId, hiddenTarget.id); assert.equal(updated.takenAt.getTime(), oldPhoto.takenAt.getTime());
      assert.deepEqual(await db.photoLog.findUniqueOrThrow({ where: { id: primaryLog.id } }), primaryLog);
      assert.deepEqual(await db.photoLink.findMany({ orderBy: { id: 'asc' } }), original.links); caption = nextCaption;
    });

    await check('Mobile keyboard repair removes only owned opaque mismatches, retains controls on failure and clears scalar-only tags explicitly', async () => {
      await page.setViewportSize({ width: 390, height: 844 }); await logEntry();
      const detail = await openLibraryPhoto(); const remove = detail.getByRole('button', { name: 'Remove unavailable link 1', exact: true });
      await remove.scrollIntoViewIfNeeded(); await remove.click({ trial: true });
      const geometry = await remove.boundingBox(); assert.ok(geometry.height >= 44 && geometry.width > 0);
      const widths = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth })); assert.ok(widths.width <= widths.viewport + 1);
      assert.equal((await detail.textContent()).includes(hiddenTarget.title), false); assert.equal((await detail.textContent()).includes(hiddenTarget.id), false);
      const before = await snapshot();
      ok(await api(`photos/links?photoId=${primary.id}&linkId=${hiddenEdge.id}`, 'DELETE', undefined, foreignToken), 404);
      ok(await api(`photos/links?photoId=${foreignPhoto}&linkId=${hiddenEdge.id}`, 'DELETE'), 404); assert.deepEqual(await snapshot(), before);
      const rejected = async route => {
        if (route.request().method() !== 'DELETE') return route.continue();
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Synthetic repair rejected' }) });
      };
      await page.route('**/api/photos/links?*', rejected); await remove.focus(); assert.equal(await remove.evaluate(node => node === document.activeElement), true);
      const [failureResponse] = await Promise.all([responseFor('photos/links', 'DELETE'), page.keyboard.press('Enter')]);
      assert.equal(failureResponse.status(), 409); await detail.getByRole('alert').getByText('Failed to update photo details', { exact: true }).waitFor();
      assert.equal(await remove.isEnabled(), true); assert.deepEqual(await snapshot(), before); await screenshot('photo-integrity-repair-phone-rejected.png');
      await page.unroute('**/api/photos/links?*', rejected);
      const [success] = await Promise.all([responseFor('photos/links', 'DELETE'), remove.click()]); assert.equal(success.status(), 200);
      const request = new URL(success.url()); assert.equal(request.searchParams.get('linkId'), hiddenEdge.id); assert.equal(request.searchParams.has('activityId'), false);
      await until(async () => await detail.getByTestId('remove-unavailable-photo-link').count() === 0, 'opaque repair completion');
      assert.equal(await db.photoLink.findUnique({ where: { id: hiddenEdge.id } }), null);
      assert.equal((await db.photo.findUniqueOrThrow({ where: { id: primary.id } })).milestoneId, null);
      assert.ok(await db.milestone.findUnique({ where: { id: hiddenTarget.id } })); assert.deepEqual(fileSnapshot(), before.files);
      ok(await api(`photos/links?photoId=${primary.id}&linkId=${hiddenEdge.id}`, 'DELETE'));
      await detail.getByRole('button', { name: 'Close', exact: true }).last().click();
      await db.photo.update({ where: { id: primary.id }, data: { milestoneId: hiddenTarget.id } });
      await logEntry(); const scalarDetail = await openLibraryPhoto();
      const scalarRemove = scalarDetail.getByRole('button', { name: 'Remove unavailable milestone', exact: true }); await scalarRemove.scrollIntoViewIfNeeded();
      await screenshot('photo-integrity-repair-phone-scalar.png');
      const [cleared] = await Promise.all([responseFor('photos/' + primary.id, 'PATCH'), scalarRemove.click()]);
      assert.equal(cleared.status(), 200); assert.deepEqual(cleared.request().postDataJSON(), { milestoneId: null });
      await until(async () => await scalarDetail.getByRole('button', { name: 'Remove unavailable milestone', exact: true }).count() === 0, 'scalar-only repair');
      assert.equal((await db.photo.findUniqueOrThrow({ where: { id: primary.id } })).milestoneId, null);
      assert.ok(await db.photoLink.findUnique({ where: { id: hiddenLogEdge.id } })); assert.deepEqual(fileSnapshot(), before.files);
      await page.setViewportSize({ width: 1440, height: 1000 });
    });

    await check('Explicit PhotoLog replacement preserves unavailable history, rejects atomic overflow and detaches only surfaced omitted photos', async () => {
      const target = await db.photoLog.create({ data: { id: prefix + '-replacement', familyId: family.id, babyId: baby.id, caretakerId: carer.id, time: at } });
      const ref = { activityType: 'photo', activityId: target.id };
      const retained = await db.photoLink.create({ data: { photoId: siblingPhoto, ...ref } });
      const trashed = await db.photoLink.create({ data: { photoId: ownPhotos[2], ...ref } });
      await db.photoLink.create({ data: { photoId: ownPhotos[0], ...ref } });
      const before = await snapshot();
      ok(await api('photo-log?id=' + target.id, 'PUT', { time: new Date(at.getTime() + 5000).toISOString(), photoIds: [ownPhotos[0], ownPhotos[1], ownPhotos[4]] }), 400);
      assert.deepEqual(await snapshot(), before);
      const replacement = ok(await api('photo-log?id=' + target.id, 'PUT', { photoIds: [ownPhotos[1]] }));
      assert.deepEqual(replacement.photos.map(photo => photo.id), [ownPhotos[1]]); assert.equal(replacement.retainedLinkCount, 3);
      assert.deepEqual(await db.photoLink.findUniqueOrThrow({ where: { id: retained.id } }), retained);
      assert.deepEqual(await db.photoLink.findUniqueOrThrow({ where: { id: trashed.id } }), trashed);
      assert.equal(await db.photoLink.count({ where: { ...ref, photoId: ownPhotos[0] } }), 0);
      assert.equal((await db.photoLog.findUniqueOrThrow({ where: { id: target.id } })).time.getTime(), at.getTime());
      const empty = ok(await api('photo-log?id=' + target.id, 'PUT', { photoIds: [] })); assert.deepEqual(empty.photos, []); assert.equal(empty.retainedLinkCount, 2);
      assert.deepEqual(fileSnapshot(), before.files);
    });

    await check('Actual target moves and ordinary deletes reject malformed references then detach valid links atomically without deleting photos', async () => {
      const target = await milestone('lifecycle'), ref = { activityType: 'milestone', activityId: target.id };
      const malformed = await db.photoLink.create({ data: { photoId: siblingPhoto, ...ref } });
      const before = await snapshot();
      ok(await api('milestone-log?id=' + target.id, 'PUT', { babyId: sibling.id }), 409);
      ok(await api('milestone-log?id=' + target.id, 'DELETE'), 409); assert.deepEqual(await snapshot(), before);
      ok(await api(`photos/links?photoId=${siblingPhoto}&linkId=${malformed.id}`, 'DELETE'));
      ok(await api('photos/' + ownPhotos[6], 'PATCH', { milestoneId: target.id }));
      const photosBefore = await db.photo.count(), filesBefore = fileSnapshot();
      ok(await api('milestone-log?id=' + target.id, 'DELETE'));
      const deleted = await db.milestone.findUnique({ where: { id: target.id } }); assert.ok(!deleted || deleted.deletedAt);
      assert.equal(await db.photoLink.count({ where: ref }), 0); assert.equal((await db.photo.findUniqueOrThrow({ where: { id: ownPhotos[6] } })).milestoneId, null);
      assert.equal(await db.photo.count(), photosBefore); assert.deepEqual(fileSnapshot(), filesBefore);
      ok(await api('photos/links', 'POST', { photoId: primary.id, ...ref }), 404);
      const movable = await milestone('move-first');
      ok(await api('milestone-log?id=' + movable.id, 'PUT', { babyId: sibling.id }));
      const movedBefore = await snapshot();
      ok(await api('photos/links', 'POST', { photoId: primary.id, activityType: 'milestone', activityId: movable.id }), 404); assert.deepEqual(await snapshot(), movedBefore);
    });

    await check('Actual Nursery one-tap care refuses stale Undo after a later attachment and preserves both the saved care and encrypted photo', async () => {
      await page.goto(`${base}/${family.slug}/nursery-mode`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Switch Baby', exact: true }).click();
      await page.getByRole('option', { name: baby.firstName, exact: true }).click();
      const card = page.locator('.nursery-card').filter({ has: page.getByRole('heading', { name: 'Diaper', exact: true }) });
      const [saved] = await Promise.all([responseFor('diaper-log', 'POST'), card.getByRole('button', { name: 'Wet', exact: true }).click()]);
      assert.equal(saved.status(), 200); const result = await saved.json(); assert.ok(result.undo); assert.equal(result.data.babyId, baby.id);
      ok(await api('photos/links', 'POST', { photoId: primary.id, activityType: 'diaper', activityId: result.data.id }));
      const before = await db.diaperLog.findUniqueOrThrow({ where: { id: result.data.id } });
      const edge = await db.photoLink.findFirstOrThrow({ where: { photoId: primary.id, activityType: 'diaper', activityId: before.id } });
      const filesBefore = fileSnapshot();
      const [undone] = await Promise.all([responseFor('diaper-log', 'DELETE'), page.getByRole('button', { name: 'Undo', exact: true }).click()]);
      assert.equal(undone.status(), 409); assert.deepEqual(undone.request().postDataJSON().nurseryUndo, result.undo);
      assert.equal((await undone.json()).error, 'This entry has changed or has attached photos. Nothing was undone. Review the care log.');
      await page.getByText('This entry changed or was removed. Undo could not be confirmed. Review the care log.', { exact: true }).waitFor();
      assert.deepEqual(await db.diaperLog.findUniqueOrThrow({ where: { id: before.id } }), before);
      assert.deepEqual(await db.photoLink.findUniqueOrThrow({ where: { id: edge.id } }), edge); assert.deepEqual(fileSnapshot(), filesBefore);
      await screenshot('photo-integrity-undo-conflict-desktop.png');
      await page.reload({ waitUntil: 'networkidle' }); assert.deepEqual(await db.diaperLog.findUniqueOrThrow({ where: { id: before.id } }), before);
    });

    let feedA, feedB;
    await check('A real editor finds attachments beyond 200 newer gallery images and accurately reserves trashed or hidden slots through reload and restore', async () => {
      // Copy only this synthetic encrypted image to unique owned fixture names;
      // this intentionally creates pagination, without 201 redundant uploads.
      const source = await db.photo.findUniqueOrThrow({ where: { id: primary.id } });
      const fixtures = [];
      for (let index = 0; index < 201; index++) {
        const id = prefix + '-page-' + index, storedName = randomUUID() + '.enc', thumbStoredName = randomUUID() + '.enc';
        copyFileSync(path.join(fileDirs[0], source.storedName), path.join(fileDirs[0], storedName));
        copyFileSync(path.join(fileDirs[0], source.thumbStoredName), path.join(fileDirs[0], thumbStoredName));
        fixtures.push({ id, familyId: family.id, babyId: baby.id, caretakerId: carer.id, originalName: 'synthetic-pagination.png',
          storedName, thumbStoredName, fileSize: source.fileSize, thumbSize: source.thumbSize, mimeType: source.mimeType,
          takenAt: new Date(source.takenAt.getTime() + 60000 + index * 1000), caption: 'SYNTHETIC_PAGINATION_' + index });
      }
      await db.photo.createMany({ data: fixtures });
      const gallery = ok(await api('photos?babyId=' + baby.id + '&limit=200'));
      assert.equal(gallery.photos.length, 200); assert.ok(gallery.nextCursor); assert.equal(gallery.photos.some(photo => photo.id === primary.id), false);
      const owner = { familyId: family.id, babyId: baby.id, caretakerId: carer.id, time: at, type: 'BOTTLE', amount: 30, unitAbbr: 'ML' };
      feedA = await db.feedLog.create({ data: { ...owner, id: prefix + '-direct-feed-a', notes: 'PHOTO_DIRECT_FEED_A' } });
      feedB = await db.feedLog.create({ data: { ...owner, id: prefix + '-direct-feed-b', notes: 'PHOTO_DIRECT_FEED_B' } });
      ok(await api('photos/links', 'POST', { photoId: primary.id, activityType: 'feed', activityId: feedA.id }));
      await db.photoLink.createMany({ data: [ownPhotos[2], siblingPhoto].map(photoId => ({ photoId, activityType: 'feed', activityId: feedA.id })) });
      for (const photoId of ownPhotos.slice(0, 2)) ok(await api('photos/links', 'POST', { photoId, activityType: 'feed', activityId: feedB.id }));
      await fullLog();
      const read = page.waitForResponse(response => new URL(response.url()).pathname === '/api/photos/attachments' && new URL(response.url()).searchParams.get('activityId') === feedA.id);
      let editor = await openFeed(feedA.notes, 1); const actual = await read;
      assert.equal(actual.status(), 200); assert.deepEqual((await actual.json()).data.photos.map(photo => photo.id), [primary.id]);
      await until(async () => (await editor.getByTestId('photo-reserved-slots').textContent()).includes('(2)'), 'two reserved direct slots');
      await editor.locator('.photo-attachments').scrollIntoViewIfNeeded();
      await until(async () => await editor.locator('.photo-attachments img').evaluateAll(images => images.length === 1 && images.every(image => image.complete && image.naturalWidth > 0)), 'decrypted old attachment thumbnail');
      await screenshot('photo-integrity-direct-editor-desktop.png'); await closeFeed(editor);
      ok(await api('photos/' + primary.id, 'DELETE'));
      let direct = ok(await api('photos/attachments?' + new URLSearchParams({ activityType: 'feed', activityId: feedA.id })));
      assert.equal(direct.retainedLinkCount, 3); assert.deepEqual(direct.photos, []);
      editor = await openFeed(feedA.notes, 0);
      await until(async () => (await editor.getByTestId('photo-reserved-slots').textContent()).includes('(3)'), 'all retained slots after trash'); await closeFeed(editor);
      ok(await api('photos/' + primary.id + '/restore', 'POST'));
      await page.reload({ waitUntil: 'networkidle' }); editor = await openFeed(feedA.notes, 1);
      await until(async () => (await editor.getByTestId('photo-reserved-slots').textContent()).includes('(2)'), 'restored attachment without lost reservations');
      await closeFeed(editor);
      direct = ok(await api('photos/attachments?' + new URLSearchParams({ activityType: 'feed', activityId: feedA.id })));
      assert.equal(direct.retainedLinkCount, 3); assert.deepEqual(direct.photos.map(photo => photo.id), [primary.id]);
      report.evidence.push({ paginationFixtures: 201, firstGalleryPage: 200, oldAttachmentExcludedFromPage: true, directLookupReturnedExactPhoto: true });
    });

    await check('A timeline thumbnail beyond the gallery page opens by ID and a late old-child response cannot reopen it after switching child', async () => {
      await logEntry();
      const [response] = await Promise.all([responseFor('photos/' + primary.id, 'GET'), page.getByTitle(caption, { exact: true }).first().click()]);
      assert.equal(response.status(), 200); assert.equal((await response.json()).data.id, primary.id);
      const detail = activeDrawer('Photo');
      await until(async () => !await panelClosed(detail) && await detail.locator('.photo-detail-caption').textContent() === caption, 'direct old-photo drawer');
      await screenshot('photo-integrity-direct-thumbnail-desktop.png');
      await detail.getByRole('button', { name: 'Close', exact: true }).last().click(); await until(() => panelClosed(detail), 'photo drawer closure');
      const captured = deferred(), release = deferred(), completed = deferred(); releases.add(release.resolve); let heldError;
      const delayed = async route => {
        if (route.request().method() !== 'GET') return route.continue();
        try { const actual = await route.fetch(); assert.equal(actual.status(), 200); captured.resolve(); await release.promise; await route.fulfill({ response: actual }); }
        catch (error) { heldError = error; await route.abort().catch(() => {}); } finally { completed.resolve(); }
      };
      await page.route('**/api/photos/' + primary.id, delayed); await page.getByTitle(caption, { exact: true }).first().click();
      await bounded(captured.promise, 5000, 'old-child direct photo request');
      await page.getByLabel('Select Baby', { exact: true }).click();
      await page.getByRole('menuitemradio', { name: new RegExp('^' + sibling.firstName + '\\b') }).click();
      await until(() => new URL(page.url()).searchParams.get('babyId') === sibling.id, 'sibling selection');
      release.resolve(); await bounded(completed.promise, 5000, 'old-child direct response'); if (heldError) throw heldError;
      await frames();
      assert.equal(await panelClosed(detail), true, 'A late old-child response must not reopen the Photo drawer');
      // The Select Baby dropdown trigger is icon-only; the adjacent Quick Stats
      // button owns the selected child's visible name and accessible identity.
      const siblingHeader = page.getByRole('button', { name: `${sibling.firstName}'s Quick Stats`, exact: true });
      assert.equal(await siblingHeader.getByText(sibling.firstName, { exact: true }).textContent(), sibling.firstName,
        'A late old-child response must preserve the selected sibling header');
      await page.unroute('**/api/photos/' + primary.id, delayed); releases.delete(release.resolve);
      assert.equal(await db.photoLink.count({ where: { photoId: primary.id, activityType: 'feed', activityId: feedA.id } }), 1);
    });

    await check('Delayed editor and gallery-repair responses preserve the newly opened record, its handles and its actionable controls', async () => {
      await fullLog();
      let captured = deferred(), release = deferred(), completed = deferred(), heldError;
      releases.add(release.resolve);
      const delayedAttachment = async route => {
        if (new URL(route.request().url()).searchParams.get('activityId') !== feedA.id) return route.continue();
        try {
          const actual = await route.fetch(); assert.equal(actual.status(), 200); assert.equal((await actual.json()).data.photos[0].id, primary.id);
          captured.resolve(); await release.promise; await route.fulfill({ response: actual });
        } catch (error) { heldError = error; await route.abort().catch(() => {}); } finally { completed.resolve(); }
      };
      await page.route('**/api/photos/attachments?*', delayedAttachment);
      let editor = await openFeed(feedA.notes, 0, false); await bounded(captured.promise, 5000, 'old record attachment request');
      await closeFeed(editor); editor = await openFeed(feedB.notes, 2);
      release.resolve(); await bounded(completed.promise, 5000, 'old record attachment response'); if (heldError) throw heldError;
      await frames(); assert.equal(await editor.getByRole('button', { name: 'View photo', exact: true }).count(), 2);
      assert.equal(await editor.getByTestId('photo-reserved-slots').count(), 0);
      await page.unroute('**/api/photos/attachments?*', delayedAttachment); releases.delete(release.resolve); await closeFeed(editor);

      const firstCaption = 'PHOTO_DELAYED_REPAIR_A', nextCaption = 'PHOTO_DELAYED_REPAIR_B';
      const latest = Math.max(now.getTime(), at.getTime()) + 86400000;
      await db.photo.update({ where: { id: ownPhotos[4] }, data: { caption: firstCaption, takenAt: new Date(latest) } });
      await db.photo.update({ where: { id: ownPhotos[5] }, data: { caption: nextCaption, takenAt: new Date(latest - 1000) } });
      const firstEdge = await db.photoLink.create({ data: { photoId: ownPhotos[4], activityType: 'milestone', activityId: hiddenTarget.id } });
      const nextEdge = await db.photoLink.create({ data: { photoId: ownPhotos[5], activityType: 'feed', activityId: prefix + '-missing-historical-target' } });
      const nextBefore = await db.photo.findUniqueOrThrow({ where: { id: ownPhotos[5] } }), filesBefore = fileSnapshot();
      await page.goto(`${base}/${family.slug}/photos?babyId=${baby.id}`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: firstCaption, exact: true }).click();
      const firstDialog = page.getByRole('dialog', { name: firstCaption, exact: true });
      await firstDialog.getByRole('button', { name: 'Remove unavailable link 1', exact: true }).waitFor();
      captured = deferred(); release = deferred(); completed = deferred(); heldError = undefined; releases.add(release.resolve);
      const delayedRepair = async route => {
        if (route.request().method() !== 'GET') return route.continue();
        try { const actual = await route.fetch(); assert.equal(actual.status(), 200); assert.deepEqual((await actual.json()).data.unavailableLinkIds, []);
          captured.resolve(); await release.promise; await route.fulfill({ response: actual }); }
        catch (error) { heldError = error; await route.abort().catch(() => {}); } finally { completed.resolve(); }
      };
      await page.route('**/api/photos/' + ownPhotos[4], delayedRepair);
      await firstDialog.getByRole('button', { name: 'Remove unavailable link 1', exact: true }).click();
      await bounded(captured.promise, 5000, 'repair follow-up direct GET');
      await firstDialog.getByRole('button', { name: 'Next photo', exact: true }).click();
      const nextDialog = page.getByRole('dialog', { name: nextCaption, exact: true }); await nextDialog.waitFor();
      assert.equal(await nextDialog.getByTestId('remove-unavailable-photo-link').count(), 1);
      release.resolve(); await bounded(completed.promise, 5000, 'old photo repair response'); if (heldError) throw heldError;
      await frames(); assert.equal(await nextDialog.getByTestId('remove-unavailable-photo-link').count(), 1);
      assert.equal(await nextDialog.getByRole('button', { name: 'Remove unavailable link 1', exact: true }).isEnabled(), true);
      assert.equal(await nextDialog.getByRole('alert').count(), 0);
      assert.equal(await db.photoLink.findUnique({ where: { id: firstEdge.id } }), null);
      assert.deepEqual(await db.photoLink.findUniqueOrThrow({ where: { id: nextEdge.id } }), nextEdge);
      assert.deepEqual(await db.photo.findUniqueOrThrow({ where: { id: ownPhotos[5] } }), nextBefore);
      assert.ok(await db.photo.findUnique({ where: { id: ownPhotos[4] } })); assert.deepEqual(fileSnapshot(), filesBefore);
      await screenshot('photo-integrity-delayed-repair-desktop.png');
      await page.unroute('**/api/photos/' + ownPhotos[4], delayedRepair); releases.delete(release.resolve);
    });
    assert.equal(report.checks.length, PHOTO_BROWSER_CHECKS);
  } catch (error) {
    failure = error; report.errors.push(error.message);
    if (page) try { await screenshot('photo-integrity-failure.png'); } catch (capture) { report.captureErrors.push(capture.message); }
  } finally {
    for (const release of releases) release(); releases.clear();
    if (context) try { await bounded(context.unrouteAll({ behavior: 'ignoreErrors' }), 3000, 'Photo route cleanup'); await bounded(context.close(), 5000, 'Photo context cleanup'); report.cleanup.contextClosed = true; }
    catch (error) { report.cleanup.errors.push(error.message); }
    try {
      await db.$transaction(async tx => {
        await tx.photo.deleteMany({ where: { familyId: { in: families } } });
        await tx.foodLog.deleteMany({ where: { familyId: { in: families } } });
        await tx.food.deleteMany({ where: { familyId: { in: families } } });
        await tx.baby.deleteMany({ where: { familyId: { in: families } } });
        await tx.caretaker.deleteMany({ where: { familyId: { in: families } } });
        await tx.settings.deleteMany({ where: { familyId: { in: families } } });
        await tx.family.deleteMany({ where: { id: { in: families } } });
        await tx.appConfig.deleteMany({ where: { id: prefix + '-config' } });
      }, { timeout: 15000 });
      assert.equal(await db.family.count({ where: { id: { in: families } } }), 0);
      assert.equal(await db.photo.count({ where: { familyId: { in: families } } }), 0); report.cleanup.fixtureFamiliesRemoved = true;
    } catch (error) { report.cleanup.errors.push(error.message); }
    try {
      for (const directory of fileDirs) { assert.match(path.basename(directory), /^synthetic-photo-browser-/); rmSync(directory, { recursive: true, force: true }); assert.equal(existsSync(directory), false); }
      report.cleanup.ownedFilesRemoved = true;
    } catch (error) { report.cleanup.errors.push(error.message); }
    if (!failure && report.checks.length !== PHOTO_BROWSER_CHECKS) report.errors.push(`Expected ${PHOTO_BROWSER_CHECKS} photo scenarios, got ${report.checks.length}`);
    if (pageErrors.length) report.errors.push(...pageErrors);
    report.status = !report.errors.length && !report.captureErrors.length && !report.cleanup.errors.length && report.cleanup.contextClosed
      && report.cleanup.fixtureFamiliesRemoved && report.cleanup.ownedFilesRemoved ? 'PASS' : 'FAIL';
    report.completedAt = new Date().toISOString(); mkdirSync(reportDir, { recursive: true });
    writeFileSync(path.join(reportDir, 'photo-integrity-browser-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  if (report.status !== 'PASS') throw new Error('Photo integrity browser failed: ' + report.errors.concat(report.cleanup.errors).join('; '));
  return report;
}
