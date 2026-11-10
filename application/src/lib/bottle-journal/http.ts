import { NextRequest, NextResponse } from 'next/server';
import { withAuthContext } from '@/app/api/utils/auth';
import { checkWritePermission } from '@/app/api/utils/writeProtection';
import { JournalError, object } from './validation';
import type { JournalActor } from './service';

export function journalRoute(handler: (request: NextRequest, actor: JournalActor) => Promise<NextResponse<any>>) {
  return withAuthContext<any>(async (request, auth) => {
    try {
      if (!auth.authenticated || !auth.familyId) throw new JournalError('Authentication and a family are required.', 401);
      if (!['GET', 'HEAD'].includes(request.method)) {
        const permission = checkWritePermission(auth);
        if (!permission.allowed) return permission.response!;
      }
      const response = await handler(request, { familyId: auth.familyId, caretakerId: auth.caretakerId,
        actorKey: auth.isAccountAuth && auth.accountId ? `account:${auth.accountId}` : `caretaker:${auth.caretakerId}`,
        canManage: Boolean(auth.isSysAdmin || auth.isAccountOwner || ['ADMIN', 'OWNER'].includes(auth.caretakerRole || '')) });
      response.headers.set('Cache-Control', 'private, no-store');
      response.headers.set('X-Content-Type-Options', 'nosniff');
      return response;
    } catch (error) {
      return NextResponse.json({ success: false, error: error instanceof JournalError ? error.message : 'The journal request failed. Refresh before retrying; your form has been kept.' }, {
        status: error instanceof JournalError ? error.status : 500, headers: { 'Cache-Control': 'private, no-store' },
      });
    }
  });
}
export async function readJournalJson(request: NextRequest): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new JournalError('Use a JSON request.', 415);
  const limit = 2 * 1024 * 1024;
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new JournalError('The file is too large (maximum 2 MB).', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new JournalError('A request body is required.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new JournalError('The file is too large (maximum 2 MB).', 413); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch (error) { if (error instanceof JournalError) throw error; throw new JournalError('Invalid journal JSON.'); }
}
