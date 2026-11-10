import { NextRequest, NextResponse } from 'next/server';
import type { AuthResult } from './auth';
import { journalScope } from '@/src/lib/bottle-journal/outbox-identity';
import { readNurseryUndo, type NurseryUndo, type NurseryUndoKind } from '@/src/utils/nursery/undo';
import { careRevision, type RevisionModel } from './care-revision';

export class NurseryUndoError extends Error {
  constructor(message = 'This entry changed or was removed. Undo could not be confirmed. Review the care log.',
    readonly status = 409, readonly code = 'NURSERY_UNDO_CONFLICT') { super(message); }
  response() { return NextResponse.json({ success: false, error: this.message, code: this.code }, { status: this.status }); }
}

export function nurseryActor(auth: AuthResult): string | null {
  if (auth.isSetupAuth || auth.isSysAdmin) return null;
  return auth.isAccountAuth && auth.accountId ? `account:${auth.accountId}` : auth.caretakerId ? `caretaker:${auth.caretakerId}` : null;
}

export function assertNurseryScope(auth: AuthResult, babyId: string, expected: unknown) {
  const actor = nurseryActor(auth);
  if (!actor || !auth.familyId || expected !== journalScope(auth.familyId, actor, babyId)) {
    throw new NurseryUndoError('The caregiver or child changed. Return to the original caregiver and child to review this action.', 409, 'NURSERY_UNDO_SCOPE_CHANGED');
  }
}

/** Optional create metadata is stripped before ordinary care-field validation. */
export function readNurseryCreateScope(body: Record<string, unknown>, auth: AuthResult, babyId: string): string | null {
  if (!Object.hasOwn(body, 'nurseryScope')) return null;
  const expected = body.nurseryScope;
  delete body.nurseryScope;
  assertNurseryScope(auth, babyId, expected);
  return expected as string;
}

type SavedRow = { id: string; familyId: string | null; babyId: string };
export function makeNurseryUndo(kind: NurseryUndoKind, auth: AuthResult, rows: SavedRow[],
  extra: { sessionId?: string; feed?: SavedRow | null } = {}): NurseryUndo | null {
  const actor = nurseryActor(auth), babyId = rows[0]?.babyId;
  if (!auth.familyId || !actor || !babyId || rows.some(row => row.familyId !== auth.familyId || row.babyId !== babyId)) return null;
  return makeScopedNurseryUndo(kind, journalScope(auth.familyId, actor, babyId), rows, extra);
}

export function makeScopedNurseryUndo(kind: NurseryUndoKind, scope: string, rows: SavedRow[],
  extra: { sessionId?: string; feed?: SavedRow | null } = {}): NurseryUndo | null {
  const babyId = rows[0]?.babyId;
  if (!babyId) return null;
  const model: RevisionModel = kind === 'bottle' || kind === 'breast' ? 'feed' : kind;
  return readNurseryUndo({ version: 1, kind, babyId, scope,
    records: rows.map(row => ({ id: row.id, revision: careRevision(model, row) })),
    ...(kind === 'breast' ? { sessionId: extra.sessionId } : {}),
    ...(kind === 'pump' ? { feed: extra.feed ? { id: extra.feed.id, revision: careRevision('feed', extra.feed) } : null } : {}) });
}

export async function readNurseryUndoRequest(req: NextRequest, route: RevisionModel, id: string): Promise<NurseryUndo | null> {
  const raw = await req.text();
  if (!raw.trim()) return null;
  if (raw.length > 6000) throw new NurseryUndoError('Invalid Undo request. Review the care log.', 400, 'NURSERY_UNDO_INVALID');
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new NurseryUndoError('Invalid Undo request. Review the care log.', 400, 'NURSERY_UNDO_INVALID'); }
  const value = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  const undo = value && Object.keys(value).length === 1 ? readNurseryUndo(value.nurseryUndo) : null;
  if (!undo || (route === 'feed' ? !['bottle', 'breast'].includes(undo.kind) : undo.kind !== route) || undo.records[0].id !== id) {
    throw new NurseryUndoError('Invalid Undo request. Review the care log.', 400, 'NURSERY_UNDO_INVALID');
  }
  return undo;
}

export function assertUndoRow(undo: NurseryUndo, row: SavedRow & { deletedAt: Date | null }, index = 0) {
  const model: RevisionModel = undo.kind === 'bottle' || undo.kind === 'breast' ? 'feed' : undo.kind;
  if (row.id !== undo.records[index]?.id || row.babyId !== undo.babyId || row.deletedAt
    || careRevision(model, row) !== undo.records[index].revision) throw new NurseryUndoError();
}
