import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestSleepJSON } from '@/src/utils/nursery/sleepRequest';
afterEach(() => vi.useRealTimers());
describe('bounded complete sleep requests', () => {
  it('returns confirmed JSON and clears its timer without aborting the response', async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => { signal = options?.signal as AbortSignal; return new Response(JSON.stringify({ success: true, data: [] })); });
    const result = await requestSleepJSON(fetcher, '/api/sleep-log'); expect(result.data).toEqual({ success: true, data: [] });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0); expect(signal?.aborted).toBe(false);
  });
  it('bounds an authenticated fetch that never settles, aborts, and never automatically retries', async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    const fetcher = vi.fn((_url: string, options?: RequestInit) => { signal = options?.signal as AbortSignal; return new Promise<Response>(() => {}); });
    const pending = requestSleepJSON(fetcher, '/api/sleep-log', { method: 'POST' }); const rejection = expect(pending).rejects.toThrow('not confirmed');
    await vi.advanceTimersByTimeAsync(20_000); await rejection; expect(signal?.aborted).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('also bounds a stalled response body after successful headers', async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => { signal = options?.signal as AbortSignal; return { json: () => new Promise(() => {}) } as Response; });
    const pending = requestSleepJSON(fetcher, '/api/sleep-log'); const rejection = expect(pending).rejects.toThrow('not confirmed');
    await vi.advanceTimersByTimeAsync(20_000); await rejection; expect(signal?.aborted).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
});
