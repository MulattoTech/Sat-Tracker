import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { createMetadataTestDatabase } from './portableRecoveryTestUtils';

const state = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
const files = vi.hoisted(() => ({ decryptFile: vi.fn(() => Buffer.from('synthetic attachment')), deleteEncryptedFile: vi.fn() }));
vi.mock('../app/api/db', () => ({ get default() { return state.db; } }));
vi.mock('../src/lib/file-encryption', () => files);
vi.mock('../app/api/utils/api-logger', () => ({ logApiCall: vi.fn(async () => {}), getClientInfo: () => ({ ip: '127.0.0.63', userAgent: 'synthetic-feedback-isolation' }) }));
import { POST as login } from '../app/api/auth/route';
import { GET, DELETE } from '../app/api/feedback/file/[id]/route';

let fixture: ReturnType<typeof createMetadataTestDatabase>;
const tokens: Record<string, string> = {};
const saved = new Map<string, string | undefined>();
const request = (method: string, attachment: string, actor?: string) => new NextRequest('http://localhost/api/feedback/file/' + attachment, {
  method, headers: actor ? { Authorization: 'Bearer ' + tokens[actor] } : {},
});
async function authenticate(body: unknown): Promise<string> {
  const response = await login(new NextRequest('http://localhost/api/auth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  expect(response.status).toBe(200);
  return (await response.json()).data.token;
}

beforeAll(async () => {
  for (const key of ['JWT_SECRET', 'ENC_HASH', 'DEPLOYMENT_MODE', 'ENABLE_LOG']) saved.set(key, process.env[key]);
  process.env.JWT_SECRET = randomBytes(32).toString('hex'); process.env.ENC_HASH = 'ab'.repeat(32);
  process.env.DEPLOYMENT_MODE = 'selfhosted'; process.env.ENABLE_LOG = 'false';
  fixture = createMetadataTestDatabase(); state.db = fixture.db;
  for (const family of ['owned', 'foreign']) {
    await state.db.family.create({ data: { id: family, slug: family, name: 'Synthetic ' + family } });
    await state.db.settings.create({ data: { familyId: family, authType: 'CARETAKER', securityPin: '241357' } });
  }
  for (const [id, loginId, role, familyId] of [
    ['submitter', '61', 'USER', 'owned'], ['local-admin', '62', 'ADMIN', 'owned'],
    ['foreign-admin', '63', 'ADMIN', 'foreign'], ['foreign-user', '64', 'USER', 'foreign'],
  ] as const) {
    await state.db.caretaker.create({ data: { id, loginId, role, familyId, name: id, securityPin: '241357' } });
    tokens[id] = await authenticate({ loginId, securityPin: '241357', familySlug: familyId });
  }
  await state.db.appConfig.create({ data: { adminPass: 'Synthetic-installation-password', rootDomain: 'synthetic.invalid' } });
  tokens.sysadmin = await authenticate({ adminPassword: 'Synthetic-installation-password' });
  await state.db.feedback.create({ data: { id: 'thread', subject: 'Synthetic', message: 'Synthetic', familyId: 'owned', caretakerId: 'submitter' } });
  await state.db.feedback.create({ data: { id: 'reply', subject: 'Synthetic reply', message: 'Synthetic', familyId: 'owned', caretakerId: 'local-admin', parentId: 'thread' } });
  for (const feedbackId of ['thread', 'reply']) await state.db.feedbackAttachment.create({ data: {
    id: feedbackId + '-attachment', feedbackId, originalName: 'synthetic.png', storedName: feedbackId + '.enc', mimeType: 'image/png', fileSize: 20,
  } });
  await state.db.feedbackAttachment.create({ data: { id: 'delete-attachment', feedbackId: 'thread',
    originalName: 'synthetic.png', storedName: 'delete.enc', mimeType: 'image/png', fileSize: 20 } });
}, 20_000);
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  await fixture?.close();
  for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

describe('feedback attachment family administrator boundary', () => {
  it.each(['foreign-admin', 'foreign-user'])('denies %s reads before decrypting any attachment', async actor => {
    const response = await GET(request('GET', 'thread-attachment', actor));
    expect(response.status).toBe(404);
    expect(files.decryptFile).not.toHaveBeenCalled();
  });

  it('denies foreign administrator deletion without touching the file or metadata', async () => {
    const response = await DELETE(request('DELETE', 'delete-attachment', 'foreign-admin'));
    expect(response.status).toBe(404);
    expect(files.deleteEncryptedFile).not.toHaveBeenCalled();
    expect(await state.db.feedbackAttachment.count({ where: { id: 'delete-attachment' } })).toBe(1);
  });

  it.each(['submitter', 'local-admin', 'sysadmin'])('preserves %s access to the authorized thread', async actor => {
    const response = await GET(request('GET', 'thread-attachment', actor));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('synthetic attachment');
    expect(files.decryptFile).toHaveBeenCalledWith('thread.enc', 'feedback');
  });

  it('preserves the original submitter’s access to a reply attachment', async () => {
    const response = await GET(request('GET', 'reply-attachment', 'submitter'));
    expect(response.status).toBe(200);
    expect(files.decryptFile).toHaveBeenCalledWith('reply.enc', 'feedback');
  });

  it('requires authentication before resolving an attachment', async () => {
    const response = await GET(request('GET', 'thread-attachment'));
    expect(response.status).toBe(401); expect(files.decryptFile).not.toHaveBeenCalled();
  });
});
