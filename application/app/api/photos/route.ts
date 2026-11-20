import { NextRequest, NextResponse } from 'next/server';
import prisma from '../db';
import { ApiResponse, PhotoListResponse } from '../types';
import { withAuthContext, AuthResult } from '../utils/auth';
import {
  isPhotosEnabled,
  photosDisabledResponse,
  getQuotaInfo,
  purgeExpiredPhotos,
  resolveFavoriteOwner,
  PHOTO_INCLUDE,
} from './photo-service';
import { toAuthorizedPhotoResponses } from './photo-read';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

/**
 * GET /api/photos?babyId=&trash=true&cursor=&limit=
 * Newest-first (takenAt desc) cursor-paginated photo list with quota meta.
 * Search/type/favorite filtering is client-side (spec section 6).
 */
async function handleGet(req: NextRequest, authContext: AuthResult) {
  if (!(await isPhotosEnabled())) return photosDisabledResponse();

  try {
    const { familyId } = authContext;
    const { searchParams } = new URL(req.url);
    const babyId = searchParams.get('babyId');
    const trash = searchParams.get('trash') === 'true';
    const cursor = searchParams.get('cursor');
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);

    if (!familyId) return NextResponse.json({ success: false, error: 'Photo not found' }, { status: 404 });
    await purgeExpiredPhotos(familyId!);

    const where = {
      familyId,
      baby: { familyId, deletedAt: null },
      deletedAt: trash ? { not: null } : null,
      ...(babyId && { babyId }),
    };

    const [photos, trashCount, quota, owner] = await Promise.all([
      prisma.photo.findMany({
        where,
        include: PHOTO_INCLUDE,
        orderBy: [{ takenAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      }),
      prisma.photo.count({ where: { familyId, deletedAt: { not: null } } }),
      getQuotaInfo(familyId!),
      resolveFavoriteOwner(authContext),
    ]);

    const hasMore = photos.length > limit;
    const page = hasMore ? photos.slice(0, limit) : photos;

    const response: PhotoListResponse = {
      photos: await toAuthorizedPhotoResponses(prisma, familyId, page, owner),
      nextCursor: hasMore ? page[page.length - 1].id : null,
      trashCount,
      quota,
    };

    return NextResponse.json<ApiResponse<PhotoListResponse>>({ success: true, data: response }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('Error listing photos:', error);
    return NextResponse.json<ApiResponse<null>>({ success: false, error: 'Failed to load photos' }, { status: 500 });
  }
}

export const GET = withAuthContext(handleGet as any);
