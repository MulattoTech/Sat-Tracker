type SessionFetch = (url: string, options?: RequestInit) => Promise<Response>;

/** Bound the complete authenticated request, including refresh and body reading.
 * A timeout is uncertain delivery: the caller keeps its original stop intent. */
export async function requestBreastfeedJSON(fetcher: SessionFetch, url: string, options: RequestInit = {}) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Breastfeeding request was not confirmed.'));
    }, 20_000);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetcher(url, { ...options, signal: controller.signal });
        const data = await response.json();
        return { response, data };
      })(),
      deadline,
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
