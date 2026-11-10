import { NextResponse } from 'next/server';
import prisma from '@/app/api/db';
import { redactOcrDocument } from '@/src/lib/ocr/documents';
import { ocrDocumentId, ocrRoute, readOcrJson } from '@/src/lib/ocr/http';
import { readOcrRedactionOptions } from '@/src/lib/ocr/redaction';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = ocrRoute(async (request, actor) => {
  const options = readOcrRedactionOptions(await readOcrJson(request));
  return NextResponse.json({
    success: true,
    data: await redactOcrDocument(prisma, actor, ocrDocumentId(request), options),
  });
});
