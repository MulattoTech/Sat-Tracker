import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import type { PrismaClient } from '@prisma/client';
import { createMetadataTestDatabase } from './portableRecoveryTestUtils';
import { hashPassword } from '@/app/api/utils/password-utils';
import { RecoveryError, type InspectionSummary, type RecoveryReceipt } from '@/src/lib/portable-recovery/types';

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
const services = vi.hoisted(() => ({
  getRecoveryStatus: vi.fn(), inspectRecoveryArchive: vi.fn(), commitRecoveryArchive: vi.fn(),
  createInstallationBackup: vi.fn(), getSourceRecoveryKey: vi.fn(),
}));
vi.mock('../app/api/db', () => ({ get default() { return state.db; } }));
vi.mock('../app/api/utils/api-logger', () => ({
  logApiCall: vi.fn(async () => {}), getClientInfo: () => ({ ip: '127.0.0.61', userAgent: 'synthetic-recovery-authority-test' }),
}));
vi.mock('../src/lib/portable-recovery/service', () => services);
import { POST as pinLogin } from '../app/api/auth/route';
import { POST as accountLogin } from '../app/api/accounts/login/route';
import { POST as setupLogin } from '../app/api/auth/token/route';
import { POST as backup } from '../app/api/database/backup/route';
import { POST as recoveryKey } from '../app/api/database/recovery-key/route';
import { GET as recoveryStatus } from '../app/api/recovery/status/route';
import { POST as inspect } from '../app/api/recovery/inspect/route';
import { POST as commit } from '../app/api/recovery/commit/route';
import { GET as oldGet, POST as oldPost } from '../app/api/database/route';
import { POST as oldInitial } from '../app/api/database/restore-initial/route';
import { POST as oldMigrate } from '../app/api/database/migrate/route';
import { POST as oldInitialMigrate } from '../app/api/database/migrate-initial/route';
import { POST as oldPrecheck } from '../app/api/database/pre-migration-check/route';
import { POST as oldInitialPrecheck } from '../app/api/database/pre-migration-check-initial/route';

const password = 'Synthetic-installation-owner-password-61';
const bootstrap = 'aB'.repeat(32);
const sourceKey = 'cD'.repeat(32);
const summary: InspectionSummary = {
  archiveSha256: 'e'.repeat(64), format: 'portable-v1', sourceProvider: 'sqlite', sourceRevision: 'f'.repeat(40),
  exportedAt: '2026-11-20T00:00:00.000Z', modelCount: 66, recordCount: 12, mediaCount: 3,
  mediaBytes: 30, coverage: 'complete', omissions: [], diagnostics: [], canRestore: true,
};
const receipt: RecoveryReceipt = { ...summary, status: 'RECOVERED', destinationProvider: 'postgresql',
  completedAt: '2026-11-20T01:00:00.000Z', tablesRestored: 66, recordsRestored: 12, filesRestored: 3,
  verified: true, activationRequired: true };
let fixture: ReturnType<typeof createMetadataTestDatabase>;
const tokens: Record<string, string> = {};
const previousEnv = new Map<string, string | undefined>();
function jsonRequest(path: string, body: unknown, token?: string) {
  return new NextRequest('http://localhost' + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
}
async function tokenFrom(response: Response) {
  expect(response.status).toBe(200);
  return (await response.json()).data.token as string;
}
function upload(commitRequest = false, token = bootstrap) {
  const form = new FormData();
  form.set('archive', new Blob(['synthetic archive bytes']), 'portable.zip');
  form.set('sourceKey', sourceKey);
  if (commitRequest) form.set('archiveSha256', summary.archiveSha256);
  return new NextRequest('http://localhost/api/recovery/' + (commitRequest ? 'commit' : 'inspect'), {
    method: 'POST', headers: { 'X-Sat-Recovery-Token': token }, body: form,
  });
}

beforeAll(async () => {
  for (const name of ['JWT_SECRET', 'ENC_HASH', 'SAT_TRACKER_RECOVERY_MODE', 'SAT_TRACKER_RECOVERY_TOKEN', 'DEPLOYMENT_MODE']) previousEnv.set(name, process.env[name]);
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  process.env.ENC_HASH = sourceKey;
  process.env.SAT_TRACKER_RECOVERY_TOKEN = bootstrap;
  process.env.DEPLOYMENT_MODE = 'selfhosted';
  fixture = createMetadataTestDatabase();
  state.db = fixture.db;
  for (const name of ['ordinary', 'system']) {
    await state.db.family.create({ data: { id: name, slug: name, name: 'Synthetic ' + name, setupStage: 3 } });
    await state.db.settings.create({ data: { familyId: name, securityPin: '112233', authType: name === 'system' ? 'SYSTEM' : 'CARETAKER' } });
  }
  await state.db.caretaker.createMany({ data: [
    { id: 'user', loginId: '61', role: 'USER' as const, familyId: 'ordinary' },
    { id: 'admin', loginId: '62', role: 'ADMIN' as const, familyId: 'ordinary' },
    { id: 'system', loginId: '00', role: 'ADMIN' as const, familyId: 'system' },
  ].map(value => ({ ...value, name: 'Synthetic recovery authority', securityPin: '112233', type: 'Parent' })) });
  await state.db.appConfig.create({ data: { id: 'config', adminPass: password, rootDomain: 'synthetic.invalid' } });
  await state.db.account.create({ data: { id: 'owner', email: 'recovery-owner@example.invalid',
    password: await hashPassword(password), verified: true, planType: 'full', familyId: 'ordinary', caretakerId: 'admin' } });
  await state.db.familySetup.create({ data: { token: 'synthetic-recovery-invite', password,
    createdBy: 'admin', expiresAt: new Date(Date.now() + 3_600_000) } });
  for (const [name, loginId, familySlug] of [['user', '61', 'ordinary'], ['admin', '62', 'ordinary'], ['system', '00', 'system']]) {
    tokens[name] = await tokenFrom(await pinLogin(jsonRequest('/api/auth', { loginId, securityPin: '112233', familySlug })));
  }
  tokens.owner = await tokenFrom(await accountLogin(jsonRequest('/api/accounts/login', { email: 'recovery-owner@example.invalid', password })));
  tokens.setup = await tokenFrom(await setupLogin(jsonRequest('/api/auth/token', { token: 'synthetic-recovery-invite', password })));
  tokens.sysadmin = await tokenFrom(await pinLogin(jsonRequest('/api/auth', { adminPassword: password })));
}, 60_000);

beforeEach(async () => {
  process.env.SAT_TRACKER_RECOVERY_MODE = '0';
  process.env.SAT_TRACKER_RECOVERY_TOKEN = bootstrap;
  await state.db.appConfig.updateMany({ data: { adminPass: password } });
  vi.clearAllMocks();
  services.getRecoveryStatus.mockResolvedValue({ mode: 'recovery', state: 'empty', ready: true, maxArchiveBytes: 512 * 1024 * 1024 });
  services.inspectRecoveryArchive.mockResolvedValue(summary);
  services.commitRecoveryArchive.mockResolvedValue(receipt);
  services.createInstallationBackup.mockResolvedValue({ bytes: Buffer.from('synthetic portable archive'), fileName: 'portable.zip' });
  services.getSourceRecoveryKey.mockReturnValue(sourceKey);
});

afterAll(async () => {
  await fixture?.close();
  for (const [name, value] of previousEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});

describe.each([['backup', backup], ['recovery key', recoveryKey]] as const)('installation owner %s download', (_name, handler) => {
  it.each(['anonymous', 'user', 'admin', 'system', 'owner', 'setup'])('denies %s before parsing the body', async credential => {
    const request = jsonRequest('/api/database/backup', { password }, tokens[credential]);
    const reader = vi.spyOn(request.body!, 'getReader');
    const response = await handler(request);
    expect(response.status).toBe(credential === 'anonymous' ? 401 : 403);
    expect(reader).not.toHaveBeenCalled();
    expect(services.createInstallationBackup).not.toHaveBeenCalled();
    expect(services.getSourceRecoveryKey).not.toHaveBeenCalled();
  });

  it.each(['', 'admin'])('denies unconfigured/default administrator password %j', async defaultPassword => {
    await state.db.appConfig.update({ where: { id: 'config' }, data: { adminPass: defaultPassword } });
    const response = await handler(jsonRequest('/api/database/backup', { password: defaultPassword }, tokens.sysadmin));
    expect(response.status).toBe(403);
    expect(services.createInstallationBackup).not.toHaveBeenCalled();
    expect(services.getSourceRecoveryKey).not.toHaveBeenCalled();
  });

  it('requires a fresh correct password, then returns only its explicit attachment without caching', async () => {
    expect((await handler(jsonRequest('/api/database/backup', { password: 'wrong' }, tokens.sysadmin))).status).toBe(401);
    const response = await handler(jsonRequest('/api/database/backup', { password }, tokens.sysadmin));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Disposition')).toContain('attachment;');
    expect(await response.text()).toBe(_name === 'backup' ? 'synthetic portable archive' : sourceKey);
    expect(services.getSourceRecoveryKey).toHaveBeenCalledTimes(_name === 'recovery key' ? 1 : 0);
  });

  it('is unavailable in recovery mode even with an owner JWT and password', async () => {
    process.env.SAT_TRACKER_RECOVERY_MODE = '1';
    expect((await handler(jsonRequest('/api/database/backup', { password }, tokens.sysadmin))).status).toBe(404);
    expect(services.createInstallationBackup).not.toHaveBeenCalled();
    expect(services.getSourceRecoveryKey).not.toHaveBeenCalled();
  });
});

describe('recovery-only routes', () => {
  it.each(['user', 'admin', 'system', 'owner', 'setup', 'sysadmin'])('never promotes a %s JWT to bootstrap authority', async credential => {
    process.env.SAT_TRACKER_RECOVERY_MODE = '1';
    const request = jsonRequest('/api/recovery/inspect', { file: 'not an archive' }, tokens[credential]);
    const reader = vi.spyOn(request.body!, 'getReader');
    expect((await inspect(request)).status).toBe(401);
    expect(reader).not.toHaveBeenCalled();
    expect(services.getRecoveryStatus).not.toHaveBeenCalled();
  });

  it('rejects a valid operator token outside recovery mode before reading destination state or bytes', async () => {
    const request = upload();
    const reader = vi.spyOn(request.body!, 'getReader');
    expect((await inspect(request)).status).toBe(404);
    expect(reader).not.toHaveBeenCalled();
    expect(services.getRecoveryStatus).not.toHaveBeenCalled();
  });

  it.each(['blocked', 'complete'])('rejects %s destination before parsing upload while authenticated status remains available', async destinationState => {
    process.env.SAT_TRACKER_RECOVERY_MODE = '1';
    services.getRecoveryStatus.mockResolvedValue({ state: destinationState, ready: false, ...(destinationState === 'complete' ? { receipt } : {}) });
    for (const handler of [inspect, commit]) {
      const request = upload(handler === commit);
      const reader = vi.spyOn(request.body!, 'getReader');
      expect((await handler(request)).status).toBe(409);
      expect(reader).not.toHaveBeenCalled();
    }
    const response = await recoveryStatus(new NextRequest('http://localhost/api/recovery/status', { headers: { 'X-Sat-Recovery-Token': bootstrap } }));
    expect(response.status).toBe(200);
    expect((await response.json()).data.state).toBe(destinationState);
    expect(services.inspectRecoveryArchive).not.toHaveBeenCalled();
    expect(services.commitRecoveryArchive).not.toHaveBeenCalled();
  });

  it('passes exact bytes/key/digest to independent inspect and commit and returns the verified receipt', async () => {
    process.env.SAT_TRACKER_RECOVERY_MODE = '1';
    expect((await inspect(upload())).status).toBe(200);
    expect(services.inspectRecoveryArchive).toHaveBeenCalledWith(Buffer.from('synthetic archive bytes'), sourceKey);
    const response = await commit(upload(true));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(receipt);
    expect(services.commitRecoveryArchive).toHaveBeenCalledWith(Buffer.from('synthetic archive bytes'), sourceKey, summary.archiveSha256);
  });

  it('preserves a coordinated commit conflict and sanitizes unexpected errors', async () => {
    process.env.SAT_TRACKER_RECOVERY_MODE = '1';
    services.commitRecoveryArchive.mockRejectedValueOnce(new RecoveryError('DESTINATION_CHANGED', 'The recovery destination changed.', 409));
    const conflict = await commit(upload(true));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe('DESTINATION_CHANGED');
    services.inspectRecoveryArchive.mockRejectedValueOnce(new Error('private connection string ' + sourceKey));
    const failure = await inspect(upload());
    expect(failure.status).toBe(500);
    expect(await failure.text()).not.toContain(sourceKey);
  });
});

describe.each([
  ['/api/database GET', oldGet], ['/api/database POST', oldPost], ['/api/database/restore-initial', oldInitial],
  ['/api/database/migrate', oldMigrate], ['/api/database/migrate-initial', oldInitialMigrate],
  ['/api/database/pre-migration-check', oldPrecheck], ['/api/database/pre-migration-check-initial', oldInitialPrecheck],
] as const)('retired %s', (_path, handler) => {
  it.each(['anonymous', 'user', 'admin', 'system', 'owner', 'setup', 'sysadmin'])('checks %s authority, then never reads or restores an upload', async credential => {
    const before = await state.db.appConfig.findMany();
    const request = jsonRequest('/api/database', { password, file: 'not an archive' }, tokens[credential]);
    const reader = vi.spyOn(request.body!, 'getReader');
    expect((await handler(request)).status).toBe(credential === 'anonymous' ? 401 : credential === 'sysadmin' ? 410 : 403);
    expect(reader).not.toHaveBeenCalled();
    expect(await state.db.appConfig.findMany()).toEqual(before);
    expect(services.commitRecoveryArchive).not.toHaveBeenCalled();
  });
});
