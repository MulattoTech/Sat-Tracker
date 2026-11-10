import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
vi.mock('../app/api/db', () => ({ get default() { return state.db; } }));
vi.mock('../app/api/utils/api-logger', () => ({ logApiCall: vi.fn(async () => {}), getClientInfo: () => ({}) }));
vi.mock('../src/lib/notifications/activityHook', () => ({ notifyActivityCreated: vi.fn(async () => {}) }));
import { GET as getMedicine, POST as postMedicine, PUT as putMedicine } from '../app/api/medicine/route';
import { GET as getVaccine, POST as postVaccine, PUT as putVaccine } from '../app/api/vaccine-log/route';
import { GET as getTimeline } from '../app/api/timeline/route';

const familyId = 'contact-write-family', foreignFamilyId = 'contact-write-foreign';
const babyId = 'contact-write-child', caretakerId = 'contact-write-carer';
const oldContact = 'contact-write-old', nextContact = 'contact-write-next';
const foreignContact = 'contact-write-foreign-contact', deletedContact = 'contact-write-deleted-contact';
const at = new Date('2026-10-20T12:00:00Z');
const endpoints = [
  { route: 'medicine', id: 'contact-write-medicine', table: 'ContactMedicine', get: getMedicine, post: postMedicine, put: putMedicine,
    create: { name: 'New synthetic medicine' }, change: { name: 'Changed synthetic medicine' } },
  { route: 'vaccine-log', id: 'contact-write-vaccine', table: 'ContactVaccine', get: getVaccine, post: postVaccine, put: putVaccine,
    create: { babyId, time: at.toISOString(), vaccineName: 'New synthetic vaccine' }, change: { vaccineName: 'Changed synthetic vaccine' } },
] as const;
let db: PrismaClient, directory: string, secret: string, previousSecret: string | undefined;

function request(route: string, method: 'POST' | 'PUT', body: unknown, id?: string) {
  const token = jwt.sign({ id: caretakerId, familyId, role: 'ADMIN', type: 'parent' }, secret, { expiresIn: '10m' });
  return new NextRequest(`http://localhost/api/${route}${id ? `?id=${id}` : ''}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
}

function getRequest(route: string, query = '') {
  const token = jwt.sign({ id: caretakerId, familyId, role: 'ADMIN', type: 'parent' }, secret, { expiresIn: '10m' });
  return new NextRequest(`http://localhost/api/${route}${query}`, { headers: { Authorization: `Bearer ${token}` } });
}

const snapshot = async () => ({
  medicines: await db.medicine.findMany({ orderBy: { id: 'asc' } }),
  vaccines: await db.vaccineLog.findMany({ orderBy: { id: 'asc' } }),
  medicineContacts: await db.contactMedicine.findMany({ orderBy: [{ medicineId: 'asc' }, { contactId: 'asc' }] }),
  vaccineContacts: await db.contactVaccine.findMany({ orderBy: [{ vaccineLogId: 'asc' }, { contactId: 'asc' }] }),
  contacts: await db.contact.findMany({ orderBy: { id: 'asc' } }),
  babies: await db.baby.findMany({ orderBy: { id: 'asc' } }),
  families: await db.family.findMany({ orderBy: { id: 'asc' } }),
  documents: await db.vaccineDocument.findMany({ orderBy: { id: 'asc' } }),
});
const linkedIds = async (route: string, id: string) => route === 'medicine'
  ? (await db.contactMedicine.findMany({ where: { medicineId: id }, orderBy: { contactId: 'asc' } })).map(link => link.contactId)
  : (await db.contactVaccine.findMany({ where: { vaccineLogId: id }, orderBy: { contactId: 'asc' } })).map(link => link.contactId);

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-care-contact-writes-'));
  const url = `file:${path.join(directory, 'synthetic.db')}`;
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
  });
  previousSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = secret = randomBytes(32).toString('hex');
  state.db = db = new PrismaClient({ adapter: createPrismaAdapter(url) });
  await db.family.createMany({ data: [familyId, foreignFamilyId].map(id => ({ id, slug: id, name: 'Synthetic contact family', setupStage: 3 })) });
  await db.caretaker.create({ data: { id: caretakerId, familyId, name: 'Synthetic contact caregiver', role: 'ADMIN', type: 'parent', loginId: '01', securityPin: '123456' } });
  await db.baby.createMany({ data: [
    { id: babyId, familyId }, { id: 'contact-write-sibling', familyId },
    { id: 'contact-write-removed-child', familyId, deletedAt: at },
    { id: 'contact-write-foreign-child', familyId: foreignFamilyId },
  ].map(value => ({ ...value, firstName: 'Synthetic', lastName: 'Child', birthDate: new Date('2026-01-01T00:00:00Z') })) });
  await db.unit.create({ data: { unitAbbr: 'MG', unitName: 'Milligrams' } });
}, 90_000);

beforeEach(async () => {
  await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS synthetic_contact_failure');
  await db.vaccineDocument.deleteMany(); await db.contactMedicine.deleteMany(); await db.contactVaccine.deleteMany();
  await db.medicine.deleteMany(); await db.vaccineLog.deleteMany(); await db.contact.deleteMany();
  await db.contact.createMany({ data: [
    { id: oldContact, familyId }, { id: nextContact, familyId },
    { id: deletedContact, familyId, deletedAt: at }, { id: foreignContact, familyId: foreignFamilyId },
  ].map(value => ({ ...value, name: 'Synthetic doctor', role: 'doctor', email: 'synthetic-contact@example.invalid' })) });
  await db.medicine.createMany({ data: [
    { id: endpoints[0].id, familyId, name: 'Original synthetic medicine', typicalDoseSize: 2, unitAbbr: 'MG', doseMinTime: '01:02:30', notes: 'Original', active: true, isSupplement: true },
    { id: 'contact-write-foreign-medicine', familyId: foreignFamilyId, name: 'Foreign synthetic medicine' },
  ] });
  await db.vaccineLog.createMany({ data: [
    { id: endpoints[1].id, familyId, babyId, caretakerId, time: at, vaccineName: 'Original synthetic vaccine', doseNumber: 2, notes: 'Original' },
    { id: 'contact-write-foreign-vaccine', familyId: foreignFamilyId, babyId: 'contact-write-foreign-child', time: at, vaccineName: 'Foreign synthetic vaccine' },
  ] });
  await db.contactMedicine.create({ data: { medicineId: endpoints[0].id, contactId: oldContact } });
  await db.contactVaccine.create({ data: { vaccineLogId: endpoints[1].id, contactId: oldContact } });
});

afterAll(async () => {
  await db?.$disconnect();
  if (directory) rmSync(directory, { recursive: true, force: true });
  if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
});

describe('authorized medicine and vaccine form compatibility', () => {
  it('preserves medicine zero/false values, DD:HH:MM and the harmless update id echo', async () => {
    const created = await postMedicine(request('medicine', 'POST', {
      name: 'Reviewed synthetic medicine', typicalDoseSize: 0, unitAbbr: null, doseMinTime: '02:03:45',
      notes: null, active: false, isSupplement: false, contactIds: [nextContact, nextContact],
    }));
    expect(created.status).toBe(200);
    const entry = (await created.json()).data;
    expect(entry).toMatchObject({ familyId, typicalDoseSize: 0, unitAbbr: null, doseMinTime: '02:03:45', notes: null, active: false, isSupplement: false });
    expect(await linkedIds('medicine', entry.id)).toEqual([nextContact]);
    const updated = await putMedicine(request('medicine', 'PUT', {
      id: entry.id, name: 'Reviewed correction', typicalDoseSize: null, unitAbbr: null, doseMinTime: null, notes: null, active: false, isSupplement: false,
    }, entry.id));
    expect(updated.status).toBe(200);
    expect((await updated.json()).data).toMatchObject({ id: entry.id, familyId, name: 'Reviewed correction', typicalDoseSize: null, unitAbbr: null, doseMinTime: null, notes: null, active: false, isSupplement: false });
    expect(await linkedIds('medicine', entry.id)).toEqual([nextContact]);
  });

  it('preserves vaccine zero/null values and validates but ignores the existing child echo', async () => {
    const created = await postVaccine(request('vaccine-log', 'POST', {
      babyId, time: at.toISOString(), vaccineName: 'Reviewed synthetic vaccine', doseNumber: 0, notes: null,
      contactIds: [nextContact, oldContact, nextContact],
    }));
    expect(created.status).toBe(200);
    const entry = (await created.json()).data;
    expect(entry).toMatchObject({ familyId, babyId, caretakerId, time: at.toISOString(), doseNumber: 0, notes: null, documents: [] });
    expect(await linkedIds('vaccine-log', entry.id)).toEqual([nextContact, oldContact].sort());
    const updated = await putVaccine(request('vaccine-log', 'PUT', {
      babyId: 'contact-write-foreign-child', doseNumber: null, notes: null,
    }, entry.id));
    expect(updated.status).toBe(200);
    expect((await updated.json()).data).toMatchObject({ id: entry.id, familyId, babyId, caretakerId, doseNumber: null, notes: null });
    expect(await linkedIds('vaccine-log', entry.id)).toEqual([nextContact, oldContact].sort());
  });

  it.each(endpoints)('$route distinguishes omitted contacts, replacement, duplicates and explicit clearing', async endpoint => {
    const omitted = await endpoint.put(request(endpoint.route, 'PUT', endpoint.change, endpoint.id));
    expect(omitted.status).toBe(200); expect(await linkedIds(endpoint.route, endpoint.id)).toEqual([oldContact]);
    const replaced = await endpoint.put(request(endpoint.route, 'PUT', { contactIds: [nextContact, nextContact] }, endpoint.id));
    expect(replaced.status).toBe(200); expect(await linkedIds(endpoint.route, endpoint.id)).toEqual([nextContact]);
    const cleared = await endpoint.put(request(endpoint.route, 'PUT', { contactIds: [] }, endpoint.id));
    expect(cleared.status).toBe(200); expect(await linkedIds(endpoint.route, endpoint.id)).toEqual([]);
  });

  it.each(endpoints)('$route retains an already-linked removed contact through form echoes and new selections', async endpoint => {
    if (endpoint.route === 'medicine') {
      await db.contactMedicine.create({ data: { medicineId: endpoint.id, contactId: deletedContact } });
    } else {
      await db.contactVaccine.create({ data: { vaccineLogId: endpoint.id, contactId: deletedContact } });
    }
    for (const contactIds of [[oldContact, deletedContact], [oldContact, deletedContact, nextContact]]) {
      const response = await endpoint.put(request(endpoint.route, 'PUT', {
        ...endpoint.change, notes: 'Historical contact retained', contactIds,
      }, endpoint.id));
      expect(response.status).toBe(200);
      expect((await response.json()).data.notes).toBe('Historical contact retained');
      expect(await linkedIds(endpoint.route, endpoint.id)).toEqual([...contactIds].sort());
    }
    const cleared = await endpoint.put(request(endpoint.route, 'PUT', { contactIds: [] }, endpoint.id));
    expect(cleared.status).toBe(200); expect(await linkedIds(endpoint.route, endpoint.id)).toEqual([]);
    const before = await snapshot();
    const reattached = await endpoint.put(request(endpoint.route, 'PUT', { contactIds: [deletedContact] }, endpoint.id));
    expect(reattached.status).toBe(404); expect(await snapshot()).toEqual(before);
  });
});

describe.each(endpoints)('$route rejects invalid contact writes without partial records', endpoint => {
  it.each([
    ['foreign', [nextContact, foreignContact], 404],
    ['missing', [nextContact, 'missing-synthetic-contact'], 404],
    ['removed', [nextContact, deletedContact], 404],
    ['null', null, 400],
    ['object', { connect: { id: nextContact } }, 400],
    ['number element', [nextContact, 42], 400],
    ['blank element', [nextContact, ' '], 400],
  ])('rejects %s contacts before POST or PUT can mutate data', async (_label, contactIds, status) => {
    for (const method of ['POST', 'PUT'] as const) {
      const before = await snapshot();
      const handler = method === 'POST' ? endpoint.post : endpoint.put;
      const response = await handler(request(endpoint.route, method, {
        ...(method === 'POST' ? endpoint.create : endpoint.change), contactIds,
      }, method === 'PUT' ? endpoint.id : undefined));
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain('synthetic-contact@example.invalid');
      expect(await snapshot()).toEqual(before);
    }
  });

  it.each(['POST', 'PUT'] as const)('rolls back the parent and old links when a later %s link insert fails', async method => {
    // This is an actual SQLite write failure, after validation and the parent
    // write, rather than a mocked Prisma transaction implementation.
    await db.$executeRawUnsafe(`CREATE TRIGGER synthetic_contact_failure BEFORE INSERT ON ${endpoint.table}
      WHEN NEW.contactId = '${nextContact}' BEGIN SELECT RAISE(ABORT, 'synthetic contact insert failure'); END`);
    const before = await snapshot();
    const handler = method === 'POST' ? endpoint.post : endpoint.put;
    const response = await handler(request(endpoint.route, method, {
      ...(method === 'POST' ? endpoint.create : endpoint.change), contactIds: [nextContact],
    }, method === 'PUT' ? endpoint.id : undefined));
    expect(response.status).toBe(500);
    expect(await snapshot()).toEqual(before);
  });
});

describe('care contact endpoints accept only API values', () => {
  it.each(endpoints)('$route rejects raw Prisma relations, scalar operators and audit fields', async endpoint => {
    const payloads = endpoint.route === 'medicine' ? [
      { contacts: { create: [{ contactId: nextContact }] } },
      { family: { connect: { id: foreignFamilyId } } },
      { typicalDoseSize: { increment: 1 } },
      { createdAt: at.toISOString() },
    ] : [
      { contacts: { create: [{ contactId: nextContact }] } },
      { baby: { connect: { id: 'contact-write-foreign-child' } } },
      { doseNumber: { increment: 1 } },
      { createdAt: at.toISOString() },
    ];
    for (const method of ['POST', 'PUT'] as const) for (const injected of payloads) {
      const before = await snapshot();
      const handler = method === 'POST' ? endpoint.post : endpoint.put;
      const response = await handler(request(endpoint.route, method, {
        ...(method === 'POST' ? endpoint.create : {}), ...injected,
      }, method === 'PUT' ? endpoint.id : undefined));
      expect(response.status).toBe(400); expect(await snapshot()).toEqual(before);
    }
  });

  it.each(['contact-write-foreign-child', 'contact-write-removed-child', 'missing-child'])('rejects vaccine creation for %s before creating parent or links', async target => {
    const before = await snapshot();
    const response = await postVaccine(request('vaccine-log', 'POST', {
      babyId: target, time: at.toISOString(), vaccineName: 'Rejected synthetic vaccine', contactIds: [nextContact],
    }));
    expect(response.status).toBe(404); expect(await snapshot()).toEqual(before);
  });

  it('rejects malformed ignored echoes instead of interpreting them as persistence instructions', async () => {
    const before = await snapshot();
    const medicine = await putMedicine(request('medicine', 'PUT', { id: { set: 'changed-id' }, name: 'Rejected' }, endpoints[0].id));
    const vaccine = await putVaccine(request('vaccine-log', 'PUT', { babyId: { set: 'contact-write-sibling' }, notes: 'Rejected' }, endpoints[1].id));
    expect(medicine.status).toBe(400); expect(vaccine.status).toBe(400); expect(await snapshot()).toEqual(before);
  });
});

describe.each(endpoints)('$route scopes legacy contact associations in responses without rewriting history', endpoint => {
  beforeEach(async () => {
    const ids = [foreignContact, deletedContact];
    if (endpoint.route === 'medicine') {
      await db.contactMedicine.createMany({ data: ids.map(contactId => ({ contactId, medicineId: endpoint.id })) });
    } else {
      await db.contactVaccine.createMany({ data: ids.map(contactId => ({ contactId, vaccineLogId: endpoint.id })) });
    }
  });

  it.each(['single', 'list'])('%s GET hides foreign contacts and retains deleted same-family contact history', async kind => {
    const before = await snapshot();
    const response = await endpoint.get(getRequest(endpoint.route, kind === 'single' ? `?id=${endpoint.id}` : ''));
    expect(response.status).toBe(200);
    const payload = await response.json();
    const entry = kind === 'single' ? payload.data : payload.data.find((item: { id: string }) => item.id === endpoint.id);
    expect(entry.contacts.map((link: { contact: { id: string } }) => link.contact.id).sort()).toEqual([oldContact, deletedContact].sort());
    expect(JSON.stringify(payload)).not.toContain(foreignContact);
    expect(await snapshot()).toEqual(before);
  });

  it('partial PUT filters returned contacts while leaving all pre-existing association rows untouched', async () => {
    const before = await snapshot();
    const response = await endpoint.put(request(endpoint.route, 'PUT', { notes: 'Reviewed legacy record' }, endpoint.id));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data.notes).toBe('Reviewed legacy record');
    expect(payload.data.contacts.map((link: { contact: { id: string } }) => link.contact.id).sort()).toEqual([oldContact, deletedContact].sort());
    expect(JSON.stringify(payload)).not.toContain(foreignContact);
    const after = await snapshot();
    expect(after.medicineContacts).toEqual(before.medicineContacts);
    expect(after.vaccineContacts).toEqual(before.vaccineContacts);
    expect(after.contacts).toEqual(before.contacts);
  });

  it('does not allow an existing foreign association to pass an explicit replacement', async () => {
    const before = await snapshot();
    const response = await endpoint.put(request(endpoint.route, 'PUT', {
      notes: 'Rejected foreign association', contactIds: [oldContact, foreignContact],
    }, endpoint.id));
    expect(response.status).toBe(404); expect(await snapshot()).toEqual(before);
  });
});

it('timeline vaccine editing receives only own-family contacts, including retained removed contacts', async () => {
  await db.contactVaccine.createMany({ data: [foreignContact, deletedContact].map(contactId => ({
    vaccineLogId: endpoints[1].id, contactId,
  })) });
  const before = await snapshot();
  const response = await getTimeline(getRequest('timeline', `?babyId=${babyId}&types=vaccine`));
  expect(response.status).toBe(200);
  const payload = await response.json();
  const entry = payload.data.find((item: { id: string }) => item.id === endpoints[1].id);
  expect(entry.contacts.map((link: { contactId: string }) => link.contactId).sort()).toEqual([oldContact, deletedContact].sort());
  expect(JSON.stringify(payload)).not.toContain(foreignContact);
  expect(await snapshot()).toEqual(before);
});

it('medicine contactId lookup requires both sides of a legacy association to belong to the family', async () => {
  await db.contactMedicine.createMany({ data: [
    { contactId: foreignContact, medicineId: endpoints[0].id },
    { contactId: oldContact, medicineId: 'contact-write-foreign-medicine' },
    { contactId: deletedContact, medicineId: endpoints[0].id },
  ] });
  const before = await snapshot();
  for (const [contactId, expected] of [[foreignContact, []], [oldContact, [endpoints[0].id]], [deletedContact, [endpoints[0].id]]] as const) {
    const response = await getMedicine(getRequest('medicine', `?contactId=${contactId}`));
    expect(response.status).toBe(200);
    expect((await response.json()).data.map((entry: { id: string }) => entry.id)).toEqual(expected);
  }
  expect(await snapshot()).toEqual(before);
});
