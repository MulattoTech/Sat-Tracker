import { NextResponse } from 'next/server';
import { withInstallationOwner } from '../../utils/recovery-authority';
import { getSourceRecoveryKey } from '@/src/lib/portable-recovery/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = withInstallationOwner(async () => new NextResponse(getSourceRecoveryKey(), { headers: {
  'Content-Type': 'text/plain; charset=utf-8',
  'Content-Disposition': 'attachment; filename="sat-tracker-recovery-key.txt"',
} }));
