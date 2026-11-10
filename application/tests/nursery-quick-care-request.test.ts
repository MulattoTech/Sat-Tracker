import { afterEach, describe, expect, it, vi } from 'vitest';
import { readQuickCareSaved, requestQuickCareJSON } from '@/src/utils/nursery/quickCareRequest';
import type { QuickCareIntent } from '@/src/utils/nursery/quickCareIntent';
const scope = JSON.stringify(['family', 'caretaker:one', 'child']);
const intent: QuickCareIntent = { version: 1, kind: 'diaper', scope, familyId: 'family', babyId: 'child',
  requestId: '11111111-2222-3333-4444-555555555555', time: '2026-10-20T12:00:00.000Z', type: 'WET' };
const responseBody = () => ({ success: true, replayed: true,
  data: { id: 'diaper-one', familyId: 'family', babyId: 'child', caretakerId: 'one', time: intent.time, type: 'WET', deletedAt: null },
  undo: { version: 1, kind: 'diaper', scope, babyId: 'child', records: [{ id: 'diaper-one', revision: 'a'.repeat(64) }] } });
afterEach(() => vi.useRealTimers());

describe('bounded complete quick-care delivery and exact confirmation', () => {
  it('returns confirmed JSON and releases its deadline without aborting the response', async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => { signal = options?.signal as AbortSignal; return new Response(JSON.stringify(responseBody())); });
    const result = await requestQuickCareJSON(fetcher, '/api/diaper-log'); expect(result.data).toEqual(responseBody());
    expect(fetcher).toHaveBeenCalledTimes(1); expect(signal?.aborted).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['authentication refresh', 'response body'] as const)('bounds a stalled %s with an outer deadline and does not auto retry', async stage => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    const fetcher = vi.fn((_url: string, options?: RequestInit) => {
      signal = options?.signal as AbortSignal;
      return stage === 'authentication refresh' ? new Promise<Response>(() => {}) : Promise.resolve({ json: () => new Promise(() => {}) } as Response);
    });
    const pending = requestQuickCareJSON(fetcher, '/api/diaper-log', { method: 'POST' });
    const rejection = expect(pending).rejects.toThrow('not confirmed'); await vi.advanceTimersByTimeAsync(20_000); await rejection;
    expect(fetcher).toHaveBeenCalledTimes(1); expect(signal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it('accepts only the original owner, time, action and server Undo descriptor', () => {
    expect(readQuickCareSaved(intent, responseBody())).toMatchObject({ id: 'diaper-one', time: intent.time });
    for (const patch of [{ babyId: 'sibling' }, { familyId: 'foreign' }, { caretakerId: 'peer' }, { type: 'BOTH' },
      { time: '2026-10-20T12:02:00.000Z' }, { deletedAt: intent.time }]) {
      const body = responseBody(); Object.assign(body.data, patch); expect(readQuickCareSaved(intent, body)).toBeNull();
    }
    for (const patch of [{ scope: JSON.stringify(['family', 'caretaker:peer', 'child']) }, { records: [{ id: 'other', revision: 'a'.repeat(64) }] },
      { kind: 'food' }, { records: [{ id: 'diaper-one', revision: 'invalid' }] }]) {
      const body = responseBody(); Object.assign(body.undo, patch); expect(readQuickCareSaved(intent, body)).toBeNull();
    }
    expect(readQuickCareSaved(intent, { ...responseBody(), success: false })).toBeNull();
    expect(readQuickCareSaved(intent, { ...responseBody(), undo: undefined })).toBeNull();
  });
});
