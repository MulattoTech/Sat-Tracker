import { afterEach, describe, expect, it, vi } from 'vitest';
import { readNurseryUndo, nurseryUndoEndpoint, type NurseryUndo } from '@/src/utils/nursery/undo';
import { requestNurseryUndo, NurseryUndoFailure, undoConflict, undoUnconfirmed, undoScopeChanged, undoSignIn } from '@/src/utils/nursery/undoRequest';

const scope = JSON.stringify(['family', 'caretaker:actor', 'child']);
const record = { id: 'record', revision: 'a'.repeat(64) };
const original: NurseryUndo = { version: 1, kind: 'diaper', scope, babyId: 'child', records: [record] };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('immutable Nursery Undo descriptors', () => {
  it('copies the exact descriptor without retaining mutable caller arrays', () => {
    const copy = readNurseryUndo(original)!;
    expect(copy).toEqual(original); expect(copy).not.toBe(original); expect(copy.records[0]).not.toBe(record);
  });
  it.each([
    null, [], {}, { ...original, version: 2 }, { ...original, extra: true }, { ...original, scope: 'not-json' },
    { ...original, scope: JSON.stringify(['family', 'actor', 'child']) }, { ...original, babyId: 'other-child' },
    { ...original, records: [] }, { ...original, records: [record, record] }, { ...original, records: [{ ...record, revision: null }] },
    { ...original, records: [{ ...record, revision: 'A'.repeat(64) }] }, { ...original, records: [{ ...record, unsafe: true }] },
    { ...original, kind: 'pump' }, { ...original, kind: 'pump', feed: {} }, { ...original, kind: 'breast' },
    { ...original, kind: 'breast', sessionId: 'session', records: [record, { ...record, id: 'two' }, { ...record, id: 'three' }] },
  ])('rejects malformed or ambiguous metadata: %j', value => { expect(readNurseryUndo(value)).toBeNull(); });
  it('requires explicit pump-feed absence and preserves one/two breast side identities', () => {
    expect(readNurseryUndo({ ...original, kind: 'pump', feed: null })?.feed).toBeNull();
    expect(readNurseryUndo({ ...original, kind: 'pump', feed: { ...record, id: 'feed' } })?.feed?.id).toBe('feed');
    const breast = readNurseryUndo({ ...original, kind: 'breast', sessionId: 'session', records: [record, { ...record, id: 'right' }] })!;
    expect(breast.records).toHaveLength(2); expect(nurseryUndoEndpoint(breast)).toBe('/api/feed-log?id=record');
  });
});

describe('conditional Undo transport', () => {
  const setup = () => { vi.stubGlobal('localStorage', { getItem: () => 'original-token' }); };
  it('sends only the original revision and never fetches a fresh baseline', async () => {
    setup(); const fetcher = vi.fn(async () => Response.json({ success: true }));
    expect(await requestNurseryUndo(original, () => scope, fetcher)).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce(); const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/diaper-log?id=record'); expect(options.method).toBe('DELETE');
    expect(JSON.parse(options.body as string)).toEqual({ nurseryUndo: original });
    expect(options.headers).toMatchObject({ Authorization: 'Bearer original-token' });
  });
  it.each([400, 404, 409])('keeps a %s conflict as review, never false success', async status => {
    setup(); const fetcher = vi.fn(async () => Response.json({ success: false }, { status }));
    await expect(requestNurseryUndo(original, () => scope, fetcher)).rejects.toMatchObject({ message: undoConflict, retryable: false });
  });
  it.each([401, 403])('keeps %s authentication failure bound to the original actor', async status => {
    setup(); await expect(requestNurseryUndo(original, () => scope, async () => Response.json({ success: false }, { status })))
      .rejects.toMatchObject({ message: undoSignIn, retryable: true });
  });
  it.each(['network', 'json', 'server', 'busy', 'malformed-success'])('retains the same original request after %s uncertainty', async failure => {
    setup(); const fetcher = vi.fn(async () => {
      if (failure === 'network') throw new TypeError('offline');
      if (failure === 'json') return new Response('unreadable', { status: 200 });
      return Response.json({ success: false, ...(failure === 'busy' ? { code: 'NURSERY_UNDO_BUSY' } : {}) },
        { status: failure === 'server' ? 500 : failure === 'busy' ? 409 : 200 });
    });
    await expect(requestNurseryUndo(original, () => scope, fetcher)).rejects.toMatchObject({ message: undoUnconfirmed, retryable: true });
  });
  it('blocks dispatch under a changed owner and ignores a late result for another owner', async () => {
    setup(); const fetcher = vi.fn(async () => Response.json({ success: true }));
    await expect(requestNurseryUndo(original, () => 'other', fetcher)).rejects.toMatchObject({ message: undoScopeChanged, retryable: false });
    expect(fetcher).not.toHaveBeenCalled();
    let current = scope;
    expect(await requestNurseryUndo(original, () => current, async () => { current = 'other'; return Response.json({ success: true }); })).toBe(false);
    expect(new NurseryUndoFailure(undoConflict, false)).toBeInstanceOf(Error);
  });
  it.each(['fetch', 'body'])('bounds an unresponsive %s even when it ignores the request signal', async stage => {
    setup(); vi.useFakeTimers(); let signal: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>((_url, options) => {
      signal = options?.signal;
      if (stage === 'fetch') return new Promise<Response>(() => {});
      const response = Response.json({ success: true });
      vi.spyOn(response, 'json').mockReturnValue(new Promise(() => {}));
      return Promise.resolve(response);
    });
    let outcome: { error?: unknown } | undefined;
    const pending = requestNurseryUndo(original, () => scope, fetcher)
      .then(() => { outcome = {}; }, error => { outcome = { error }; });
    await vi.advanceTimersByTimeAsync(20_001);
    expect(outcome).toMatchObject({ error: { message: undoUnconfirmed, retryable: true } });
    expect(signal?.aborted).toBe(true); expect(fetcher).toHaveBeenCalledOnce();
    await pending; expect(vi.getTimerCount()).toBe(0);
  });
});
