import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy, config } from '@/proxy';

const originalMode = process.env.DEPLOYMENT_MODE;
const originalRecoveryMode = process.env.SAT_TRACKER_RECOVERY_MODE;

beforeEach(() => { delete process.env.SAT_TRACKER_RECOVERY_MODE; });

afterEach(() => {
  if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
  else process.env.DEPLOYMENT_MODE = originalMode;
  if (originalRecoveryMode === undefined) delete process.env.SAT_TRACKER_RECOVERY_MODE;
  else process.env.SAT_TRACKER_RECOVERY_MODE = originalRecoveryMode;
});

function requestFor(path: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`);
}

describe('marketing proxy', () => {
  describe('in saas mode', () => {
    beforeEach(() => {
      process.env.DEPLOYMENT_MODE = 'saas';
    });

    it('lets marketing routes through', () => {
      for (const path of ['/features', '/pricing', '/terms', '/privacy', '/gift-success']) {
        const response = proxy(requestFor(path));
        expect(response.status).toBe(200);
        expect(response.headers.get('location')).toBeNull();
      }
    });
  });

  describe('in self-hosted mode', () => {
    beforeEach(() => {
      process.env.DEPLOYMENT_MODE = 'selfhosted';
    });

    it('redirects marketing routes to /', () => {
      for (const path of ['/features', '/pricing', '/terms', '/privacy', '/gift-success']) {
        const response = proxy(requestFor(path));
        expect(response.status).toBeGreaterThanOrEqual(300);
        expect(response.status).toBeLessThan(400);
        expect(new URL(response.headers.get('location')!).pathname).toBe('/');
      }
    });
  });

  it('redirects when DEPLOYMENT_MODE is unset (self-hosted default)', () => {
    delete process.env.DEPLOYMENT_MODE;
    const response = proxy(requestFor('/pricing'));
    expect(new URL(response.headers.get('location')!).pathname).toBe('/');
  });

  it('matcher includes every route so recovery cannot bypass the proxy through an API or framework path', () => {
    expect(config.matcher).toBe('/:path*');
  });

  it.each(['saas', 'selfhosted'])('leaves nonmarketing application/API/static requests unchanged in normal %s mode', mode => {
    process.env.DEPLOYMENT_MODE = mode;
    for (const path of ['/', '/family/log-entry', '/api/auth', '/api/app-config/public', '/_next/static/chunks/app.js']) {
      const response = proxy(requestFor(path));
      expect(response.status).toBe(200);
      expect(response.headers.get('x-middleware-next')).toBe('1');
      expect(response.headers.get('location')).toBeNull();
    }
  });
});
