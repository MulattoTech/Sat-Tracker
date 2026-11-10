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
vi.mock('../src/lib/notifications/activityHook', () => ({
  notifyActivityCreated: vi.fn(async () => {}), resetTimerNotificationState: vi.fn(async () => {}),
}));
import { POST as postNote, PUT as putNote } from '../app/api/note/route';
import { POST as postSleep, PUT as putSleep } from '../app/api/sleep-log/route';
import { POST as postDiaper, PUT as putDiaper } from '../app/api/diaper-log/route';
import { GET as getMedicineLog, POST as postMedicine, PUT as putMedicine } from '../app/api/medicine-log/route';
import { POST as postMeasurement, PUT as putMeasurement } from '../app/api/measurement-log/route';
import { POST as postBath, PUT as putBath } from '../app/api/bath-log/route';
import { POST as postMilestone, PUT as putMilestone } from '../app/api/milestone-log/route';
import { POST as postCatalog, PUT as putCatalog } from '../app/api/medicine/route';
import { POST as postVaccine, PUT as putVaccine } from '../app/api/vaccine-log/route';
import { POST as postBaby, PUT as putBaby } from '../app/api/baby/route';
import { POST as postAdjustment, PUT as putAdjustment } from '../app/api/breast-milk-adjustment/route';
import { GET as getTimeline } from '../app/api/timeline/route';

const owner = 'care-write-family', foreign = 'care-write-foreign';
const ownChild = 'care-write-child', foreignChild = 'care-write-foreign-child';
const ownCarer = 'care-write-carer', foreignCarer = 'care-write-foreign-carer';
const ownMedicine = 'care-write-medicine', foreignMedicine = 'care-write-foreign-medicine';
const at = new Date('2026-10-20T12:00:00Z');
const careRoutes = [
  ['note', 'owned-note', postNote, putNote, { babyId: ownChild, time: at.toISOString(), content: 'Synthetic note', category: null }],
  ['sleep-log', 'owned-sleep', postSleep, putSleep, { babyId: ownChild, startTime: at.toISOString(), type: 'NAP', endTime: null, duration: null, location: null, quality: null, notes: null }],
  ['diaper-log', 'owned-diaper', postDiaper, putDiaper, { babyId: ownChild, time: at.toISOString(), type: 'WET', condition: null, color: null, blowout: false, creamApplied: false, notes: null }],
  ['medicine-log', 'owned-dose', postMedicine, putMedicine, { babyId: ownChild, medicineId: ownMedicine, time: at.toISOString(), doseAmount: 0, unitAbbr: null, notes: null }],
  ['measurement-log', 'owned-measurement', postMeasurement, putMeasurement, { babyId: ownChild, date: at.toISOString(), type: 'WEIGHT', value: 0, unit: 'kg', notes: null }],
  ['bath-log', 'owned-bath', postBath, putBath, { babyId: ownChild, time: at.toISOString(), bathType: 'Custom synthetic bath', soapUsed: false, shampooUsed: false, notes: null }],
  ['milestone-log', 'owned-milestone', postMilestone, putMilestone, { babyId: ownChild, date: at.toISOString(), title: 'Synthetic milestone', category: 'MOTOR', description: null, ageInDays: 0, photo: null }],
  ['vaccine-log', 'owned-vaccine', postVaccine, putVaccine, { babyId: ownChild, time: at.toISOString(), vaccineName: 'Synthetic vaccine', doseNumber: null, notes: null }],
  ['breast-milk-adjustment', 'owned-adjustment', postAdjustment, putAdjustment, { babyId: ownChild, time: at.toISOString(), amount: 0, unitAbbr: null, reason: '', notes: null }],
] as const;
const movableRoutes = [
  ['note', 'owned-note', putNote], ['sleep-log', 'owned-sleep', putSleep], ['bath-log', 'owned-bath', putBath],
  ['measurement-log', 'owned-measurement', putMeasurement], ['milestone-log', 'owned-milestone', putMilestone],
  ['breast-milk-adjustment', 'owned-adjustment', putAdjustment],
] as const;
let db: PrismaClient, directory: string, secret: string, previousSecret: string | undefined;
const token = () => jwt.sign({ id: ownCarer, familyId: owner, role: 'ADMIN', type: 'parent' }, secret, { expiresIn: '10m' });
const request = (route: string, id: string, body: unknown) => new NextRequest(`http://localhost/api/${route}?id=${id}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` }, body: JSON.stringify(body),
});
const createRequest = (route: string, body: unknown) => new NextRequest(`http://localhost/api/${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` }, body: JSON.stringify(body),
});
const snapshot = async () => ({
  families: await db.family.findMany({ orderBy: { id: 'asc' } }), babies: await db.baby.findMany({ orderBy: { id: 'asc' } }),
  caretakers: await db.caretaker.findMany({ orderBy: { id: 'asc' } }), medicines: await db.medicine.findMany({ orderBy: { id: 'asc' } }),
  notes: await db.note.findMany({ orderBy: { id: 'asc' } }), sleeps: await db.sleepLog.findMany({ orderBy: { id: 'asc' } }),
  diapers: await db.diaperLog.findMany({ orderBy: { id: 'asc' } }), doses: await db.medicineLog.findMany({ orderBy: { id: 'asc' } }),
  measurements: await db.measurement.findMany({ orderBy: { id: 'asc' } }), baths: await db.bathLog.findMany({ orderBy: { id: 'asc' } }),
  milestones: await db.milestone.findMany({ orderBy: { id: 'asc' } }), vaccines: await db.vaccineLog.findMany({ orderBy: { id: 'asc' } }),
  photos: await db.photo.findMany({ orderBy: { id: 'asc' } }), documents: await db.vaccineDocument.findMany({ orderBy: { id: 'asc' } }),
  contacts: await db.contact.findMany({ orderBy: { id: 'asc' } }),
  medicineContacts: await db.contactMedicine.findMany({ orderBy: [{ medicineId: 'asc' }, { contactId: 'asc' }] }),
  vaccineContacts: await db.contactVaccine.findMany({ orderBy: [{ vaccineLogId: 'asc' }, { contactId: 'asc' }] }),
  adjustments: await db.breastMilkAdjustment.findMany({ orderBy: { id: 'asc' } }),
});

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-care-write-boundaries-'));
  const url = 'file:' + path.join(directory, 'synthetic.db');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
  });
  previousSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = secret = randomBytes(32).toString('hex');
  state.db = db = new PrismaClient({ adapter: createPrismaAdapter(url) });
  await db.family.createMany({ data: [owner, foreign].map(id => ({ id, slug: id, name: 'Synthetic Family' })) });
  await db.baby.createMany({ data: [{ id: ownChild, familyId: owner }, { id: foreignChild, familyId: foreign }].map(value => ({
    ...value, firstName: 'Synthetic', lastName: 'Child', birthDate: new Date('2026-01-01T00:00:00Z'),
  })) });
  await db.caretaker.createMany({ data: [{ id: ownCarer, familyId: owner }, { id: foreignCarer, familyId: foreign }].map(value => ({
    ...value, name: 'Synthetic Caregiver', type: 'Parent', role: 'ADMIN', loginId: value.id, securityPin: '123456',
  })) });
  await db.medicine.createMany({ data: [{ id: ownMedicine, familyId: owner }, { id: foreignMedicine, familyId: foreign }].map(value => ({
    ...value, name: 'Synthetic medicine', active: true,
  })) });
}, 90_000);

beforeEach(async () => {
  await db.photo.deleteMany(); await db.vaccineDocument.deleteMany(); await db.contactVaccine.deleteMany();
  await db.contactMedicine.deleteMany(); await db.contact.deleteMany();
  await db.milestone.deleteMany(); await db.vaccineLog.deleteMany(); await db.breastMilkAdjustment.deleteMany();
  await db.note.deleteMany(); await db.sleepLog.deleteMany(); await db.diaperLog.deleteMany();
  await db.medicineLog.deleteMany(); await db.measurement.deleteMany(); await db.bathLog.deleteMany();
  await db.baby.deleteMany({ where: { id: { notIn: [ownChild, foreignChild] } } });
  await db.medicine.deleteMany({ where: { id: { notIn: [ownMedicine, foreignMedicine] } } });
  await db.family.updateMany({ data: { name: 'Synthetic Family', setupStage: 3 } });
  await db.baby.update({ where: { id: ownChild }, data: { familyId: owner, firstName: 'Synthetic', deletedAt: null } });
  await db.baby.update({ where: { id: foreignChild }, data: { familyId: foreign, firstName: 'Synthetic', deletedAt: null } });
  await db.medicine.updateMany({ data: { name: 'Synthetic medicine' } });
  await db.medicine.update({ where: { id: ownMedicine }, data: { familyId: owner } });
  await db.medicine.update({ where: { id: foreignMedicine }, data: { familyId: foreign } });
  const ownership = { familyId: owner, babyId: ownChild, caretakerId: ownCarer };
  await db.note.create({ data: { ...ownership, id: 'owned-note', time: at, content: 'Synthetic note' } });
  await db.sleepLog.create({ data: { ...ownership, id: 'owned-sleep', startTime: at, type: 'NAP', location: 'Crib' } });
  await db.diaperLog.create({ data: { ...ownership, id: 'owned-diaper', time: at, type: 'WET' } });
  await db.medicineLog.create({ data: { ...ownership, id: 'owned-dose', medicineId: ownMedicine, time: at, doseAmount: 1 } });
  await db.measurement.create({ data: { ...ownership, id: 'owned-measurement', date: at, type: 'WEIGHT', value: 4, unit: 'kg' } });
  await db.bathLog.create({ data: { ...ownership, id: 'owned-bath', time: at } });
  const foreignOwnership = { familyId: foreign, babyId: foreignChild, caretakerId: foreignCarer };
  await db.note.create({ data: { ...foreignOwnership, id: 'foreign-note', time: at, content: 'Foreign synthetic note' } });
  await db.medicineLog.create({ data: { ...foreignOwnership, id: 'foreign-dose', medicineId: foreignMedicine, time: at, doseAmount: 1 } });
  await db.milestone.create({ data: { ...ownership, id: 'owned-milestone', date: at, title: 'Synthetic milestone', category: 'MOTOR' } });
  await db.vaccineLog.create({ data: { ...ownership, id: 'owned-vaccine', time: at, vaccineName: 'Synthetic vaccine' } });
  await db.vaccineLog.create({ data: { ...foreignOwnership, id: 'foreign-vaccine', time: at, vaccineName: 'Foreign synthetic vaccine' } });
  await db.photo.create({ data: { ...foreignOwnership, id: 'foreign-photo', originalName: 'synthetic.jpg', storedName: 'synthetic.enc', thumbStoredName: 'synthetic-thumb.enc', mimeType: 'image/jpeg', fileSize: 1, thumbSize: 1, takenAt: at } });
  await db.vaccineDocument.create({ data: { id: 'foreign-document', vaccineLogId: 'foreign-vaccine', originalName: 'synthetic.pdf', storedName: 'synthetic.enc', mimeType: 'application/pdf', fileSize: 1 } });
  await db.contact.createMany({ data: [{ id: 'own-contact', familyId: owner }, { id: 'foreign-contact', familyId: foreign }].map(value => ({ ...value, name: 'Synthetic contact', role: 'doctor', email: 'synthetic@example.invalid' })) });
  await db.contactMedicine.create({ data: { medicineId: ownMedicine, contactId: 'own-contact' } });
  await db.contactVaccine.create({ data: { vaccineLogId: 'owned-vaccine', contactId: 'own-contact' } });
  await db.breastMilkAdjustment.create({ data: { ...ownership, id: 'owned-adjustment', time: at, amount: 1 } });
});

afterAll(async () => {
  await db?.$disconnect();
  if (directory) rmSync(directory, { recursive: true, force: true });
  if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
});

describe('timeline preserves owned history while scoping expanded legacy relations', () => {
  it('omits foreign medicine and caregiver details without deleting an owned dose or note', async () => {
    await db.medicineLog.update({ where: { id: 'owned-dose' }, data: { medicineId: foreignMedicine, caretakerId: foreignCarer } });
    await db.note.update({ where: { id: 'owned-note' }, data: { caretakerId: foreignCarer } });
    const before = await snapshot();
    const response = await getTimeline(new NextRequest(`http://localhost/api/timeline?babyId=${ownChild}&types=medicine,note`, {
      headers: { Authorization: `Bearer ${token()}` },
    }));
    expect(response.status).toBe(200);
    const entries = (await response.json()).data;
    const dose = entries.find((entry: { id: string }) => entry.id === 'owned-dose');
    const note = entries.find((entry: { id: string }) => entry.id === 'owned-note');
    expect(dose).toMatchObject({ id: 'owned-dose', babyId: ownChild, medicineId: foreignMedicine, caretakerId: foreignCarer });
    expect(dose.medicine).toBeUndefined(); expect(dose.caretakerName).toBeUndefined();
    expect(note).toMatchObject({ id: 'owned-note', content: 'Synthetic note', caretakerId: foreignCarer });
    expect(note.caretakerName).toBeUndefined();
    expect(await snapshot()).toEqual(before);
  });

  it('keeps ordinary same-family medicine details and caregiver badges without caregiver credentials', async () => {
    const before = await snapshot();
    const response = await getTimeline(new NextRequest(`http://localhost/api/timeline?babyId=${ownChild}&types=medicine,note`, {
      headers: { Authorization: `Bearer ${token()}` },
    }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    const dose = payload.data.find((entry: { id: string }) => entry.id === 'owned-dose');
    expect(dose).toMatchObject({ medicine: { id: ownMedicine, name: 'Synthetic medicine' }, caretakerName: 'Synthetic Caregiver' });
    expect(JSON.stringify(payload)).not.toContain('securityPin');
    expect(await snapshot()).toEqual(before);
  });
});

describe('canonical care writes reject client-owned persistence instructions', () => {
  it('does not move a note into another family using client ownership scalars', async () => {
    const before = await snapshot();
    const response = await putNote(request('note', 'owned-note', { familyId: foreign, babyId: foreignChild, caretakerId: foreignCarer }));
    expect.soft(response.status).toBe(400); expect(await snapshot()).toEqual(before);
  });

  it('does not move sleep history into another family using client ownership scalars', async () => {
    const before = await snapshot();
    const response = await putSleep(request('sleep-log', 'owned-sleep', { familyId: foreign, babyId: foreignChild, caretakerId: foreignCarer }));
    expect.soft(response.status).toBe(400); expect(await snapshot()).toEqual(before);
  });

  it('does not let an owned diaper record update another family child through a nested relation', async () => {
    const before = await snapshot();
    const response = await putDiaper(request('diaper-log', 'owned-diaper', {
      baby: { connect: { id: foreignChild }, update: { firstName: 'Unauthorized synthetic change' } },
    }));
    expect.soft(response.status).toBe(400); expect(await snapshot()).toEqual(before);
  });

  it('does not let an owned dose update another family medicine through a nested relation', async () => {
    const before = await snapshot();
    const response = await putMedicine(request('medicine-log', 'owned-dose', {
      medicine: { connect: { id: foreignMedicine }, update: { name: 'Unauthorized synthetic change' } },
    }));
    expect.soft(response.status).toBe(400); expect(await snapshot()).toEqual(before);
  });

  it('does not let an owned note update another family through a nested relation', async () => {
    const before = await snapshot();
    const response = await putNote(request('note', 'owned-note', {
      family: { connect: { id: foreign }, update: { name: 'Unauthorized synthetic change' } },
    }));
    expect.soft(response.status).toBe(400); expect(await snapshot()).toEqual(before);
  });

  it('does not reattribute a measurement through unvalidated child/caregiver IDs', async () => {
    const before = await snapshot();
    const response = await putMeasurement(request('measurement-log', 'owned-measurement', { babyId: foreignChild, caretakerId: foreignCarer }));
    expect.soft(response.status).toBe(400); expect(await snapshot()).toEqual(before);
  });

  it('does not move bath history into another family using client ownership scalars', async () => {
    const before = await snapshot();
    const response = await putBath(request('bath-log', 'owned-bath', { familyId: foreign, babyId: foreignChild, caretakerId: foreignCarer }));
    expect.soft(response.status).toBe(400); expect(await snapshot()).toEqual(before);
  });

  it('still permits ordinary scalar corrections to each authorized care record', async () => {
    for (const [route, id, handler, patch] of [
      ['note', 'owned-note', putNote, { content: 'Corrected synthetic note' }],
      ['sleep-log', 'owned-sleep', putSleep, { location: 'Contact' }],
      ['diaper-log', 'owned-diaper', putDiaper, { type: 'BOTH' }],
      ['medicine-log', 'owned-dose', putMedicine, { doseAmount: 2 }],
      ['measurement-log', 'owned-measurement', putMeasurement, { value: 4.2 }],
      ['bath-log', 'owned-bath', putBath, { soapUsed: false }],
    ] as const) {
      const response = await handler(request(route, id, patch));
      expect(response.status, route).toBe(200);
      expect((await response.json()).data).toMatchObject({ id, familyId: owner, babyId: ownChild, caretakerId: ownCarer, ...patch });
    }
  });

  it.each([
    ['milestone-log', 'owned-milestone', putMilestone, { family: { connect: { id: foreign }, update: { name: 'Unauthorized' } } }],
    ['medicine', ownMedicine, putCatalog, { family: { connect: { id: foreign }, update: { name: 'Unauthorized' } } }],
    ['vaccine-log', 'owned-vaccine', putVaccine, { baby: { connect: { id: foreignChild }, update: { firstName: 'Unauthorized' } } }],
    ['baby', ownChild, putBaby, { id: ownChild, family: { connect: { id: foreign }, update: { name: 'Unauthorized' } } }],
  ] as const)('rejects relation mutation through %s PUT', async (route, id, handler, body) => {
    const before = await snapshot();
    const response = await handler(request(route, id, body));
    expect.soft(response.status).toBe(400); expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['baby', postBaby, { firstName: 'New', lastName: 'Synthetic', birthDate: at.toISOString(), notes: { connect: { id: 'foreign-note' } } }],
    ['milestone-log', postMilestone, { babyId: ownChild, date: at.toISOString(), title: 'New synthetic milestone', category: 'MOTOR', photos: { connect: { id: 'foreign-photo' } } }],
    ['medicine', postCatalog, { name: 'New synthetic medicine', medicineLogs: { connect: { id: 'foreign-dose' } } }],
    ['vaccine-log', postVaccine, { babyId: ownChild, time: at.toISOString(), vaccineName: 'New synthetic vaccine', documents: { connect: { id: 'foreign-document' } } }],
  ] as const)('rejects unchecked foreign collection attachment through %s POST', async (route, handler, body) => {
    const before = await snapshot();
    const response = await handler(createRequest(route, body));
    expect.soft(response.status).toBe(400); expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['medicine', ownMedicine, putCatalog, { name: 'Changed', contactIds: ['foreign-contact'] }],
    ['vaccine-log', 'owned-vaccine', putVaccine, { vaccineName: 'Changed', contactIds: ['foreign-contact'] }],
  ] as const)('does not link or return foreign contacts through %s PUT', async (route, id, handler, body) => {
    const before = await snapshot();
    const response = await handler(request(route, id, body));
    expect.soft(response.status).toBe(404); expect(await snapshot()).toEqual(before);
    expect(await response.text()).not.toContain('synthetic@example.invalid');
  });

  it.each([
    ['medicine', postCatalog, { name: 'New synthetic medicine', contactIds: ['foreign-contact'] }],
    ['vaccine-log', postVaccine, { babyId: ownChild, time: at.toISOString(), vaccineName: 'New synthetic vaccine', contactIds: ['foreign-contact'] }],
  ] as const)('does not create partial records with foreign contacts through %s POST', async (route, handler, body) => {
    const before = await snapshot();
    const response = await handler(createRequest(route, body));
    expect.soft(response.status).toBe(404); expect(await snapshot()).toEqual(before);
  });

  it('does not change adjustment ownership through an unchecked child ID', async () => {
    const before = await snapshot();
    const response = await putAdjustment(request('breast-milk-adjustment', 'owned-adjustment', { babyId: foreignChild }));
    expect.soft(response.status).toBe(404); expect(await snapshot()).toEqual(before);
  });

  it('rejects scalar operation objects and client audit fields before writing', async () => {
    for (const body of [{ content: { set: 'Unauthorized' } }, { deletedAt: at.toISOString() }, { id: 'new-client-id' }]) {
      const before = await snapshot();
      const response = await putNote(request('note', 'owned-note', body));
      expect.soft(response.status).toBe(400); expect(await snapshot()).toEqual(before);
    }
  });

  it('rejects client-assigned metadata during leaf creation', async () => {
    const before = await snapshot();
    const response = await postNote(createRequest('note', { babyId: ownChild, time: at.toISOString(), content: 'Synthetic', id: 'client-chosen-id', deletedAt: at.toISOString() }));
    expect.soft(response.status).toBe(400); expect(await snapshot()).toEqual(before);
  });

  it.each(careRoutes)('%s preserves ordinary create/edit payloads, nulls and falsy scalars', async (route, id, post, put, body) => {
    const created = await post(createRequest(route, body));
    expect(created.status).toBe(200);
    expect((await created.json()).data).toMatchObject({ ...body, familyId: owner, caretakerId: ownCarer });
    const corrected = await put(request(route, id, body));
    expect(corrected.status).toBe(200);
    expect((await corrected.json()).data).toMatchObject({ ...body, id, familyId: owner, caretakerId: ownCarer });
  });

  it('preserves nursery sleep end-only and undo payloads', async () => {
    const ended = await putSleep(request('sleep-log', 'owned-sleep', { endTime: '2026-10-20T12:30:00.000Z' }));
    expect(ended.status).toBe(200);
    expect((await ended.json()).data).toMatchObject({ duration: 30, endTime: '2026-10-20T12:30:00.000Z' });
    const undone = await putSleep(request('sleep-log', 'owned-sleep', { endTime: null, duration: null }));
    expect(undone.status).toBe(200);
    expect((await undone.json()).data).toMatchObject({ duration: null, endTime: null });
  });

  it.each(movableRoutes)('%s validates changed child ownership while retaining same-family corrections', async (route, id, put) => {
    const sibling = await db.baby.create({ data: { familyId: owner, firstName: 'Synthetic sibling', lastName: 'Child', birthDate: at } });
    const removed = await db.baby.create({ data: { familyId: owner, firstName: 'Synthetic removed', lastName: 'Child', birthDate: at, deletedAt: at } });
    for (const babyId of [foreignChild, removed.id, 'missing-synthetic-child']) {
      const before = await snapshot();
      const response = await put(request(route, id, { babyId }));
      expect.soft(response.status).toBe(404); expect(await snapshot()).toEqual(before);
    }
    const response = await put(request(route, id, { babyId: sibling.id }));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ id, babyId: sibling.id, familyId: owner, caretakerId: ownCarer });
  });

  it.each(careRoutes)('%s rejects removed-child creation and scalar ownership/audit injection', async (route, id, post, put, body) => {
    await db.baby.update({ where: { id: ownChild }, data: { deletedAt: at } });
    let before = await snapshot();
    expect((await post(createRequest(route, body))).status).toBe(404);
    expect(await snapshot()).toEqual(before);
    for (const injected of [{ caretakerId: foreignCarer }, { familyId: foreign }, { createdAt: at.toISOString() }, { updatedAt: at.toISOString() }, { deletedAt: at.toISOString() }]) {
      before = await snapshot();
      expect((await put(request(route, id, injected))).status).toBe(400);
      expect(await snapshot()).toEqual(before);
    }
  });

  it.each(careRoutes)('%s rejects malformed JSON shapes and nested operations', async (route, id, post, put, body) => {
    for (const invalid of [null, [], 'not an object', { babyId: { set: foreignChild } }, { baby: { connect: { id: foreignChild } } }]) {
      const before = await snapshot();
      expect((await put(request(route, id, invalid))).status).toBe(400);
      expect(await snapshot()).toEqual(before);
    }
    for (const injected of [{ family: { connect: { id: foreign } } }, { caretaker: { connect: { id: foreignCarer } } }]) {
      const before = await snapshot();
      expect((await post(createRequest(route, { ...body, ...injected }))).status).toBe(400);
      expect(await snapshot()).toEqual(before);
    }
  });

  it('keeps diaper, dose and vaccine child/medicine IDs immutable with ordinary identifier echoes', async () => {
    for (const [route, id, put, patch] of [
      ['diaper-log', 'owned-diaper', putDiaper, { babyId: foreignChild, notes: '' }],
      ['medicine-log', 'owned-dose', putMedicine, { babyId: foreignChild, medicineId: foreignMedicine, doseAmount: 0 }],
      ['vaccine-log', 'owned-vaccine', putVaccine, { babyId: foreignChild, notes: null }],
    ] as const) {
      const response = await put(request(route, id, patch));
      expect(response.status).toBe(200);
      expect((await response.json()).data).toMatchObject({ id, babyId: ownChild, familyId: owner, caretakerId: ownCarer, ...(route === 'medicine-log' ? { medicineId: ownMedicine } : {}) });
    }
  });

  it('preserves canonical baby family confirmation and editable preference fields', async () => {
    const response = await putBaby(request('baby', ownChild, { id: ownChild, familyId: owner, firstName: 'Corrected', gender: null, inactive: false, feedWarningTime: '03:00', diaperWarningTime: '02:00', feedTimerFrom: 'end', feedTimerTypes: null }));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ id: ownChild, familyId: owner, firstName: 'Corrected', gender: null, inactive: false, feedTimerFrom: 'end', feedTimerTypes: null });
    const before = await snapshot();
    expect((await putBaby(request('baby', ownChild, { id: ownChild, familyId: foreign, firstName: 'Unauthorized' }))).status).toBe(403);
    expect(await snapshot()).toEqual(before);
  });

  it('does not expose legacy foreign medicine contacts through dose reads or rewrite their links', async () => {
    await db.contactMedicine.create({ data: { medicineId: ownMedicine, contactId: 'foreign-contact' } });
    const before = await snapshot();
    for (const query of ['id=owned-dose', `babyId=${ownChild}`]) {
      const response = await getMedicineLog(new NextRequest(`http://localhost/api/medicine-log?${query}`, { headers: { Authorization: `Bearer ${token()}` } }));
      expect(response.status).toBe(200);
      const body = await response.json();
      const rows = Array.isArray(body.data) ? body.data : [body.data];
      expect(rows).toHaveLength(1);
      expect(rows[0].medicine.contacts.map((link: { contactId: string }) => link.contactId)).toEqual(['own-contact']);
      expect(JSON.stringify(body)).not.toContain('foreign-contact');
    }
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['medicineId', foreignMedicine, 'medicine'],
    ['babyId', foreignChild, 'baby'],
    ['caretakerId', foreignCarer, 'caretaker'],
  ] as const)('retains an owned dose but omits a legacy foreign %s relation', async (field, value, relation) => {
    await db.medicineLog.update({ where: { id: 'owned-dose' }, data: { [field]: value } });
    const before = await snapshot();
    for (const query of ['?id=owned-dose', '']) {
      const response = await getMedicineLog(new NextRequest(`http://localhost/api/medicine-log${query}`, { headers: { Authorization: `Bearer ${token()}` } }));
      expect(response.status).toBe(200);
      const result = await response.json();
      const rows = Array.isArray(result.data) ? result.data : [result.data];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 'owned-dose', familyId: owner, doseAmount: 1, [field]: value });
      expect(rows[0][relation]).toBeUndefined();
    }
    expect(await snapshot()).toEqual(before);
  });

  it('returns authorized dose details without exposing caregiver login credentials', async () => {
    const response = await getMedicineLog(new NextRequest('http://localhost/api/medicine-log?id=owned-dose', { headers: { Authorization: `Bearer ${token()}` } }));
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.medicine).toMatchObject({ id: ownMedicine, familyId: owner, name: 'Synthetic medicine' });
    expect(data.baby).toMatchObject({ id: ownChild, familyId: owner, firstName: 'Synthetic' });
    expect(data.caretaker).toMatchObject({ id: ownCarer, familyId: owner, name: 'Synthetic Caregiver' });
    expect(data.caretaker).not.toHaveProperty('securityPin');
  });
});
