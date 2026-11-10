import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestBreastfeedJSON } from '@/src/utils/nursery/breastfeedRequest';

afterEach(() => vi.useRealTimers());
describe('bounded breastfeeding requests', () => {
  it.each(['fetch', 'body'])('releases an uncertain %s stall and aborts its signal', async stage => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const never = new Promise<never>(() => {});
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
      signal = options?.signal as AbortSignal;
      return stage === 'fetch' ? never : { json: () => never } as unknown as Response;
    });
    const result = requestBreastfeedJSON(fetcher, '/api/active-breastfeed', { method: 'DELETE', body: 'original payload' });
    const rejection = expect(result).rejects.toThrow('not confirmed');
    await vi.advanceTimersByTimeAsync(20_000);
    await rejection;
    expect(signal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.body).toBe('original payload');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels its timer after a fully read response and never aborts that finished request later', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const response = new Response(JSON.stringify({ success: true, data: null }));
    const result = await requestBreastfeedJSON(async (_url, options) => {
      signal = options?.signal as AbortSignal; return response;
    }, '/api/active-breastfeed');
    expect(result).toEqual({ response, data: { success: true, data: null } });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(signal?.aborted).toBe(false);
  });
});
