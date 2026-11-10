import type { QuickCareIntent } from './quickCareIntent';
import { readNurseryUndo, type NurseryUndo } from './undo';

/** Includes the global authentication refresh and JSON body read. Aborting
 * alone cannot bound a wrapper that waits for a separate refresh promise. */
export async function requestQuickCareJSON(fetcher: (url: string, options?: RequestInit) => Promise<Response>,
  url: string, options: RequestInit = {}) {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('The care action was not confirmed.')); }, 20_000);
  });
  try {
    return await Promise.race([
      (async () => { const response = await fetcher(url, { ...options, signal: controller.signal });
        return { response, data: await response.json() }; })(), deadline,
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export interface QuickCareSaved { id: string; time: string; undo: NurseryUndo }
export function readQuickCareSaved(intent: QuickCareIntent, input: unknown): QuickCareSaved | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>, row = value.data as Record<string, unknown> | undefined;
  const undo = readNurseryUndo(value.undo);
  if (value.success !== true || typeof value.replayed !== 'boolean' || !row || typeof row !== 'object'
    || typeof row.id !== 'string' || row.familyId !== intent.familyId || row.babyId !== intent.babyId
    || row.time !== intent.time || row.deletedAt !== null || !undo || undo.scope !== intent.scope
    || undo.kind !== intent.kind || undo.records[0].id !== row.id) return null;
  const actor = (JSON.parse(intent.scope) as string[])[1];
  if (actor.startsWith('caretaker:') && row.caretakerId !== actor.slice('caretaker:'.length)) return null;
  if (intent.kind === 'diaper' ? row.type !== intent.type : row.foodId !== intent.foodId) return null;
  return { id: row.id, time: intent.time, undo };
}
