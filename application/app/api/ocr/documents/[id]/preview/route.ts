import { NextResponse } from 'next/server';
import prisma from '@/app/api/db';
import { previewOcrReview } from '@/src/lib/ocr/documents';
import { ocrDocumentId, ocrRoute, readOcrJson } from '@/src/lib/ocr/http';
export const runtime = 'nodejs';
export const POST = ocrRoute(async (request, actor) => NextResponse.json({ success: true, data: await previewOcrReview(prisma, actor, ocrDocumentId(request), await readOcrJson(request)) }));
