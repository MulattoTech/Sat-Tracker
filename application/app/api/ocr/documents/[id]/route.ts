import { NextResponse } from 'next/server';
import prisma from '@/app/api/db';
import { ocrDocumentView, requireOcrDocument, saveOcrReview, purgeOcrSource } from '@/src/lib/ocr/documents';
import { ocrDocumentId, ocrRoute, readOcrJson } from '@/src/lib/ocr/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = ocrRoute(async (request, actor) => NextResponse.json({ success: true, data: ocrDocumentView(await requireOcrDocument(prisma, actor, ocrDocumentId(request))) }));
export const PATCH = ocrRoute(async (request, actor) => NextResponse.json({ success: true, data: await saveOcrReview(prisma, actor, ocrDocumentId(request), await readOcrJson(request)) }));
export const DELETE = ocrRoute(async (request, actor) => NextResponse.json({ success: true, data: await purgeOcrSource(prisma, actor, ocrDocumentId(request)) }));
