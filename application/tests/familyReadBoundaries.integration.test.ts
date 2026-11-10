import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
vi.mock('../app/api/db', () => ({ get default() { return state.db; } }));
vi.mock('../app/api/utils/api-logger', () => ({ logApiCall: vi.fn(async () => {}), getClientInfo: () => ({ ip: '127.0.0.58' }) }));
vi.mock('../src/lib/notifications/activityHook', () => ({ notifyActivityCreated: vi.fn(async () => {}), resetTimerNotificationState: vi.fn(async () => {}) }));
// The login, USER authorization, API-key issuance, read-scope middleware and all read handlers remain real.
import { POST as login } from '../app/api/auth/route';
import { POST as createKey } from '../app/api/api-keys/route';
import { GET as timeline } from '../app/api/timeline/route';
import { GET as exportTimeline } from '../app/api/timeline/export/route';
import { GET as activities, POST as writeActivity } from '../app/api/hooks/v1/babies/[babyId]/activities/route';
import { PUT as correctActivity, DELETE as removeActivity } from '../app/api/hooks/v1/babies/[babyId]/activities/[activityId]/route';
import { GET as status } from '../app/api/hooks/v1/babies/[babyId]/status/route';
import { GET as latestMeasurements } from '../app/api/hooks/v1/babies/[babyId]/measurements/latest/route';
import { GET as reference } from '../app/api/hooks/v1/babies/[babyId]/reference/route';

const familyId = 'read-family', otherFamilyId = 'read-foreign-family';
const babyId = 'read-child', foreignBaby = 'read-foreign-child';
const caregiver = 'read-caregiver', admin = 'read-admin', foreignCaregiver = 'read-foreign-caregiver';
const nullCaregiver = 'read-unresolved-caregiver', deletedCaregiver = 'read-deleted-caregiver';
const ownMedicine = 'read-medicine', ownSupplement = 'read-supplement', deletedMedicine = 'read-deleted-medicine';
const ownFood = 'read-food', deletedFood = 'read-deleted-food';
const at = new Date('2026-10-20T12:00:00.000Z'), newer = new Date('2026-10-20T12:30:00.000Z');
const kinds = ['feed', 'diaper', 'sleep', 'note', 'pump', 'bath', 'measurement', 'medicine', 'supplement', 'play'] as const;
type CareKind = typeof kinds[number];
type CareOptions = { familyId?: string | null; caretakerId?: string | null; time?: Date; deletedAt?: Date | null; medicineId?: string };
const badOwners = [['foreign', otherFamilyId], ['unresolved', null]] as const;
let db: PrismaClient, directory: string, secret: string, previousSecret: string | undefined, previousMode: string | undefined;
let userToken: string, adminToken: string, foreignToken: string, key: string;

function request(endpoint: string, token: string | null = userToken, method = 'GET', body?: unknown) {
  return new NextRequest(`http://localhost${endpoint}`, { method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const context = (child = babyId) => ({ params: Promise.resolve({ babyId: child }) });
const hookRequest = (suffix: string, token: string | null = key, child = babyId) => request(`/api/hooks/v1/babies/${child}/${suffix}`, token);
const timelineRequest = () => request(`/api/timeline?babyId=${babyId}&limit=100`);
const list = (query = '') => activities(hookRequest(`activities?since=2026-01-01T00:00:00Z&limit=50${query}`), context());
async function data(response: Response) {
  const body = await response.json(); expect(response.status).toBe(200); expect(body.success).toBe(true); return body.data;
}

async function writableKey() {
  const response = await createKey(request('/api/api-keys', adminToken, 'POST', { name: 'Synthetic correction key', scopes: ['read', 'write'] }));
  expect(response.status).toBe(200); const body = await response.json(); return body.data.fullKey as string;
}

const mutationContext = (activityId = 'owned-dose') => ({ params: Promise.resolve({ babyId, activityId }) });
const mutationRequest = (method: 'PUT' | 'DELETE', token: string, type?: string, body?: Record<string, unknown>, id = 'owned-dose') =>
  request(`/api/hooks/v1/babies/${babyId}/activities/${id}${method === 'DELETE' && type ? `?type=${type}` : ''}`, token, method,
    method === 'PUT' ? { ...body, type } : body);

async function createCare(kind: CareKind, id: string, options: CareOptions = {}) {
  const common = { id, familyId, babyId, caretakerId: caregiver, deletedAt: null, ...options };
  const time = options.time || at;
  // Each model has its real scalar fields; unrelated option fields must not enter Prisma data.
  const { time: _time, medicineId: _medicineId, ...ownership } = common;
  switch (kind) {
    case 'feed': return db.feedLog.create({ data: { ...ownership, time, type: 'BOTTLE', amount: 75, unitAbbr: 'ML', notes: id } });
    case 'diaper': return db.diaperLog.create({ data: { ...ownership, time, type: 'WET', notes: id } });
    case 'sleep': return db.sleepLog.create({ data: { ...ownership, startTime: time, endTime: new Date(time.getTime() + 60000), duration: 1, type: 'NAP', location: `${id} location`, notes: id } });
    case 'note': return db.note.create({ data: { ...ownership, time, content: id, category: 'Synthetic' } });
    case 'pump': return db.pumpLog.create({ data: { ...ownership, startTime: time, endTime: time, duration: 0, totalAmount: 30, unitAbbr: 'ML', pumpAction: 'UNKNOWN', notes: id } });
    case 'bath': return db.bathLog.create({ data: { ...ownership, time, bathType: id, notes: id } });
    case 'measurement': return db.measurement.create({ data: { ...ownership, date: time, type: 'WEIGHT', value: 7.5, unit: 'kg', notes: id } });
    case 'medicine':
    case 'supplement': return db.medicineLog.create({ data: { ...ownership, time, medicineId: options.medicineId || (kind === 'supplement' ? ownSupplement : ownMedicine), doseAmount: 2, unitAbbr: 'ML', notes: id } });
    case 'play': return db.playLog.create({ data: { ...ownership, startTime: time, endTime: time, duration: 0, type: 'TUMMY_TIME', activities: `${id} activity`, notes: id } });
  }
}

async function exportRows(format: 'csv' | 'xlsx') {
  const response = await exportTimeline(request(`/api/timeline/export?babyId=${babyId}&format=${format}&timezone=UTC&language=en`));
  expect(response.status).toBe(200);
  if (format === 'csv') return parse(await response.text(), { columns: true }) as Record<string, string>[];
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await response.arrayBuffer());
  const sheet = workbook.worksheets[0], headers = (sheet.getRow(1).values as string[]).slice(1);
  const rows: Record<string, string>[] = [];
  sheet.eachRow((row, index) => { if (index > 1) rows.push(Object.fromEntries(headers.map((header, i) => [header, row.getCell(i + 1).text]))); });
  return rows;
}

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-family-read-boundaries-'));
  const url = `file:${path.join(directory, 'synthetic.db')}`;
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60000 });
  previousSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = secret = randomBytes(32).toString('hex');
  previousMode = process.env.DEPLOYMENT_MODE; process.env.DEPLOYMENT_MODE = 'selfhosted';
  state.db = db = new PrismaClient({ adapter: createPrismaAdapter(url) });
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-20T13:00:00.000Z'));
  await db.family.createMany({ data: [familyId, otherFamilyId].map(id => ({ id, slug: id, name: 'Synthetic Read Family', setupStage: 3 })) });
  await db.settings.createMany({ data: [familyId, otherFamilyId].map(id => ({ familyId: id, authType: 'CARETAKER' })) });
  await db.unit.create({ data: { unitAbbr: 'ML', unitName: 'Milliliters' } });
  await db.baby.createMany({ data: [{ id: babyId, familyId }, { id: foreignBaby, familyId: otherFamilyId }].map(row => ({ ...row, firstName: 'Synthetic', lastName: 'Read Child', birthDate: new Date('2026-01-01T00:00:00Z') })) });
  await db.caretaker.createMany({ data: [
    { id: caregiver, familyId, role: 'USER' as const }, { id: admin, familyId, role: 'ADMIN' as const },
    { id: foreignCaregiver, familyId: otherFamilyId, role: 'USER' as const },
    { id: nullCaregiver, familyId: null, role: 'USER' as const },
    { id: deletedCaregiver, familyId, role: 'USER' as const, deletedAt: at },
  ].map((row, index) => ({ ...row, name: `Synthetic ${row.id}`, loginId: `r${index}`, securityPin: '830271', type: 'Parent' })) });
  await db.medicine.createMany({ data: [
    { id: ownMedicine, familyId, isSupplement: false }, { id: ownSupplement, familyId, isSupplement: true },
    { id: deletedMedicine, familyId, isSupplement: false, deletedAt: at },
    ...badOwners.flatMap(([kind, owner]) => [false, true].map(isSupplement => ({ id: `${kind}-${isSupplement ? 'supplement' : 'medicine'}`, familyId: owner, isSupplement }))),
  ].map(row => ({ ...row, name: `Synthetic ${row.id}`, notes: `PRIVATE_CATALOG_${row.id}`, unitAbbr: 'ML' })) });
  await db.food.createMany({ data: [
    { id: ownFood, familyId, commonAllergen: false }, { id: deletedFood, familyId, commonAllergen: true, deletedAt: at },
    ...badOwners.map(([kind, owner]) => ({ id: `${kind}-food`, familyId: owner, commonAllergen: true })),
  ].map(row => ({ ...row, name: `Synthetic ${row.id}` })) });
  const tokens = [];
  for (const [index, person, owner, role] of [[0, caregiver, familyId, 'USER'], [1, admin, familyId, 'ADMIN'], [2, foreignCaregiver, otherFamilyId, 'USER']] as const) {
    const response = await login(request('/api/auth', null, 'POST', { loginId: `r${index}`, securityPin: '830271', familySlug: owner }));
    expect(response.status).toBe(200); const body = await response.json();
    expect(body.data.role).toBe(role); expect(jwt.verify(body.data.token, secret)).toMatchObject({ id: person, familyId: owner, role }); tokens.push(body.data.token);
  }
  [userToken, adminToken, foreignToken] = tokens;
}, 90000);

beforeEach(async () => {
  await db.activeBreastFeed.deleteMany(); await db.feedLog.deleteMany(); await db.diaperLog.deleteMany();
  await db.sleepLog.deleteMany(); await db.note.deleteMany(); await db.pumpLog.deleteMany(); await db.bathLog.deleteMany();
  await db.measurement.deleteMany(); await db.medicineLog.deleteMany(); await db.playLog.deleteMany(); await db.foodLog.deleteMany(); await db.apiKey.deleteMany();
  const response = await createKey(request('/api/api-keys', adminToken, 'POST', { name: 'Synthetic read boundary key', scopes: ['read'] }));
  expect(response.status).toBe(200); const body = await response.json(); key = body.data.fullKey;
  const issued = await db.apiKey.findUniqueOrThrow({ where: { id: body.data.id } });
  expect(issued.familyId).toBe(familyId); expect(JSON.parse(issued.scopes)).toEqual(['read']);
});

afterAll(async () => {
  await db?.$disconnect(); if (directory) rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
  if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
  if (previousMode === undefined) delete process.env.DEPLOYMENT_MODE; else process.env.DEPLOYMENT_MODE = previousMode;
});

describe('family read boundaries through real USER/read-only-key auth and migrated SQLite', () => {
  it('retains missing authentication, foreign child, role and read-only scope denials', async () => {
    expect((await timeline(request(`/api/timeline?babyId=${babyId}`, null))).status).toBe(401);
    expect((await timeline(request(`/api/timeline?babyId=${babyId}`, foreignToken))).status).toBe(404);
    expect((await createKey(request('/api/api-keys', userToken, 'POST', { name: 'Denied', scopes: ['read'] }))).status).toBe(403);
    expect((await activities(hookRequest('activities', null), context())).status).toBe(401);
    expect((await activities(hookRequest('activities', 'st_live_invalid'), context())).status).toBe(401);
    expect((await activities(hookRequest('activities', key, foreignBaby), context(foreignBaby))).status).toBe(404);
    expect((await writeActivity(request(`/api/hooks/v1/babies/${babyId}/activities`, key, 'POST', { type: 'diaper', diaperType: 'WET' }), context())).status).toBe(403);
  });

  it('keeps the existing canonical row and caretaker/medicine family boundaries', async () => {
    await createCare('diaper', 'owned', { caretakerId: foreignCaregiver });
    await createCare('medicine', 'owned-dose', { medicineId: 'foreign-medicine', caretakerId: foreignCaregiver });
    await createCare('diaper', 'foreign-row', { familyId: otherFamilyId, time: newer });
    const rows = await data(await timeline(timelineRequest()));
    expect(rows.map((row: { id: string }) => row.id).sort()).toEqual(['owned', 'owned-dose']);
    expect(JSON.stringify(rows)).not.toContain(`Synthetic ${foreignCaregiver}`);
    expect(JSON.stringify(rows)).not.toContain('Synthetic foreign-medicine');
  });

  it.each(badOwners)('hides %s food metadata on both legacy and dual-written singleton meals', async (kind) => {
    for (const dual of [false, true]) await db.foodLog.create({ data: { id: `food-${dual}`, familyId, babyId, caretakerId: caregiver,
      time: at, foodId: `${kind}-food`, ...(dual ? { foods: JSON.stringify([{ foodId: `${kind}-food`, hadReaction: true, reactionDescription: 'Owned reaction' }]) } : {}),
      amount: 3, unitAbbr: 'G', hadReaction: true, reactionDescription: 'Owned reaction', enjoyment: 'LIKED' } });
    const rows = await data(await timeline(timelineRequest())); expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ familyId, babyId, foodId: `${kind}-food`, amount: 3, hadReaction: true, reactionDescription: 'Owned reaction', enjoyment: 'LIKED' });
      expect(row.food).toBeNull();
      expect(row.foodItems).toEqual([{ foodId: `${kind}-food`, hadReaction: true, reactionDescription: 'Owned reaction' }]);
      expect(row.foodItems[0]).not.toHaveProperty('commonAllergen');
    }
  });

  it('preserves owned multi-food and deleted historical food/caretaker metadata without borrowing a foreign item', async () => {
    await db.foodLog.create({ data: { id: 'multi', familyId, babyId, caretakerId: deletedCaregiver, time: at,
      foods: JSON.stringify([{ foodId: ownFood }, { foodId: deletedFood }, { foodId: 'foreign-food' }]) } });
    const [row] = await data(await timeline(timelineRequest()));
    expect(row.caretakerName).toBe(`Synthetic ${deletedCaregiver}`);
    expect(row.foodItems).toEqual([
      { foodId: ownFood, hadReaction: false, reactionDescription: null, name: `Synthetic ${ownFood}`, commonAllergen: false },
      { foodId: deletedFood, hadReaction: false, reactionDescription: null, name: `Synthetic ${deletedFood}`, commonAllergen: true },
      { foodId: 'foreign-food', hadReaction: false, reactionDescription: null },
    ]);
  });

  it.each(['csv', 'xlsx'] as const)('%s preserves own historical export rows while suppressing foreign/unresolved related labels', async format => {
    for (const [kind, owner] of badOwners) {
      const caretakerId = kind === 'foreign' ? foreignCaregiver : nullCaregiver;
      await createCare('diaper', `${kind}-diaper`, { caretakerId });
      await createCare('medicine', `${kind}-dose`, { caretakerId, medicineId: `${kind}-medicine` });
      await db.foodLog.create({ data: { id: `${kind}-meal`, familyId, babyId, caretakerId, time: at, foodId: `${kind}-food`, notes: `${kind}-meal` } });
      await createCare('note', `${kind}-row`, { familyId: owner, time: newer });
    }
    await createCare('medicine', 'owned-deleted-dose', { caretakerId: deletedCaregiver, medicineId: deletedMedicine });
    await db.foodLog.create({ data: { id: 'owned-deleted-meal', familyId, babyId, caretakerId: deletedCaregiver, time: at, foodId: deletedFood, notes: 'owned-deleted-meal' } });
    const rows = await exportRows(format); expect(rows).toHaveLength(8);
    for (const [kind] of badOwners) for (const type of ['diaper', 'dose', 'meal']) {
      const row = rows.find(item => item.Notes === `${kind}-${type}`); expect(row).toBeDefined();
      expect(row?.Caretaker).toBe(''); expect(row?.Details).toBe('');
    }
    expect(rows.find(row => row.Notes === 'owned-deleted-dose')).toMatchObject({ Details: `Synthetic ${deletedMedicine}`, Caretaker: `Synthetic ${deletedCaregiver}` });
    expect(rows.find(row => row.Notes === 'owned-deleted-meal')).toMatchObject({ Details: `Synthetic ${deletedFood}; Common allergen`, Caretaker: `Synthetic ${deletedCaregiver}` });
  });

  describe.each(kinds)('%s hook activities', kind => {
    it.each(badOwners)('excludes newer %s family care rows before limit 1 without hiding the owned row', async (_label, owner) => {
      await createCare(kind, 'owned'); await createCare(kind, 'not-owned', { familyId: owner, time: newer });
      const result = await data(await activities(hookRequest(`activities?type=${kind}&since=2026-01-01T00:00:00Z&limit=1`), context()));
      expect(result.activities).toHaveLength(1); expect(result.activities[0].id).toBe('owned');
      expect(result.activities[0].activityType).toBe(kind); expect(result.activities[0].caretakerName).toBe(`Synthetic ${caregiver}`);
    });
    it.each([['foreign', foreignCaregiver], ['unresolved', nullCaregiver]] as const)('keeps an owned event but hides its %s caretaker label', async (_label, caretakerId) => {
      await createCare(kind, 'owned', { caretakerId });
      const result = await data(await list(`&type=${kind}`)); expect(result.activities).toHaveLength(1);
      expect(result.activities[0]).toMatchObject({ id: 'owned', activityType: kind, caretakerName: null });
    });
  });

  it.each(['foreign-medicine', 'foreign-supplement', 'unresolved-medicine', 'unresolved-supplement'])('keeps a dose linked to %s in exactly one generic medicine category before pagination/latest/counts', async medicineId => {
    await createCare('medicine', 'unknown-dose', { medicineId, time: newer });
    await createCare('supplement', 'owned-supplement');
    const all = await data(await list()); expect(all.activities.filter((row: { id: string }) => row.id === 'unknown-dose')).toHaveLength(1);
    expect(all.activities.find((row: { id: string }) => row.id === 'unknown-dose')).toMatchObject({ activityType: 'medicine', details: { medicineName: null, doseAmount: 2 } });
    const medicine = await data(await activities(hookRequest('activities?type=medicine&limit=1&since=2026-01-01T00:00:00Z'), context()));
    expect(medicine.activities.map((row: { id: string }) => row.id)).toEqual(['unknown-dose']);
    const supplement = await data(await activities(hookRequest('activities?type=supplement&limit=1&since=2026-01-01T00:00:00Z'), context()));
    expect(supplement.activities.map((row: { id: string }) => row.id)).toEqual(['owned-supplement']);
    const summary = await data(await status(hookRequest('status?timezone=UTC'), context()));
    expect(summary.lastActivities.medicine).toMatchObject({ time: newer.toISOString(), medicineName: null });
    expect(summary.lastActivities.supplement.supplementName).toBe(`Synthetic ${ownSupplement}`);
    expect(summary.dailyCounts).toMatchObject({ medicines: 1, supplements: 1 });
  });

  it('preserves owned deleted medicine and caretaker display while excluding deleted care events and inactive live catalog choices', async () => {
    await createCare('medicine', 'historical', { caretakerId: deletedCaregiver, medicineId: deletedMedicine });
    await createCare('medicine', 'removed-dose', { deletedAt: at, time: newer });
    const result = await data(await list('&type=medicine'));
    expect(result.activities).toHaveLength(1); expect(result.activities[0]).toMatchObject({ id: 'historical', caretakerName: `Synthetic ${deletedCaregiver}`, details: { medicineName: `Synthetic ${deletedMedicine}` } });
    const summary = await data(await status(hookRequest('status?timezone=UTC'), context()));
    expect(summary.lastActivities.medicine.medicineName).toBe(`Synthetic ${deletedMedicine}`); expect(summary.dailyCounts.medicines).toBe(1);
    const choices = await data(await reference(hookRequest('reference?type=medicines'), context()));
    expect(choices.medicines.map((row: { id: string }) => row.id)).toEqual([ownMedicine]);
  });

  describe('hook dose correction and deletion', () => {
    const unresolvedCatalogs = ['foreign-medicine', 'foreign-supplement', 'unresolved-medicine', 'unresolved-supplement'];

    it.each(unresolvedCatalogs)('corrects only notes for an owned %s dose without returning foreign name or classification', async medicineId => {
      await createCare('medicine', 'owned-dose', { medicineId });
      const before = await db.medicineLog.findUniqueOrThrow({ where: { id: 'owned-dose' } }), token = await writableKey();
      const wrongCategory = await correctActivity(mutationRequest('PUT', token, 'supplement', { notes: 'Denied category' }), mutationContext());
      expect(wrongCategory.status).toBe(404); expect(await db.medicineLog.findUniqueOrThrow({ where: { id: 'owned-dose' } })).toEqual(before);
      const result = await data(await correctActivity(mutationRequest('PUT', token, 'medicine', { notes: 'Reviewed own dose' }), mutationContext()));
      expect(result).toMatchObject({ activityType: 'medicine', id: 'owned-dose', details: { medicineName: null, doseAmount: 2, notes: 'Reviewed own dose' } });
      const after = await db.medicineLog.findUniqueOrThrow({ where: { id: 'owned-dose' } });
      expect(after).toEqual({ ...before, notes: 'Reviewed own dose', updatedAt: after.updatedAt });
    });

    it.each(['medicine', 'supplement'] as const)('preserves a normal owned %s correction and its display label', async type => {
      await createCare(type, 'owned-dose');
      const result = await data(await correctActivity(mutationRequest('PUT', await writableKey(), type, { notes: 'Owned correction' }), mutationContext()));
      expect(result).toMatchObject({ activityType: type, details: { medicineName: `Synthetic ${type === 'medicine' ? ownMedicine : ownSupplement}`, notes: 'Owned correction' } });
    });

    it('rejects read-only corrections/deletions and foreign care rows without changing either dose', async () => {
      await createCare('medicine', 'owned-dose', { medicineId: 'foreign-supplement' });
      await createCare('medicine', 'foreign-dose', { familyId: otherFamilyId });
      const before = await db.medicineLog.findMany({ orderBy: { id: 'asc' } }), token = await writableKey();
      expect((await correctActivity(mutationRequest('PUT', key, 'medicine', { notes: 'Denied' }), mutationContext())).status).toBe(403);
      expect((await removeActivity(mutationRequest('DELETE', key, 'medicine'), mutationContext())).status).toBe(403);
      expect((await correctActivity(mutationRequest('PUT', token, 'medicine', { notes: 'Denied' }, 'foreign-dose'), mutationContext('foreign-dose'))).status).toBe(404);
      expect((await removeActivity(mutationRequest('DELETE', token, undefined, undefined, 'foreign-dose'), mutationContext('foreign-dose'))).status).toBe(404);
      expect(await db.medicineLog.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    });

    describe.each([['typed', 'medicine'], ['untyped', undefined]] as const)('%s removal', (_label, type) => {
      it.each(unresolvedCatalogs)('removes the owned %s event as generic medicine and rejects the foreign supplement category', async medicineId => {
        await createCare('medicine', 'owned-dose', { medicineId });
        const before = await db.medicineLog.findUniqueOrThrow({ where: { id: 'owned-dose' } }), token = await writableKey();
        const wrongCategory = await removeActivity(mutationRequest('DELETE', token, 'supplement'), mutationContext());
        expect(wrongCategory.status).toBe(404); expect(await db.medicineLog.findUniqueOrThrow({ where: { id: 'owned-dose' } })).toEqual(before);
        const result = await data(await removeActivity(mutationRequest('DELETE', token, type), mutationContext()));
        expect(result).toMatchObject({ activityType: 'medicine', id: 'owned-dose', status: 'deleted' });
        expect(await db.medicineLog.findUnique({ where: { id: 'owned-dose' } })).toBeNull();
      });
    });

    it.each(['medicine', 'supplement'] as const)('preserves normal owned %s deletion', async type => {
      await createCare(type, 'owned-dose');
      const result = await data(await removeActivity(mutationRequest('DELETE', await writableKey(), type), mutationContext()));
      expect(result).toMatchObject({ activityType: type, id: 'owned-dose', status: 'deleted' });
      expect(await db.medicineLog.findUnique({ where: { id: 'owned-dose' } })).toBeNull();
    });
  });

  it.each(badOwners)('keeps all owned status/latest/count fields unchanged when newer %s care and active-feed rows point to the child', async (_label, owner) => {
    for (const kind of kinds) await createCare(kind, `owned-${kind}`);
    const before = await data(await status(hookRequest('status?timezone=UTC'), context()));
    for (const kind of kinds) await createCare(kind, `foreign-${kind}`, { familyId: owner, time: newer });
    await db.activeBreastFeed.create({ data: { familyId: owner, babyId, caretakerId: foreignCaregiver, sessionStartTime: newer, activeSide: 'RIGHT', isPaused: true, leftDuration: 321, rightDuration: 654 } });
    const after = await data(await status(hookRequest('status?timezone=UTC'), context()));
    expect(after).toEqual(before); expect(after.activeFeed).toBeNull();
  });

  it('keeps an owned active feed visible and suppresses only a foreign caretaker on the owned latest feed/diaper', async () => {
    await createCare('feed', 'owned-feed', { caretakerId: foreignCaregiver }); await createCare('diaper', 'owned-diaper', { caretakerId: foreignCaregiver });
    await db.activeBreastFeed.create({ data: { familyId, babyId, caretakerId: caregiver, sessionStartTime: at, activeSide: 'LEFT', isPaused: true, leftDuration: 90, rightDuration: 40 } });
    const summary = await data(await status(hookRequest('status?timezone=UTC'), context()));
    expect(summary.lastActivities.feed).toMatchObject({ id: 'owned-feed', caretakerName: null });
    expect(summary.lastActivities.diaper).toMatchObject({ id: 'owned-diaper', caretakerName: null });
    expect(summary.activeFeed).toMatchObject({ leftDuration: 90, rightDuration: 40 });
  });

  it.each(badOwners)('selects the latest owned value for all measurement types before newer %s rows', async (_label, owner) => {
    const types = ['WEIGHT', 'HEIGHT', 'HEAD_CIRCUMFERENCE', 'TEMPERATURE'] as const;
    for (const [index, type] of types.entries()) {
      await db.measurement.create({ data: { familyId, babyId, date: at, type, value: index + 1, unit: 'synthetic' } });
      await db.measurement.create({ data: { familyId: owner, babyId, date: newer, type, value: index + 100, unit: 'synthetic' } });
    }
    const result = await data(await latestMeasurements(hookRequest('measurements/latest'), context()));
    types.forEach((type, index) => expect(result.measurements[type].value).toBe(index + 1));
  });

  it.each(badOwners)('preserves defaults and own history while excluding %s sleep/play reference choices', async (_label, owner) => {
    await createCare('sleep', 'owned-sleep'); await createCare('play', 'owned-play');
    const before = await data(await reference(hookRequest('reference'), context()));
    await createCare('sleep', 'foreign-sleep', { familyId: owner }); await createCare('play', 'foreign-play', { familyId: owner });
    const after = await data(await reference(hookRequest('reference'), context())); expect(after).toEqual(before);
    expect(after.sleepLocations).toContain('owned-sleep location'); expect(after.playCategories).toContain('owned-play activity');
    const filtered = await data(await reference(hookRequest('reference?type=play-categories&playType=TUMMY_TIME'), context()));
    expect(filtered.playCategories).toEqual(['owned-play activity']);
  });
});
