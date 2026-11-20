import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { assertRecoveryToken, readBoundedBody, readRecoveryUpload } from '@/app/api/utils/recovery-http';
import { recoveryPathAllowed } from '@/src/lib/portable-recovery/access';
import { proxy } from '@/proxy';

afterEach(() => vi.unstubAllEnvs());

describe('isolated recovery request boundary', () => {
  it('requires explicit recovery mode, an explicit operator token and exact case', () => {
    const token = 'aB'.repeat(32);
    vi.stubEnv('SAT_TRACKER_RECOVERY_MODE', '0');
    vi.stubEnv('SAT_TRACKER_RECOVERY_TOKEN', token);
    const request = (value: string) => new Request('http://localhost/api/recovery/status', { headers: { 'X-Sat-Recovery-Token': value } });
    expect(() => assertRecoveryToken(request(token))).toThrow(/isolated recovery/i);
    vi.stubEnv('SAT_TRACKER_RECOVERY_MODE', '1');
    expect(() => assertRecoveryToken(request(token.toLowerCase()))).toThrow(/operator token/i);
    expect(() => assertRecoveryToken(request(token))).not.toThrow();
    vi.stubEnv('SAT_TRACKER_RECOVERY_TOKEN', 'short');
    expect(() => assertRecoveryToken(request('short'))).toThrow(/configured/i);
  });

  it('does not accept a bearer token, a cookie or a URL token as bootstrap authority', () => {
    vi.stubEnv('SAT_TRACKER_RECOVERY_MODE', '1');
    vi.stubEnv('SAT_TRACKER_RECOVERY_TOKEN', 'a'.repeat(64));
    const request = new Request('http://localhost/api/recovery/status?token=' + 'a'.repeat(64), {
      headers: { Authorization: 'Bearer ' + 'a'.repeat(64), Cookie: 'caretakerId=sysadmin' },
    });
    expect(() => assertRecoveryToken(request)).toThrow(/operator token/i);
  });

  it.each([undefined, '1'])('enforces the measured stream limit when Content-Length is %s', async length => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(4)); },
    }, { highWaterMark: 0 });
    const request = new Request('http://localhost', {
      method: 'POST', body, duplex: 'half', headers: length ? { 'Content-Length': length } : {},
    } as RequestInit);
    await expect(readBoundedBody(request, 6)).rejects.toMatchObject({ status: 413 });
    expect(pulls).toBe(2);
  });

  it('rejects an oversized declared body before reading it and accepts the exact measured bound', async () => {
    const oversized = new Request('http://localhost', { method: 'POST', body: 'x', headers: { 'Content-Length': '9' } });
    const reader = vi.spyOn(oversized.body!, 'getReader');
    await expect(readBoundedBody(oversized, 8)).rejects.toMatchObject({ status: 413 });
    expect(reader).not.toHaveBeenCalled();
    expect(await readBoundedBody(new Request('http://localhost', { method: 'POST', body: '12345678' }), 8)).toEqual(Buffer.from('12345678'));
  });

  it('preserves the exact source key and commit digest from a bounded multipart request', async () => {
    const form = new FormData();
    form.set('archive', new Blob(['synthetic archive']), 'portable.zip');
    form.set('sourceKey', 'aB'.repeat(32));
    form.set('archiveSha256', 'c'.repeat(64));
    const result = await readRecoveryUpload(new Request('http://localhost', { method: 'POST', body: form }), true);
    expect(result.bytes.toString()).toBe('synthetic archive');
    expect(result.sourceKey).toBe('aB'.repeat(32));
    expect(result.archiveSha256).toBe('c'.repeat(64));
  });

  it.each(['duplicate', 'unknown', 'newline-key', 'uppercase-digest', 'missing-digest'])('rejects ambiguous multipart input: %s', async variant => {
    const form = new FormData();
    form.set('archive', new Blob(['synthetic archive']), 'portable.zip');
    form.set('sourceKey', 'a'.repeat(64));
    form.set('archiveSha256', 'c'.repeat(64));
    if (variant === 'duplicate') form.append('archive', new Blob(['other archive']), 'other.zip');
    if (variant === 'unknown') form.set('destination', '/live/database');
    if (variant === 'newline-key') form.set('sourceKey', 'a'.repeat(64) + '\n');
    if (variant === 'uppercase-digest') form.set('archiveSha256', 'C'.repeat(64));
    if (variant === 'missing-digest') form.delete('archiveSha256');
    await expect(readRecoveryUpload(new Request('http://localhost', { method: 'POST', body: form }), true)).rejects.toMatchObject({ status: 400 });
  });
});

describe('recovery-only proxy allowlist', () => {
  it.each(['/api/auth', '/api/app-config/public', '/api/settings', '/api/notifications/cron', '/api/database/backup', '/setup', '/family-manager', '/api/recovery/unknown', '/_next/image'])('blocks %s', pathname => {
    vi.stubEnv('SAT_TRACKER_RECOVERY_MODE', '1');
    expect(recoveryPathAllowed('GET', pathname)).toBe(false);
    expect(proxy(new NextRequest('http://localhost' + pathname)).status).toBe(503);
  });

  it.each([
    ['GET', '/recovery'], ['GET', '/api/recovery/status'], ['POST', '/api/recovery/inspect'],
    ['POST', '/api/recovery/commit'], ['GET', '/_next/static/chunks/example.js'], ['GET', '/favicon.ico'],
  ])('permits only %s %s', (method, pathname) => {
    vi.stubEnv('SAT_TRACKER_RECOVERY_MODE', '1');
    vi.stubEnv('SAT_TRACKER_RECOVERY_TOKEN', 'a'.repeat(64));
    expect(recoveryPathAllowed(method, pathname)).toBe(true);
    expect(proxy(new NextRequest('http://localhost' + pathname, { method, headers: { 'X-Sat-Recovery-Token': 'a'.repeat(64) } })).headers.get('x-middleware-next')).toBe('1');
  });

  it('uses the same token authority before forwarding an allowed recovery API', () => {
    vi.stubEnv('SAT_TRACKER_RECOVERY_MODE', '1');
    vi.stubEnv('SAT_TRACKER_RECOVERY_TOKEN', 'a'.repeat(64));
    const response = proxy(new NextRequest('http://localhost/api/recovery/inspect', { method: 'POST', body: 'unparsed' }));
    expect(response.status).toBe(401);
    expect(response.headers.get('x-middleware-next')).toBeNull();
  });

  it('blocks unsafe methods and encoded static traversal while preserving normal routing', () => {
    expect(recoveryPathAllowed('POST', '/recovery')).toBe(false);
    expect(recoveryPathAllowed('POST', '/api/recovery/status')).toBe(false);
    expect(recoveryPathAllowed('GET', '/_next/static/%2e%2e/api/auth')).toBe(false);
    vi.stubEnv('SAT_TRACKER_RECOVERY_MODE', '0');
    vi.stubEnv('DEPLOYMENT_MODE', 'selfhosted');
    expect(proxy(new NextRequest('http://localhost/api/auth')).headers.get('x-middleware-next')).toBe('1');
    expect(proxy(new NextRequest('http://localhost/features')).status).toBe(307);
    vi.stubEnv('DEPLOYMENT_MODE', 'saas');
    expect(proxy(new NextRequest('http://localhost/features')).headers.get('x-middleware-next')).toBe('1');
  });
});
