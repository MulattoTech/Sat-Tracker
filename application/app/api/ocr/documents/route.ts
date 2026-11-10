import { NextResponse } from 'next/server';
import prisma from '@/app/api/db';
import { createOcrDocument, ocrDocumentView, purgeOcrSource } from '@/src/lib/ocr/documents';
import { ocrRoute, readOcrBody } from '@/src/lib/ocr/http';
import { OCR_LIMITS, parseOcrCrop } from '@/src/lib/ocr/intake';
import { OcrError } from '@/src/lib/ocr/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = ocrRoute(async (request, actor) => {
  const babyId = request.nextUrl.searchParams.get('babyId');
  if (!babyId || babyId.length > 100) throw new OcrError('Select a baby.');
  const baby = await prisma.baby.findFirst({ where: { id: babyId, familyId: actor.familyId, deletedAt: null }, select: { id: true } });
  if (!baby) throw new OcrError('Baby not found.', 404);
  const expired = await prisma.ocrDocument.findMany({ where: { familyId: actor.familyId, babyId, sourceExpiresAt: { lte: new Date() }, sourceFile: { not: null } }, take: 20 });
  for (const document of expired) await purgeOcrSource(prisma, actor, document.id);
  const documents = await prisma.ocrDocument.findMany({ where: { familyId: actor.familyId, babyId }, orderBy: { createdAt: 'desc' }, take: 30 });
  return NextResponse.json({ success: true, data: documents.map(document => ({
    id: document.id, babyId: document.babyId, originalName: document.originalName,
    mimeType: document.mimeType, pageCount: document.pageCount, parserVersion: document.parserVersion,
    sourceTimezone: document.sourceTimezone, revision: document.revision,
    committedAt: document.committedAt?.toISOString() || null,
    sourceExpiresAt: document.sourceExpiresAt.toISOString(),
    hasSource: !!document.sourceFile && document.sourceExpiresAt > new Date(),
    createdAt: document.createdAt.toISOString(),
  })) });
});

export const POST = ocrRoute(async (request, actor) => {
  const bytes = await readOcrBody(request, OCR_LIMITS.bytes + 64 * 1024);
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(bytes), { headers: { 'Content-Type': request.headers.get('content-type') || '' } }).formData();
  } catch { throw new OcrError('Upload a supported image or PDF.'); }
  const file = form.get('file');
  if (!(file instanceof File) || form.getAll('file').length !== 1 || file.size > OCR_LIMITS.bytes) throw new OcrError('Choose one document smaller than 12 MB.');
  const text = (name: string, max = 128) => {
    const value = form.get(name);
    if (typeof value !== 'string' || value.length > max) throw new OcrError(`Invalid ${name}.`);
    return value;
  };

  const selectedPageRaw = form.get('selectedPage');
  const selectedPage = typeof selectedPageRaw === 'string' && selectedPageRaw.trim() !== ''
    ? Number(selectedPageRaw)
    : undefined;
  if (selectedPage !== undefined && (!Number.isInteger(selectedPage) || selectedPage < 1 || selectedPage > OCR_LIMITS.maxPdfPages)) {
    throw new OcrError(`Selected page must be an integer between 1 and ${OCR_LIMITS.maxPdfPages}.`);
  }

  const cropRaw = form.get('crop');
  const crop = typeof cropRaw === 'string' && cropRaw.trim() !== ''
    ? parseOcrCrop(cropRaw)
    : undefined;

  const result = await createOcrDocument(prisma, actor, {
    bytes: Buffer.from(await file.arrayBuffer()), name: file.name, babyId: text('babyId'),
    timeZone: text('timeZone'), defaultDate: text('defaultDate', 10) || undefined,
    timeFormat: text('timeFormat', 10) as '24h' | '12h' | 'unknown', rotation: Number(text('rotation', 3)),
    retentionDays: Number(text('retentionDays', 3)), selectedPage, crop, signal: request.signal,
  });
  return NextResponse.json({ success: true, data: result });
});
