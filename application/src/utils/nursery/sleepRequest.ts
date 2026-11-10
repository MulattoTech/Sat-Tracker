type SleepFetch = (url: string, options?: RequestInit) => Promise<Response>;

/** Timeout means uncertain delivery. Callers retain the original intent; this
 * boundary never creates another action or retries a request automatically. */
export async function requestSleepJSON(fetcher: SleepFetch, url: string, options: RequestInit = {}) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Sleep request was not confirmed.')); }, 20_000);
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
