import path from 'node:path';
import { readdir, lstat, unlink } from 'node:fs/promises';
import type { PrismaClient } from '@prisma/client';
import { sealOcrState } from './crypto';

const directory = () => process.env.BABYTRACKER_OCR_FILES_DIR
  ? path.resolve(process.env.BABYTRACKER_OCR_FILES_DIR)
  : path.join(process.cwd(), 'Files', 'ocr');
const validName = (name: string) => /^[a-f\d-]{36}\.enc$/i.test(name);
async function remove(name: string) {
  if (!validName(name)) return;
  try { await unlink(path.join(directory(), name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

/** Internal maintenance only: never delete care events or review/audit evidence. */
export async function sweepOcrRetention(db: PrismaClient, now = new Date()): Promise<{ expired: number; orphaned: number }> {
  let expired = 0;
  const documents = await db.ocrDocument.findMany({
    where: { sourceExpiresAt: { lte: now }, sourceFile: { not: null } }, take: 100,
  });
  for (const document of documents) {
    const files = [document.sourceFile, ...(JSON.parse(document.previewFiles) as { file: string }[]).map(page => page.file)].filter((file): file is string => !!file);
    const claimed = await db.$transaction(async tx => {
      const result = await tx.ocrDocument.updateMany({
        where: { id: document.id, sourceFile: document.sourceFile },
        data: { sourceFile: null, previewFiles: '[]', purgedAt: now },
      });
      if (result.count) await tx.ocrAudit.create({ data: {
        documentId: document.id, action: 'retention-purge', actorId: null,
        snapshot: sealOcrState({ sourceHash: document.sourceHash, expiredAt: document.sourceExpiresAt.toISOString() }, `${document.familyId}:${document.id}:audit`),
      } });
      return result.count;
    });
    if (claimed) { for (const file of files) await remove(file); expired++; }
  }
  // Crash/cascade cleanup. A one-hour grace period protects in-flight uploads.
  let files: string[];
  try { files = await readdir(directory()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { expired, orphaned: 0 }; throw error; }
  const live = await db.ocrDocument.findMany({ select: { sourceFile: true, previewFiles: true } });
  const referenced = new Set(live.flatMap(document => [document.sourceFile, ...JSON.parse(document.previewFiles).map((page: { file: string }) => page.file)]));
  let orphaned = 0;
  for (const file of files) {
    if (!validName(file) || referenced.has(file)) continue;
    try {
      const stats = await lstat(path.join(directory(), file));
      if (stats.isFile() && now.getTime() - stats.mtimeMs > 3_600_000) { await remove(file); orphaned++; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return { expired, orphaned };
}

export function startOcrRetention(db: PrismaClient) {
  const state = globalThis as typeof globalThis & { __babytrackerRetention?: boolean };
  if (state.__babytrackerRetention) return;
  state.__babytrackerRetention = true;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await sweepOcrRetention(db); }
    catch { console.error('OCR source retention maintenance failed; source reads still enforce expiry.'); }
    finally { running = false; }
  };
  setTimeout(tick, 10_000).unref();
  setInterval(tick, 5 * 60_000).unref();
}
