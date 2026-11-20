import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../db';
import { ApiResponse, PhotoResponse } from '../../types';
import { withAuthContext, AuthResult } from '../../utils/auth';
import { checkWritePermission } from '../../utils/writeProtection';
import { withPhotoIntegrity } from '../../utils/photo-integrity';
import { isPhotosEnabled, photosDisabledResponse, photoErrorResponse, requirePhotoTimestamp, resolveFavoriteOwner, PHOTO_INCLUDE } from '../photo-service';
import { PhotoOwnershipError, requirePhotoFamily, requirePhotoIdentifier, requirePhotoWriteObject } from '../photo-ownership';
import { setPhotoMilestone } from '../photo-link-service';
import { toAuthorizedPhotoResponses } from '../photo-read';

function extractId(req: NextRequest): string {
  return requirePhotoIdentifier(new URL(req.url).pathname.split('/').at(-1), 'Photo ID');
}

/** A direct, sanitized lookup; independent of gallery pagination. */
async function handleGet(req: NextRequest, authContext: AuthResult) {
  if (!(await isPhotosEnabled())) return photosDisabledResponse();
  try {
    const familyId = requirePhotoFamily(authContext.familyId);
    const id = extractId(req);
    const [photo, owner] = await Promise.all([
      prisma.photo.findFirst({ where: { id, familyId }, include: PHOTO_INCLUDE }),
      resolveFavoriteOwner(authContext),
    ]);
    const data = photo ? (await toAuthorizedPhotoResponses(prisma, familyId, [photo], owner))[0] : undefined;
    if (!data) throw new PhotoOwnershipError(404, 'Photo not found.');
    return NextResponse.json<ApiResponse<PhotoResponse>>({ success: true, data }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return photoErrorResponse(error, 'Failed to fetch photo'); }
}

/** Caption/time edits preserve omitted tags and all historical associations. */
async function handlePatch(req: NextRequest, authContext: AuthResult) {
  if (!(await isPhotosEnabled())) return photosDisabledResponse();
  const writeCheck = checkWritePermission(authContext);
  if (!writeCheck.allowed) return writeCheck.response!;
  try {
    const id = extractId(req);
    const familyId = requirePhotoFamily(authContext.familyId);
    const body = requirePhotoWriteObject(await req.json(), ['caption', 'takenAt', 'milestoneId']);
    if ('caption' in body && body.caption !== null && typeof body.caption !== 'string') throw new PhotoOwnershipError(400, 'Caption must be text or null.');
    const takenAt = 'takenAt' in body ? requirePhotoTimestamp(body.takenAt, 'Taken at') : undefined;
    const milestoneId = 'milestoneId' in body
      ? body.milestoneId === null ? null : requirePhotoIdentifier(body.milestoneId, 'Milestone ID')
      : undefined;
    const photo = await withPhotoIntegrity(prisma, familyId, async tx => {
      const existing = await tx.photo.findFirst({ where: { id, familyId } });
      if (!existing) throw new PhotoOwnershipError(404, 'Photo not found.');
      if (milestoneId !== undefined) await setPhotoMilestone(tx, familyId, id, milestoneId);
      if ('caption' in body || takenAt !== undefined) {
        await tx.photo.update({ where: { id }, data: {
          ...('caption' in body ? { caption: typeof body.caption === 'string' ? body.caption.trim() || null : null } : {}),
          ...(takenAt !== undefined ? { takenAt } : {}),
        } });
      }
      return tx.photo.findUniqueOrThrow({ where: { id }, include: PHOTO_INCLUDE });
    });
    const owner = await resolveFavoriteOwner(authContext);
    const data = (await toAuthorizedPhotoResponses(prisma, familyId, [photo], owner))[0];
    if (!data) throw new PhotoOwnershipError(404, 'Photo not found.');
    return NextResponse.json<ApiResponse<PhotoResponse>>({ success: true, data });
  } catch (error) { return photoErrorResponse(error, 'Failed to update photo'); }
}

/** Trash preserves links and their reserved capacity for recovery. */
async function handleDelete(req: NextRequest, authContext: AuthResult) {
  if (!(await isPhotosEnabled())) return photosDisabledResponse();
  const writeCheck = checkWritePermission(authContext);
  if (!writeCheck.allowed) return writeCheck.response!;
  try {
    const familyId = requirePhotoFamily(authContext.familyId);
    const id = extractId(req);
    await withPhotoIntegrity(prisma, familyId, async tx => {
      const existing = await tx.photo.findFirst({ where: { id, familyId } });
      if (!existing) throw new PhotoOwnershipError(404, 'Photo not found.');
      if (!existing.deletedAt) await tx.photo.update({ where: { id }, data: { deletedAt: new Date() } });
    });
    return NextResponse.json<ApiResponse<null>>({ success: true });
  } catch (error) { return photoErrorResponse(error, 'Failed to delete photo'); }
}

export const GET = withAuthContext(handleGet as any);
export const PATCH = withAuthContext(handlePatch as any);
export const DELETE = withAuthContext(handleDelete as any);
