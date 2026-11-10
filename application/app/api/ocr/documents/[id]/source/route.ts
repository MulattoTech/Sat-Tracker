import { NextResponse } from 'next/server';
import prisma from '@/app/api/db';
import { readOcrSource } from '@/src/lib/ocr/documents';
import { ocrDocumentId, ocrRoute } from '@/src/lib/ocr/http';
import { OCR_LIMITS } from '@/src/lib/ocr/intake';
import { OcrError } from '@/src/lib/ocr/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = ocrRoute(async (request, actor) => {
  const selected = request.nextUrl.searchParams.get('page');
  const page = selected === null ? undefined : Number(selected);
  if (page !== undefined && (!Number.isInteger(page) || page < 1 || page > OCR_LIMITS.maxPdfPages)) throw new OcrError('Invalid source page.');
  const source = await readOcrSource(prisma, actor, ocrDocumentId(request), page);
  return new NextResponse(new Uint8Array(source.bytes), { headers: {
    'Content-Type': source.mimeType,
    'Content-Disposition': page === undefined ? 'attachment; filename="source-document"' : 'inline; filename="source-page.png"',
    'Content-Security-Policy': "sandbox; default-src 'none'", 'Referrer-Policy': 'no-referrer',
  } });
});
