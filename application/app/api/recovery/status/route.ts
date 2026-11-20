import { NextRequest, NextResponse } from 'next/server';
import { assertRecoveryToken, recoveryResponse } from '../../utils/recovery-http';
import { getRecoveryStatus } from '@/src/lib/portable-recovery/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest): Promise<Response> {
  return recoveryResponse(async () => {
    assertRecoveryToken(request);
    return NextResponse.json({ success: true, data: await getRecoveryStatus() });
  });
}
