import { NextRequest, NextResponse } from 'next/server';
import { assertRecoveryToken, readRecoveryUpload, recoveryResponse } from './recovery-http';
import { getRecoveryStatus, inspectRecoveryArchive, commitRecoveryArchive } from '@/src/lib/portable-recovery/service';
import { RecoveryError } from '@/src/lib/portable-recovery/types';

export function recoveryUploadRoute(request: NextRequest, commit: boolean): Promise<Response> {
  return recoveryResponse(async () => {
    assertRecoveryToken(request);
    const status = await getRecoveryStatus();
    if (status.state !== 'empty' || !status.ready) {
      throw new RecoveryError('RECOVERY_DESTINATION_BLOCKED', 'This destination is not empty and ready for recovery. Check its recovery status.', 409);
    }
    const upload = await readRecoveryUpload(request, commit);
    const data = commit
      ? await commitRecoveryArchive(upload.bytes, upload.sourceKey, upload.archiveSha256!)
      : await inspectRecoveryArchive(upload.bytes, upload.sourceKey);
    return NextResponse.json({ success: true, data });
  });
}
