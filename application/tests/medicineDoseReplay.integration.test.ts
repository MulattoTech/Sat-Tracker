import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';
import { journalScope } from '@/src/lib/bottle-journal/outbox-identity';

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient, connections: null as AsyncLocalStorage<PrismaClient> | null,
  notify: vi.fn(async () => {}), reset: vi.fn(async () => {}) }));
vi.mock('../app/api/db', () => ({ get default() { return state.connections?.getStore() ?? state.db; } }));
vi.mock('../app/api/utils/api-logger', () => ({ logApiCall: vi.fn(async () => {}), getClientInfo: () => ({}) }));
vi.mock('../src/lib/notifications/activityHook', () => ({ notifyActivityCreated: state.notify, resetTimerNotificationState: state.reset }));
import { POST, PUT, DELETE } from '../app/api/medicine-log/route';

const familyId = 'dose-replay-family', babyId = 'dose-replay-baby', caretakerId = 'dose-replay-caretaker';
const accountId = 'dose-replay-account', medicineId = 'dose-replay-medicine';
const otherBaby = 'dose-replay-sibling', otherCaretaker = 'dose-replay-other-caretaker', otherMedicine = 'dose-replay-other-medicine';
const otherFamily = 'dose-replay-other-family';
const scope = journalScope(familyId, `caretaker:${caretakerId}`, babyId);
const values = { babyId, medicineId, time: '2026-11-02T12:00:00.000Z', doseAmount: 2.5, unitAbbr: 'ML', notes: 'One synthetic administration' };
const pending = () => ({ ...values, requestId: randomUUID(), expectedScope: scope });
let directory: string, databaseUrl: string, secret: string, previousSecret: string | undefined, previousMode: string | undefined;
const token = (id = caretakerId, family = familyId) => jwt.sign({ id, familyId: family, role: 'USER', type: 'parent' }, secret, { expiresIn: '10m' });
const accountToken = () => jwt.sign({ isAccountAuth: true, accountId, familyId, role: 'USER' }, secret, { expiresIn: '10m' });
const request = (method: string, body?: unknown, auth = token(), id?: string) => new NextRequest(`http://localhost/api/medicine-log${id ? `?id=${id}` : ''}`, {
  method, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const create = (body: unknown, auth = token(), connection?: PrismaClient) => connection
  ? state.connections!.run(connection, () => POST(request('POST', body, auth))) : POST(request('POST', body, auth));
const rows = () => state.db.medicineLog.findMany({ orderBy: { id: 'asc' } });
const receipts = () => state.db.externalImportRecord.findMany({ orderBy: { id: 'asc' } });
const counts = async () => ({ doses: await state.db.medicineLog.count(), receipts: await state.db.externalImportRecord.count() });

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-dose-replay-'));
  const url = `file:${path.join(directory, 'synthetic.db')}`;
  databaseUrl = url; state.connections = new AsyncLocalStorage<PrismaClient>();
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
  });
  previousSecret = process.env.JWT_SECRET; previousMode = process.env.DEPLOYMENT_MODE;
  process.env.JWT_SECRET = secret = randomBytes(32).toString('hex'); process.env.DEPLOYMENT_MODE = 'selfhosted';
  state.db = new PrismaClient({ adapter: createPrismaAdapter(url) });
  await state.db.family.createMany({ data: [familyId, otherFamily].map(id => ({ id, slug: id, name: 'Synthetic dose family', setupStage: 3 })) });
  await state.db.baby.createMany({ data: [babyId, otherBaby].map(id => ({ id, familyId, firstName: 'Synthetic', lastName: 'Dose', birthDate: new Date('2026-01-01Z') })) });
  await state.db.caretaker.createMany({ data: [caretakerId, otherCaretaker].map((id, index) => ({ id, familyId, role: 'USER', type: 'parent',
    name: 'Synthetic dose caregiver', loginId: `0${index + 1}`, securityPin: '123456' })) });
  await state.db.caretaker.create({ data: { id: 'dose-foreign-carer', familyId: otherFamily, role: 'USER', type: 'parent', name: 'Synthetic foreign caregiver', loginId: '01', securityPin: '123456' } });
  await state.db.account.create({ data: { id: accountId, familyId, caretakerId, email: 'synthetic-dose@example.invalid', password: 'unused-synthetic', verified: true } });
  await state.db.unit.createMany({ data: ['ML', 'MG'].map(unitAbbr => ({ unitAbbr, unitName: unitAbbr })) });
  await state.db.medicine.createMany({ data: [medicineId, otherMedicine].map(id => ({ id, familyId, name: 'Synthetic dose medicine', typicalDoseSize: 2.5, unitAbbr: 'ML' })) });
}, 90_000);

beforeEach(async () => {
  await state.db.$executeRawUnsafe('DROP TRIGGER IF EXISTS synthetic_dose_receipt_failure');
  await state.db.medicineLog.deleteMany(); await state.db.externalImportRecord.deleteMany();
  await state.db.baby.updateMany({ data: { deletedAt: null, familyId } });
  await state.db.medicine.updateMany({ data: { deletedAt: null, familyId } });
  process.env.DEPLOYMENT_MODE = 'selfhosted';
  state.notify.mockClear(); state.reset.mockClear();
});

afterAll(async () => {
  await state.db?.$disconnect(); if (directory) rmSync(directory, { recursive: true, force: true });
  if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
  if (previousMode === undefined) delete process.env.DEPLOYMENT_MODE; else process.env.DEPLOYMENT_MODE = previousMode;
});

describe('medicine administration identity with real JWT middleware and migrated SQLite', () => {
  it('replays one uncertain submission without a second dose, timestamp change, notification, or timer reset', async () => {
    const body = pending();
    const first = await create(body), firstData = await first.json();
    expect(first.status).toBe(200); expect(firstData.requestId).toBe(body.requestId);
    const before = await rows(), receiptBefore = await receipts();
    const replay = await create(body), replayData = await replay.json();
    expect(replay.status).toBe(200); expect(replayData.data.id).toBe(firstData.data.id);
    expect(replayData.requestId).toBe(body.requestId);
    expect(await counts()).toEqual({ doses: 1, receipts: 1 });
    expect(await rows()).toEqual(before); expect(await receipts()).toEqual(receiptBefore);
    expect(state.notify).toHaveBeenCalledTimes(1); expect(state.reset).toHaveBeenCalledTimes(1);
  });

  it('preserves two deliberate administrations with identical values and different request IDs', async () => {
    const first = pending(), second = pending();
    expect((await create(first)).status).toBe(200); expect((await create(second)).status).toBe(200);
    expect((await create(first)).status).toBe(200); expect((await create(second)).status).toBe(200);
    expect(await counts()).toEqual({ doses: 2, receipts: 2 });
    expect(state.notify).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('keeps concurrent %s request identities atomic without losing an independent dose', async different => {
    const first = pending(), second = different ? pending() : { ...first };
    const results = await Promise.all([create(first), create(second)]);
    expect(results.some(result => result.status === 200)).toBe(true);
    expect(results.every(result => [200, 409].includes(result.status))).toBe(true);
    expect((await create(first)).status).toBe(200); expect((await create(second)).status).toBe(200);
    expect(await counts()).toEqual({ doses: different ? 2 : 1, receipts: different ? 2 : 1 });
    expect(state.notify).toHaveBeenCalledTimes(different ? 2 : 1);
  });

  it('uses the authenticated account identity separately from its linked caretaker login', async () => {
    const body = { ...pending(), expectedScope: journalScope(familyId, `account:${accountId}`, babyId) };
    const first = await create(body, accountToken()); expect(first.status).toBe(200);
    const saved = (await first.json()).data;
    expect(saved.caretakerId).toBe(caretakerId);
    expect((await create(body, accountToken())).status).toBe(200);
    expect((await create(body)).status).toBe(409);
    expect((await create({ ...body, expectedScope: scope })).status).toBe(409);
    expect(await counts()).toEqual({ doses: 1, receipts: 1 });
  });

  it('rejects a different caregiver, child, or family scope before any mutation', async () => {
    const body = pending();
    expect((await create(body, token(otherCaretaker))).status).toBe(409);
    expect((await create({ ...body, babyId: otherBaby })).status).toBe(409);
    expect((await create(body, token('dose-foreign-carer', otherFamily))).status).toBe(409);
    expect(await counts()).toEqual({ doses: 0, receipts: 0 });
  });

  it('requires current authentication and write permission even on a saved replay', async () => {
    const body = { ...pending(), expectedScope: journalScope(familyId, `account:${accountId}`, babyId) };
    expect((await create(body, accountToken())).status).toBe(200);
    const before = await rows(), receiptBefore = await receipts();
    expect((await create(body, '')).status).toBe(401);
    expect((await create(body, jwt.sign({ id: caretakerId, familyId, role: 'USER' }, secret, { expiresIn: -1 }))).status).toBe(401);
    process.env.DEPLOYMENT_MODE = 'saas';
    expect((await create(body, accountToken())).status).toBe(403);
    expect(await rows()).toEqual(before); expect(await receipts()).toEqual(receiptBefore);
  });

  it.each([
    { requestId: null }, { requestId: 1 }, { requestId: '' }, { requestId: 'not-a-uuid' }, { requestId: {} },
    { requestId: undefined }, { expectedScope: undefined }, { expectedScope: null }, { expectedScope: [] },
  ])('rejects invalid or incomplete request metadata %j', async patch => {
    expect((await create({ ...pending(), ...patch })).status).toBe(400);
    expect(await counts()).toEqual({ doses: 0, receipts: 0 });
  });

  it.each([{ caretakerId: otherCaretaker }, { familyId: otherFamily }, { doseAmount: { set: 5 } }, { baby: { connect: { id: otherBaby } } }])('retains strict care field boundaries %j', async patch => {
    expect((await create({ ...pending(), ...patch })).status).toBe(400);
    expect(await counts()).toEqual({ doses: 0, receipts: 0 });
  });

  it('keeps legacy POST and ordinary edit PUT compatible, including zero/null', async () => {
    const first = await create({ ...values, doseAmount: 0, unitAbbr: null, notes: null });
    expect(first.status).toBe(200);
    const saved = (await first.json()).data;
    expect((await create({ ...values, doseAmount: 0, unitAbbr: null, notes: null })).status).toBe(200);
    expect(await counts()).toEqual({ doses: 2, receipts: 0 });
    const edited = await PUT(request('PUT', { ...values, doseAmount: 0, unitAbbr: null, notes: 'Deliberate edit' }, token(), saved.id));
    expect(edited.status).toBe(200); expect((await edited.json()).data.notes).toBe('Deliberate edit');
    expect((await PUT(request('PUT', { requestId: randomUUID() }, token(), saved.id))).status).toBe(400);
  });

  it.each([
    { doseAmount: 5 }, { time: '2026-11-02T12:01:00.000Z' }, { medicineId: otherMedicine },
    { unitAbbr: 'MG' }, { notes: null }, { babyId: otherBaby, expectedScope: journalScope(familyId, `caretaker:${caretakerId}`, otherBaby) },
  ])('rejects changed input under the original request identity %j', async change => {
    const body = pending(); expect((await create(body)).status).toBe(200);
    const before = await rows(), receiptBefore = await receipts();
    expect((await create({ ...body, ...change })).status).toBe(409);
    expect(await rows()).toEqual(before); expect(await receipts()).toEqual(receiptBefore);
  });

  it('keeps the durable receipt after canonical deletion and never resurrects a removed dose', async () => {
    const body = pending(), first = await create(body); expect(first.status).toBe(200);
    const id = (await first.json()).data.id;
    expect((await DELETE(request('DELETE', undefined, token(), id))).status).toBe(200);
    const receiptBefore = await receipts();
    expect((await create(body)).status).toBe(409);
    expect(await counts()).toEqual({ doses: 0, receipts: 1 }); expect(await receipts()).toEqual(receiptBefore);
  });

  it.each([
    { doseAmount: 5 }, { time: new Date('2026-11-02T12:01:00Z') }, { medicineId: otherMedicine }, { unitAbbr: 'MG' },
    { notes: 'Corrected by a caregiver' }, { babyId: otherBaby }, { familyId: otherFamily }, { caretakerId: otherCaretaker },
    { caretakerId: null }, { deletedAt: new Date('2026-11-02T12:01:00Z') },
    { updatedAt: new Date('2026-11-02T12:01:00Z') }, { createdAt: new Date('2026-11-02T12:01:00Z') },
  ])('blocks replay when any saved target field changed %j', async change => {
    const body = pending(); expect((await create(body)).status).toBe(200);
    await state.db.medicineLog.updateMany({ data: change });
    const before = await rows(), receiptBefore = await receipts();
    expect((await create(body)).status).toBe(409);
    expect(await rows()).toEqual(before); expect(await receipts()).toEqual(receiptBefore);
  });

  it('does not reinterpret an original request as an intentional edit even if new input matches a later correction', async () => {
    const body = pending(), first = await create(body); expect(first.status).toBe(200);
    const id = (await first.json()).data.id;
    expect((await PUT(request('PUT', { doseAmount: 5 }, token(), id))).status).toBe(200);
    const before = await rows();
    expect((await create({ ...body, doseAmount: 5 })).status).toBe(409);
    expect(await rows()).toEqual(before);
  });

  it.each([{ targetEntityType: 'FeedLog' }, { sourceChildId: otherBaby }, { targetRecordId: 'different-target' }])('does not repair or follow a mismatched durable receipt %j', async change => {
    const body = pending(); expect((await create(body)).status).toBe(200);
    await state.db.externalImportRecord.updateMany({ data: change });
    const before = await rows(), receiptBefore = await receipts();
    expect((await create(body)).status).toBe(409);
    expect(await rows()).toEqual(before); expect(await receipts()).toEqual(receiptBefore);
  });

  it.each(['baby', 'medicine'] as const)('requires a live same-family %s on a new submission', async table => {
    if (table === 'baby') await state.db.baby.updateMany({ data: { deletedAt: new Date() } });
    else await state.db.medicine.updateMany({ data: { deletedAt: new Date() } });
    expect((await create(pending())).status).toBe(404);
    expect(await counts()).toEqual({ doses: 0, receipts: 0 });
  });

  it('rolls back the parent when the durable receipt cannot be written', async () => {
    const body = pending();
    await state.db.$executeRawUnsafe("CREATE TRIGGER synthetic_dose_receipt_failure BEFORE INSERT ON ExternalImportRecord BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END");
    expect((await create(body)).status).toBe(500);
    expect(await counts()).toEqual({ doses: 0, receipts: 0 });
    expect(state.notify).not.toHaveBeenCalled(); expect(state.reset).not.toHaveBeenCalled();
    await state.db.$executeRawUnsafe('DROP TRIGGER synthetic_dose_receipt_failure');
    expect((await create(body)).status).toBe(200);
    expect(await counts()).toEqual({ doses: 1, receipts: 1 });
  });

  it.each(['same', 'different'])('independent SQLite connections - %s request IDs leave the database readable and writable', async kind => {
    const secondConnection = new PrismaClient({ adapter: createPrismaAdapter(databaseUrl) });
    let arrivals = 0, release!: () => void;
    const bothReady = new Promise<void>(resolve => { release = resolve; });
    // Pause immediately before each connection's first INSERT. With a
    // read-first transaction this is the real lock-upgrade contention window.
    const synchronized = (connection: PrismaClient) => connection.$extends({ query: { medicineLog: {
      async create({ args, query }) {
        if (arrivals < 2) { arrivals++; if (arrivals === 2) release(); await bothReady; }
        return query(args);
      },
    } } }) as unknown as PrismaClient;
    const observe = async <T>(promise: Promise<T>, milliseconds: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([promise.then(value => ({ outcome: 'resolved' as const, value }), error => ({ outcome: 'rejected' as const, error: String(error) })),
          new Promise<{ outcome: 'timeout' }>(resolve => { timer = setTimeout(() => resolve({ outcome: 'timeout' }), milliseconds); })]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    };
    try {
      const first = pending(), second = kind === 'same' ? { ...first } : pending();
      const attempts = await observe(Promise.all([create(first, token(), synchronized(state.db)), create(second, token(), synchronized(secondConnection))])
        .then(responses => responses.map(response => response.status)), 20_000);
      const afterRead = await observe(state.db.medicineLog.count(), 2_000);
      const afterWrite = afterRead.outcome === 'resolved' ? await observe(create(pending()).then(response => response.status), 5_000) : { outcome: 'blocked-by-read' };
      const secondRead = await observe(secondConnection.medicineLog.count(), 2_000);
      const secondWrite = secondRead.outcome === 'resolved'
        ? await observe(create(pending(), token(), secondConnection).then(response => response.status), 5_000) : { outcome: 'blocked-by-read' };
      const observation = { kind, arrivals, attempts, afterRead, afterWrite, secondRead, secondWrite };
      if (process.env.SAT_DOSE_CONTENTION_REPORT) writeFileSync(process.env.SAT_DOSE_CONTENTION_REPORT.replace(/\.json$/, `-${kind}.json`), JSON.stringify(observation, null, 2));
      expect(attempts.outcome).toBe('resolved');
      if (attempts.outcome === 'resolved') {
        expect(attempts.value.some(status => status === 200)).toBe(true);
        expect(attempts.value.every(status => [200, 409].includes(status))).toBe(true);
      }
      expect(afterRead.outcome).toBe('resolved');
      expect(afterWrite).toEqual({ outcome: 'resolved', value: 200 });
      expect(secondRead.outcome).toBe('resolved');
      expect(secondWrite).toEqual({ outcome: 'resolved', value: 200 });
      expect((await create(first)).status).toBe(200); expect((await create(second, token(), secondConnection)).status).toBe(200);
      expect(await counts()).toEqual({ doses: kind === 'same' ? 3 : 4, receipts: kind === 'same' ? 3 : 4 });
    } finally {
      await observe(secondConnection.$disconnect(), 2_000);
    }
  }, 35_000);
});
