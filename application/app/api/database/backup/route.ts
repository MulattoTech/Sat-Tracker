import { NextResponse } from 'next/server';
import { withInstallationOwner } from '../../utils/recovery-authority';
import { createInstallationBackup } from '@/src/lib/portable-recovery/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = withInstallationOwner(async () => {
  const archive = await createInstallationBackup();
  return new NextResponse(new Uint8Array(archive.bytes), { headers: {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${archive.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
  } });
});
