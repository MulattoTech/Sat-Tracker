// Actual editors against the acceptance runner's disposable synthetic database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function verifyCareContactEditors({ base, db, family, baby, caretaker, context }) {
  assert.equal(new URL(base).hostname, '127.0.0.1', 'Contact editor checks require the owned local test server');
  assert.ok(family.slug.startsWith('synthetic-'), 'Contact editor checks require disposable fixtures');
  const prefix = `contact-editor-${randomUUID()}`;
  const name = prefix.slice(-8);
  const foreignFamilyId = `${prefix}-foreign-family`;
  const contacts = {
    active: { id: `${prefix}-active`, name: `Synthetic current provider ${name}` },
    deleted: { id: `${prefix}-deleted`, name: `Synthetic historical provider ${name}` },
    added: { id: `${prefix}-added`, name: `Synthetic added provider ${name}` },
    second: { id: `${prefix}-second`, name: `Synthetic second provider ${name}` },
    foreign: { id: `${prefix}-foreign`, name: `Synthetic hidden foreign provider ${name}` },
  };
  const records = {
    medicine: [
      { id: `${prefix}-medicine-first`, name: `Synthetic contact medicine first ${name}` },
      { id: `${prefix}-medicine-second`, name: `Synthetic contact medicine second ${name}` },
    ],
    vaccine: [
      { id: `${prefix}-vaccine-first`, name: `Synthetic contact vaccine first ${name}` },
      { id: `${prefix}-vaccine-second`, name: `Synthetic contact vaccine second ${name}` },
    ],
  };
  const checks = [];
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(30_000);
  await page.clock.setFixedTime(new Date('2026-10-21T18:00:00.000Z'));

  const linkedIds = async (kind, id) => {
    const rows = kind === 'medicine'
      ? await db.contactMedicine.findMany({ where: { medicineId: id }, orderBy: { contactId: 'asc' } })
      : await db.contactVaccine.findMany({ where: { vaccineLogId: id }, orderBy: { contactId: 'asc' } });
    return rows.map(row => row.contactId);
  };
  const readRecord = (kind, id) => kind === 'medicine'
    ? db.medicine.findUniqueOrThrow({ where: { id } })
    : db.vaccineLog.findUniqueOrThrow({ where: { id } });
  const assertOnlyNotesChanged = (before, after, notes) => {
    const { updatedAt: _beforeTime, notes: _beforeNotes, ...beforeFields } = before;
    const { updatedAt: _afterTime, notes: afterNotes, ...afterFields } = after;
    assert.deepEqual(afterFields, beforeFields, 'Contact edits must preserve the other care fields');
    assert.equal(afterNotes, notes);
  };
  const assertEditorLabels = async editor => {
    const labels = await editor.evaluate(panel => Array.from(panel.querySelectorAll('label[for]')).map(label => ({
      text: label.textContent,
      ownControl: !!label.control && panel.contains(label.control),
      idMatches: Array.from(document.querySelectorAll('[id]')).filter(node => node.id === label.htmlFor).length,
    })));
    assert.ok(labels.length > 0, 'The editor must expose associated field labels');
    assert.deepEqual(labels.filter(label => !label.ownControl || label.idMatches !== 1), [],
      'Each editor label must target one control inside that editor, even with other forms mounted');
    assert.equal(await editor.getByRole('button', { name: 'Update', exact: true }).evaluate(button =>
      !!button.form && button.form.closest('[role="dialog"]') === button.closest('[role="dialog"]')
    ), true, 'The footer must submit this editor form');
  };
  const submit = async (kind, record, editor) => {
    const pathname = kind === 'medicine' ? '/api/medicine' : '/api/vaccine-log';
    const [response] = await Promise.all([
      page.waitForResponse(value => value.url() === `${base}${pathname}?id=${record.id}` && value.request().method() === 'PUT'),
      editor.getByRole('button', { name: 'Update', exact: true }).click(),
    ]);
    assert.equal(response.status(), 200, `Actual ${kind} editor update failed: ${await response.text()}`);
    const payload = response.request().postDataJSON();
    await editor.waitFor({ state: 'hidden' });
    return payload;
  };
  const openMedicine = async record => {
    await page.getByRole('dialog', { name: 'Medicine Tracker', exact: true })
      .getByRole('button', { name: `Edit ${record.name}`, exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Edit Medicine', exact: true });
    await assertEditorLabels(editor);
    assert.equal(await editor.getByLabel('Medicine Name').inputValue(), record.name);
    assert.equal(await editor.getByRole('group', { name: 'Associated Contacts', exact: true }).count(), 1);
    return editor;
  };
  const openVaccine = async record => {
    await page.getByRole('button', { name: new RegExp(record.name) }).click();
    await page.getByRole('dialog', { name: 'Vaccine Record', exact: true })
      .getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Vaccine Tracker', exact: true });
    await assertEditorLabels(editor);
    assert.equal(await editor.getByLabel('Vaccine Name', { exact: true }).inputValue(), record.name);
    return editor;
  };

  try {
    await db.family.create({ data: { id: foreignFamilyId, slug: `${prefix}-foreign`, name: 'Synthetic contact editor foreign family', setupStage: 3 } });
    await db.contact.createMany({ data: Object.entries(contacts).map(([kind, contact]) => ({
      ...contact, familyId: kind === 'foreign' ? foreignFamilyId : family.id, role: 'doctor',
      ...(kind === 'deleted' ? { deletedAt: new Date('2026-10-20T12:00:00.000Z') } : {}),
    })) });
    await db.medicine.createMany({ data: records.medicine.map(record => ({
      ...record, familyId: family.id, typicalDoseSize: 2, unitAbbr: 'ML', doseMinTime: '00:04:00',
      notes: 'Synthetic original medicine notes', active: true, isSupplement: false,
    })) });
    await db.vaccineLog.createMany({ data: records.vaccine.map((record, index) => ({
      id: record.id, vaccineName: record.name, familyId: family.id, babyId: baby.id, caretakerId: caretaker.id,
      time: new Date(`2026-10-21T16:${index ? '10' : '00'}:00.000Z`), doseNumber: 2, notes: 'Synthetic original vaccine notes',
    })) });
    const primaryIds = [contacts.active.id, contacts.deleted.id, contacts.foreign.id];
    for (const kind of ['medicine', 'vaccine']) {
      const table = kind === 'medicine' ? db.contactMedicine : db.contactVaccine;
      const field = kind === 'medicine' ? 'medicineId' : 'vaccineLogId';
      await table.createMany({ data: [
        ...primaryIds.map(contactId => ({ contactId, [field]: records[kind][0].id })),
        { contactId: contacts.second.id, [field]: records[kind][1].id },
      ] });
    }
    const contactSnapshot = await db.contact.findMany({ where: { id: { in: Object.values(contacts).map(contact => contact.id) } }, orderBy: { id: 'asc' } });

    for (const kind of ['medicine', 'vaccine']) {
      const [first, second] = records[kind];
      const openEditor = kind === 'medicine' ? openMedicine : openVaccine;
      if (kind === 'medicine') {
        await page.goto(`${base}/${family.slug}/log-entry`, { waitUntil: 'networkidle' });
        await page.getByRole('button', { name: 'Medicine', exact: true }).click();
        await page.getByRole('dialog', { name: 'Medicine Tracker', exact: true })
          .getByRole('tab', { name: 'Medicines', exact: true }).click();
      } else {
        await page.goto(`${base}/${family.slug}/full-log`, { waitUntil: 'networkidle' });
      }

      let editor = await openEditor(first);
      await editor.getByRole('button', { name: `Remove ${contacts.active.name}`, exact: true }).waitFor();
      assert.equal(await editor.getByText(contacts.foreign.name, { exact: true }).count(), 0, 'Foreign contact details must remain hidden');
      let before = await readRecord(kind, first.id);
      const originalLinks = await linkedIds(kind, first.id);
      const notes = `Synthetic ${kind} notes-only correction`;
      await editor.getByLabel('Notes', { exact: true }).fill(notes);
      let payload = await submit(kind, first, editor);
      assert.equal(Object.hasOwn(payload, 'contactIds'), false, 'Notes-only edits must omit contactIds');
      assert.deepEqual(await linkedIds(kind, first.id), originalLinks, 'Notes-only edits must retain hidden and historical joins');
      assertOnlyNotesChanged(before, await readRecord(kind, first.id), notes);
      checks.push(`Actual ${kind} notes-only editor omits contactIds and preserves hidden foreign and own-deleted historical joins`);

      editor = await openEditor(first);
      await editor.getByRole('button', { name: `Remove ${contacts.active.name}`, exact: true }).waitFor();
      before = await readRecord(kind, first.id);
      await editor.locator('.contact-selector-list').getByText(contacts.added.name, { exact: true }).click();
      await editor.getByRole('button', { name: `Remove ${contacts.added.name}`, exact: true }).waitFor();
      payload = await submit(kind, first, editor);
      const changedIds = [contacts.active.id, contacts.deleted.id, contacts.added.id].sort();
      assert.deepEqual([...payload.contactIds].sort(), changedIds, 'Explicit add must retain the selected own-deleted contact');
      assert.deepEqual(await linkedIds(kind, first.id), changedIds);
      assertOnlyNotesChanged(before, await readRecord(kind, first.id), before.notes);
      checks.push(`Actual ${kind} contact addition sends the exact changed selection while retaining its own-deleted provider`);

      editor = await openEditor(second);
      await editor.getByRole('button', { name: `Remove ${contacts.second.name}`, exact: true }).waitFor();
      assert.equal(await editor.locator('.contact-selector-selected-tag').count(), 1);
      assert.equal(await editor.getByRole('button', { name: `Remove ${contacts.active.name}`, exact: true }).count(), 0);
      before = await readRecord(kind, second.id);
      const secondNotes = `Synthetic ${kind} second-record correction`;
      await editor.getByLabel('Notes', { exact: true }).fill(secondNotes);
      payload = await submit(kind, second, editor);
      assert.equal(Object.hasOwn(payload, 'contactIds'), false, 'Switching records must reset the unchanged-selection baseline');
      assert.deepEqual(await linkedIds(kind, second.id), [contacts.second.id]);
      assertOnlyNotesChanged(before, await readRecord(kind, second.id), secondNotes);
      checks.push(`Actual ${kind} record switch hydrates only the second record's contacts and omits an unchanged selection`);

      // Deleted contacts are intentionally absent from the live selector. Use
      // the separate active-only record for a deliberate user-visible clear.
      editor = await openEditor(second);
      before = await readRecord(kind, second.id);
      await editor.getByRole('button', { name: `Remove ${contacts.second.name}`, exact: true }).click();
      payload = await submit(kind, second, editor);
      assert.deepEqual(payload.contactIds, [], 'A deliberate clear must send an explicit empty array');
      assert.deepEqual(await linkedIds(kind, second.id), []);
      assertOnlyNotesChanged(before, await readRecord(kind, second.id), before.notes);
      checks.push(`Actual ${kind} editor sends contactIds [] only after the user explicitly clears its active selection`);
    }

    assert.deepEqual(await db.contact.findMany({ where: { id: { in: Object.values(contacts).map(contact => contact.id) } }, orderBy: { id: 'asc' } }), contactSnapshot,
      'Association editing must not change contact records or resurrect historical contacts');
    assert.deepEqual(pageErrors, [], 'Contact editor browser JavaScript errors');
    assert.equal(checks.length, 8);
    return checks;
  } finally {
    await page.close();
    await db.contactMedicine.deleteMany({ where: { medicineId: { in: records.medicine.map(record => record.id) } } });
    await db.contactVaccine.deleteMany({ where: { vaccineLogId: { in: records.vaccine.map(record => record.id) } } });
    await db.medicine.deleteMany({ where: { id: { in: records.medicine.map(record => record.id) } } });
    await db.vaccineLog.deleteMany({ where: { id: { in: records.vaccine.map(record => record.id) } } });
    await db.contact.deleteMany({ where: { id: { in: Object.values(contacts).map(contact => contact.id) } } });
    await db.family.deleteMany({ where: { id: foreignFamilyId } });
  }
}
