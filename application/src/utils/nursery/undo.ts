export type NurseryUndoKind = 'diaper' | 'food' | 'bottle' | 'breast' | 'pump';
export interface UndoRecord { id: string; revision: string }
export interface NurseryUndo {
  version: 1;
  kind: NurseryUndoKind;
  scope: string;
  babyId: string;
  records: UndoRecord[];
  sessionId?: string;
  /** Pump Undo includes the original linked feed, including its absence. */
  feed?: UndoRecord | null;
}

const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keysAre = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function readRecord(value: unknown): UndoRecord | null {
  return object(value) && keysAre(value, ['id', 'revision']) && identifier(value.id)
    && typeof value.revision === 'string' && /^[a-f\d]{64}$/.test(value.revision)
    ? { id: value.id, revision: value.revision } : null;
}

/** Strict wire validation; the scope is a client guard, never authorization. */
export function readNurseryUndo(value: unknown): NurseryUndo | null {
  if (!object(value) || value.version !== 1 || !['diaper', 'food', 'bottle', 'breast', 'pump'].includes(String(value.kind))
    || !identifier(value.babyId) || typeof value.scope !== 'string' || value.scope.length > 1000
    || !Array.isArray(value.records)) return null;
  const kind = value.kind as NurseryUndoKind;
  const keys = ['version', 'kind', 'scope', 'babyId', 'records', ...(kind === 'breast' ? ['sessionId'] : []), ...(kind === 'pump' ? ['feed'] : [])];
  if (!keysAre(value, keys) || value.records.length < 1 || value.records.length > (kind === 'breast' ? 2 : 1)) return null;
  const records = value.records.map(readRecord);
  if (records.some(row => !row) || new Set(records.map(row => row!.id)).size !== records.length) return null;
  try {
    const scope: unknown = JSON.parse(value.scope);
    if (!Array.isArray(scope) || scope.length !== 3 || scope.some(part => !identifier(part))
      || !/^(caretaker|account):.+/.test(scope[1]) || scope[2] !== value.babyId || JSON.stringify(scope) !== value.scope) return null;
  } catch { return null; }
  if (kind === 'breast' && !identifier(value.sessionId)) return null;
  const feed = kind === 'pump' && value.feed !== null ? readRecord(value.feed) : null;
  if (kind === 'pump' && value.feed !== null && !feed) return null;
  return { version: 1, kind, scope: value.scope, babyId: value.babyId, records: records as UndoRecord[],
    ...(kind === 'breast' ? { sessionId: value.sessionId as string } : {}), ...(kind === 'pump' ? { feed } : {}) };
}

export function nurseryUndoEndpoint(undo: NurseryUndo): string {
  const route = undo.kind === 'bottle' || undo.kind === 'breast' ? 'feed' : undo.kind;
  return `/api/${route}-log?id=${encodeURIComponent(undo.records[0].id)}`;
}
