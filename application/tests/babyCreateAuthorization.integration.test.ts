import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { NextRequest, type NextResponse } from 'next/server';
import { createPrismaAdapter } from '@/prisma/prisma-adapter';
import { hashPassword } from '@/app/api/utils/password-utils';

// The real routes, JWT verification, password verification,
// family-scope policy, and SQLite writes run unchanged. Only the DB singleton
// and incidental API logging are redirected to synthetic local fixtures.
const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
vi.mock('../app/api/db', () => ({ get default() { return state.db; } }));
vi.mock('../app/api/utils/api-logger', () => ({
  logApiCall: vi.fn(async () => {}),
  getClientInfo: () => ({ ip: '127.0.0.27', userAgent: 'synthetic-baby-create-auth-test' }),
}));
import { POST as alternateCreate } from '../app/api/baby/create/route';
import { POST as canonicalCreate } from '../app/api/baby/route';
import { POST as pinLogin } from '../app/api/auth/route';
import { POST as accountLogin } from '../app/api/accounts/login/route';
import { POST as setupLogin } from '../app/api/auth/token/route';

const familyA = 'synthetic-baby-create-family-a';
const familyB = 'synthetic-baby-create-family-b';
const userId = 'synthetic-baby-create-user';
const adminId = 'synthetic-baby-create-admin';
const ownerId = 'synthetic-baby-create-owner';
const unattachedId = 'synthetic-baby-create-unattached';
const boundInvite = 'synthetic-baby-create-bound-invite';
const unboundInvite = 'synthetic-baby-create-unbound-invite';
const syntheticPassword = 'Synthetic-only-credential-27';
const routes = [
  { routeName: 'alternate /api/baby/create', pathname: '/api/baby/create', handler: alternateCreate },
  { routeName: 'canonical /api/baby', pathname: '/api/baby', handler: canonicalCreate },
] as const;
type Tokens = { user: string; admin: string; owner: string; unattached: string; sysadmin: string; boundSetup: string; unboundSetup: string };
let actual: PrismaClient;
let directory: string;
let secret: string;
let tokens: Tokens;
let oldSecret: string | undefined;
let oldMode: string | undefined;
let oldTimezone: string | undefined;

const request = (pathname: string, body: unknown, token?: string) => new NextRequest(`http://localhost${pathname}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});
const babyBody = (targetFamily: string) => ({
  familyId: targetFamily,
  firstName: 'Synthetic', lastName: 'Authorization Fixture',
  birthDate: '2026-01-01T00:00:00.000Z', gender: 'FEMALE',
  feedWarningTime: '02:00', diaperWarningTime: '03:00',
});
const snapshot = async () => ({
  babies: await actual.baby.findMany({ orderBy: { id: 'asc' } }),
  families: await actual.family.findMany({ orderBy: { id: 'asc' } }),
});
async function issuedToken(response: NextResponse) {
  expect(response.status).toBe(200);
  const json = await response.json();
  expect(json.success).toBe(true);
  expect(typeof json.data.token).toBe('string');
  // Exercise the same signature and expiration checks as the real handler.
  expect(jwt.verify(json.data.token, secret)).toBeTruthy();
  return json.data.token as string;
}
async function resetInvites() {
  await actual.familySetup.deleteMany();
  await actual.familySetup.createMany({ data: [
    { token: boundInvite, familyId: familyA },
    { token: unboundInvite, familyId: null },
  ].map(invite => ({
    ...invite, password: syntheticPassword, createdBy: adminId,
    expiresAt: new Date(Date.now() + 86_400_000),
  })) });
}

beforeAll(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'sat-baby-create-auth-'));
  const url = 'file:' + path.join(directory, 'synthetic.db');
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60_000,
  });
  oldSecret = process.env.JWT_SECRET;
  oldMode = process.env.DEPLOYMENT_MODE;
  oldTimezone = process.env.TZ;
  process.env.JWT_SECRET = secret = randomBytes(32).toString('hex');
  process.env.DEPLOYMENT_MODE = 'selfhosted';
  process.env.TZ = 'UTC';
  actual = new PrismaClient({ adapter: createPrismaAdapter(url) });
  state.db = actual;
  await actual.family.createMany({ data: [familyA, familyB].map(id => ({
    id, slug: id, name: 'Synthetic Authorization Family', setupStage: 2,
  })) });
  await actual.caretaker.createMany({ data: [
    { id: userId, loginId: '27', role: 'USER' as const },
    { id: adminId, loginId: '28', role: 'ADMIN' as const },
  ].map(caretaker => ({
    ...caretaker, familyId: familyA, name: 'Synthetic Caregiver', type: 'Parent', securityPin: syntheticPassword,
  })) });
  await actual.settings.create({ data: { familyId: familyA, authType: 'CARETAKER' } });
  await actual.appConfig.create({ data: { adminPass: syntheticPassword, rootDomain: 'localhost' } });
  const password = await hashPassword(syntheticPassword);
  await actual.account.createMany({ data: [
    { id: ownerId, email: 'synthetic-owner@example.invalid', familyId: familyA, caretakerId: adminId },
    { id: unattachedId, email: 'synthetic-unattached@example.invalid', familyId: null, caretakerId: null },
  ].map(account => ({ ...account, password, verified: true, planType: 'full' })) });
  await resetInvites();

  // Obtain every ordinary credential through the actual login endpoints. None
  // of these tokens contains a forged family, role, or setup invitation claim.
  tokens = {
    user: await issuedToken(await pinLogin(request('/api/auth', {
      loginId: '27', securityPin: syntheticPassword, familySlug: familyA,
    }))),
    admin: await issuedToken(await pinLogin(request('/api/auth', {
      loginId: '28', securityPin: syntheticPassword, familySlug: familyA,
    }))),
    owner: await issuedToken(await accountLogin(request('/api/accounts/login', {
      email: 'synthetic-owner@example.invalid', password: syntheticPassword,
    }))),
    unattached: await issuedToken(await accountLogin(request('/api/accounts/login', {
      email: 'synthetic-unattached@example.invalid', password: syntheticPassword,
    }))),
    sysadmin: await issuedToken(await pinLogin(request('/api/auth', { adminPassword: syntheticPassword }))),
    boundSetup: await issuedToken(await setupLogin(request('/api/auth/token', { token: boundInvite, password: syntheticPassword }))),
    unboundSetup: await issuedToken(await setupLogin(request('/api/auth/token', { token: unboundInvite, password: syntheticPassword }))),
  };
}, 90_000);

beforeEach(async () => {
  process.env.DEPLOYMENT_MODE = 'selfhosted';
  await actual.baby.deleteMany();
  await actual.family.updateMany({ data: { setupStage: 2 } });
  await actual.account.updateMany({ data: { closed: false, trialEnds: null, planType: 'full' } });
  await resetInvites();
});

afterAll(async () => {
  await actual?.$disconnect();
  if (directory) rmSync(directory, { recursive: true, force: true });
  if (oldSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = oldSecret;
  if (oldMode === undefined) delete process.env.DEPLOYMENT_MODE; else process.env.DEPLOYMENT_MODE = oldMode;
  if (oldTimezone === undefined) delete process.env.TZ; else process.env.TZ = oldTimezone;
});

describe.each(routes)('$routeName family authorization with real issued JWTs and migrated SQLite', ({ pathname, handler }) => {
  it.each([
    { label: 'ordinary USER caretaker targets another family', credential: 'user', query: null },
    { label: 'family ADMIN caretaker targets another family', credential: 'admin', query: null },
    { label: 'account owner targets another family', credential: 'owner', query: null },
    { label: 'account with no family targets an existing family', credential: 'unattached', query: null },
    { label: 'bound setup invitation targets another family', credential: 'boundSetup', query: familyB },
    { label: 'unbound setup invitation targets an existing family', credential: 'unboundSetup', query: familyB },
    { label: 'setup query names its own family but body names another', credential: 'boundSetup', query: familyA },
    { label: 'previously issued setup JWT survives invitation deletion', credential: 'boundSetup', query: familyA, removeInvite: true },
  ] as const)('rejects $label without creating a child or completing setup', async testCase => {
    if ('removeInvite' in testCase) await actual.familySetup.delete({ where: { token: boundInvite } });
    const before = await snapshot();
    const target = 'removeInvite' in testCase ? familyA : familyB;
    const route = `${pathname}${testCase.query ? `?familyId=${testCase.query}` : ''}`;
    const response = await handler(request(route, babyBody(target), tokens[testCase.credential]));
    const after = await snapshot();
    expect(response.status).toBe(403);
    expect(after).toEqual(before);
  });

  it.each([
    { label: 'ordinary USER caretaker in their own family', credential: 'user', target: familyA, query: false },
    { label: 'family ADMIN caretaker in their own family', credential: 'admin', target: familyA, query: false },
    { label: 'account owner in their own family', credential: 'owner', target: familyA, query: false },
    { label: 'system administrator using an explicit body family', credential: 'sysadmin', target: familyB, query: false },
    { label: 'bound setup invitation with the wizard family query', credential: 'boundSetup', target: familyA, query: true },
  ] as const)('permits $label and completes only that family setup', async ({ credential, target, query }) => {
    const response = await handler(request(`${pathname}${query ? `?familyId=${target}` : ''}`, babyBody(target), tokens[credential]));
    const body = await response.json();
    const after = await snapshot();
    expect(response.status).toBe(pathname === '/api/baby/create' ? 201 : 200);
    expect(body).toMatchObject({ success: true, data: { familyId: target, firstName: 'Synthetic' } });
    expect(after.babies).toHaveLength(1);
    expect(after.families.find(family => family.id === target)?.setupStage).toBe(3);
    expect(after.families.find(family => family.id !== target)?.setupStage).toBe(2);
  });

  it('rejects an anonymous request without writes', async () => {
    const before = await snapshot();
    expect((await handler(request(pathname, babyBody(familyA)))).status).toBe(401);
    expect(await snapshot()).toEqual(before);
  });

  it('rejects a validly signed but expired JWT without writes', async () => {
    const before = await snapshot();
    const expired = jwt.sign({ id: userId, role: 'USER', familyId: familyA }, secret, { expiresIn: -1 });
    const expectedError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await handler(request(pathname, babyBody(familyA), expired))).status).toBe(401);
    } finally {
      expectedError.mockRestore();
    }
    expect(await snapshot()).toEqual(before);
  });

  it('retains SaaS expired-account write protection without writes', async () => {
    process.env.DEPLOYMENT_MODE = 'saas';
    await actual.account.update({ where: { id: ownerId }, data: { trialEnds: new Date('2000-01-01T00:00:00Z') } });
    const before = await snapshot();
    expect((await handler(request(pathname, babyBody(familyA), tokens.owner))).status).toBe(403);
    expect(await snapshot()).toEqual(before);
  });
});

describe('alternate route input and existence controls', () => {
  it('rejects invalid Zod input before either write', async () => {
    const before = await snapshot();
    const response = await alternateCreate(request('/api/baby/create', { ...babyBody(familyA), firstName: '' }, tokens.user));
    expect(response.status).toBe(400);
    expect(await snapshot()).toEqual(before);
  });

  it('returns not found for a system administrator targeting an absent family', async () => {
    const before = await snapshot();
    const response = await alternateCreate(request('/api/baby/create', babyBody('synthetic-absent-family'), tokens.sysadmin));
    expect(response.status).toBe(404);
    expect(await snapshot()).toEqual(before);
  });
});
