import { NextRequest, NextResponse } from 'next/server';
import { AuthResult, withAuthContext } from '@/app/api/utils/auth';
import { checkWritePermission } from '@/app/api/utils/writeProtection';
import type { OcrActor } from './documents';
import { OcrError } from './errors';

export function ocrPermission(auth: AuthResult): OcrActor {
  if (!auth.authenticated) throw new OcrError('Authentication required.', 401);
  if (!auth.familyId) throw new OcrError('A family is required.', 403);
  if (!(auth.isSysAdmin || auth.isAccountOwner || auth.caretakerRole === 'ADMIN' || auth.caretakerRole === 'OWNER')) {
    throw new OcrError('Administrator access is required to import external data.', 403);
  }
  return { familyId: auth.familyId, actorId: auth.caretakerId || null };
}

export function ocrRoute(handler: (request: NextRequest, actor: OcrActor) => Promise<NextResponse<any>>) {
  // Existing auth middleware also wraps binary download responses.
  return withAuthContext<any>(async (request: NextRequest, auth: AuthResult) => {
    try {
      if (process.env.BABYTRACKER_OCR_ENABLED === 'false') throw new OcrError('Document imports are disabled for this deployment.', 503);
      const actor = ocrPermission(auth);
      if (!['GET', 'HEAD'].includes(request.method)) {
        const writable = checkWritePermission(auth);
        if (!writable.allowed) return writable.response!;
      }
      const result = await handler(request, actor);
      result.headers.set('Cache-Control', 'private, no-store');
      result.headers.set('X-Content-Type-Options', 'nosniff');
      return result;
    } catch (error) {
      // Neither source text nor Prisma/native parser errors belong in logs or client responses.
      return NextResponse.json({ success: false, error: error instanceof OcrError ? error.message : 'The document operation failed. No success has been recorded; reload before retrying.' }, {
        status: error instanceof OcrError ? error.status : 500,
        headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
      });
    }
  });
}

export async function readOcrBody(request: NextRequest, limit: number): Promise<Buffer> {
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new OcrError('The upload is too large.', 413);
  if (!request.body) throw new OcrError('A request body is required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new OcrError('The upload is too large.', 413); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export async function readOcrJson(request: NextRequest): Promise<unknown> {
  try { return JSON.parse((await readOcrBody(request, 2 * 1024 * 1024)).toString('utf8')); }
  catch (error) { if (error instanceof OcrError) throw error; throw new OcrError('Invalid review JSON.'); }
}

export function ocrDocumentId(request: NextRequest): string {
  const id = request.nextUrl.pathname.split('/')[4];
  if (!id || !/^[a-f\d-]{36}$/i.test(id)) throw new OcrError('Document not found.', 404);
  return id;
}
