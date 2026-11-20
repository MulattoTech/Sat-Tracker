import { NextResponse } from 'next/server';
import { MAX_PORTABLE_ARCHIVE_BYTES } from '@/src/lib/portable-recovery/archive';
import { RecoveryError } from '@/src/lib/portable-recovery/types';

const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
export { assertRecoveryToken, equalSecret } from '@/src/lib/portable-recovery/token';

/** Count actual streamed bytes; Content-Length is only an early rejection hint. */
export async function readBoundedBody(request: Request, limit: number): Promise<Buffer> {
  const declared = request.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw new RecoveryError('REQUEST_TOO_LARGE', 'The recovery request exceeds the supported size limit.', 413);
  }
  if (!request.body) throw new RecoveryError('REQUEST_BODY_REQUIRED', 'A request body is required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > limit) {
        void reader.cancel().catch(() => {});
        throw new RecoveryError('REQUEST_TOO_LARGE', 'The recovery request exceeds the supported size limit.', 413);
      }
      chunks.push(result.value);
    }
    return Buffer.concat(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

export async function readRecoveryUpload(request: Request, requireDigest: boolean): Promise<{
  bytes: Buffer; sourceKey: string; archiveSha256?: string;
}> {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
    throw new RecoveryError('MULTIPART_REQUIRED', 'Choose a backup archive and provide its recovery key.');
  }
  const body = await readBoundedBody(request, MAX_PORTABLE_ARCHIVE_BYTES + MULTIPART_OVERHEAD_BYTES);
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(body), { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    throw new RecoveryError('INVALID_MULTIPART', 'The recovery upload could not be read.');
  }
  const expected = requireDigest ? ['archive', 'sourceKey', 'archiveSha256'] : ['archive', 'sourceKey'];
  if ([...form.keys()].length !== expected.length || expected.some(key => form.getAll(key).length !== 1) ||
    [...form.keys()].some(key => !expected.includes(key))) {
    throw new RecoveryError('INVALID_UPLOAD_FIELDS', 'Provide exactly one archive, its recovery key and the inspected digest when required.');
  }
  const archive = form.get('archive');
  const sourceKey = form.get('sourceKey');
  const archiveSha256 = form.get('archiveSha256');
  if (!archive || typeof archive === 'string' || !archive.size) {
    throw new RecoveryError('ARCHIVE_REQUIRED', 'Choose a nonempty backup archive.');
  }
  if (archive.size > MAX_PORTABLE_ARCHIVE_BYTES) {
    throw new RecoveryError('ARCHIVE_TOO_LARGE', 'The backup archive exceeds the supported size limit.', 413);
  }
  if (typeof sourceKey !== 'string' || !/^[a-f\d]{64}$/i.test(sourceKey)) {
    throw new RecoveryError('INVALID_SOURCE_KEY', 'Enter the exact 64-character recovery key without spaces or line breaks.');
  }
  if (requireDigest && (typeof archiveSha256 !== 'string' || !/^[a-f\d]{64}$/.test(archiveSha256))) {
    throw new RecoveryError('INSPECTION_REQUIRED', 'Inspect this exact archive before recovering it.');
  }
  return { bytes: Buffer.from(await archive.arrayBuffer()), sourceKey,
    ...(typeof archiveSha256 === 'string' ? { archiveSha256 } : {}) };
}

export async function recoveryResponse(action: () => Promise<Response>): Promise<Response> {
  let response: Response;
  try { response = await action(); }
  catch (error) {
    const known = error instanceof RecoveryError;
    response = NextResponse.json({ success: false,
      error: known ? error.message : 'The recovery operation could not be completed.',
      code: known ? error.code : 'RECOVERY_REQUEST_FAILED',
    }, { status: known ? error.status : 500 });
  }
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
