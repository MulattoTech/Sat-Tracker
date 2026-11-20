import { NextRequest, NextResponse } from 'next/server';
import { recoveryPathAllowed } from '@/src/lib/portable-recovery/access';
import { assertRecoveryToken } from '@/src/lib/portable-recovery/token';
import { RecoveryError } from '@/src/lib/portable-recovery/types';

/**
 * Gates the SaaS marketing routes at the proxy layer so the pages themselves can be
 * fully prerendered (crawlable HTML, real metadata). Self-hosted deployments
 * redirect to the root dispatcher instead of seeing marketing content.
 * DEPLOYMENT_MODE is read at request time, so one Docker image serves both
 * modes correctly.
 */
export function proxy(req: NextRequest): NextResponse {
  if (process.env.SAT_TRACKER_RECOVERY_MODE === '1') {
    if (recoveryPathAllowed(req.method, req.nextUrl.pathname)) {
      if (req.nextUrl.pathname.startsWith('/api/recovery/')) {
        try { assertRecoveryToken(req); }
        catch (error) {
          return NextResponse.json({ success: false,
            error: error instanceof RecoveryError ? error.message : 'Recovery authentication is unavailable.',
            code: error instanceof RecoveryError ? error.code : 'RECOVERY_UNAVAILABLE',
          }, { status: error instanceof RecoveryError ? error.status : 503, headers: { 'Cache-Control': 'no-store' } });
        }
      }
      return NextResponse.next();
    }
    return NextResponse.json({ success: false, error: 'This isolated instance only accepts recovery requests.' }, {
      status: 503, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    });
  }
  if (['/features', '/pricing', '/terms', '/privacy', '/gift-success'].includes(req.nextUrl.pathname) &&
    process.env.DEPLOYMENT_MODE !== 'saas') {
    return NextResponse.redirect(new URL('/', req.url));
  }
  return NextResponse.next();
}

export const config = {
  // Deliberately cover APIs and framework paths: recovery mode must fail closed.
  matcher: '/:path*',
};
