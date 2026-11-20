import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../db';
import { ApiResponse, PhotoLinkInfo } from '../../types';
import { withAuthContext, AuthResult } from '../../utils/auth';
import { checkWritePermission } from '../../utils/writeProtection';
import { withPhotoIntegrity } from '../../utils/photo-integrity';
import { isPhotosEnabled, photosDisabledResponse, photoErrorResponse } from '../photo-service';
import { attachPhotoToTarget, detachPhotoLink } from '../photo-link-service';
import { PhotoOwnershipError, requirePhotoFamily, requirePhotoIdentifier, requirePhotoWriteObject } from '../photo-ownership';

/** POST /api/photos/links — attach to an owned, live entry for the same child. */
async function handlePost(req: NextRequest, authContext: AuthResult) {
  if (!(await isPhotosEnabled())) return photosDisabledResponse();
  const writeCheck = checkWritePermission(authContext);
  if (!writeCheck.allowed) return writeCheck.response!;
  try {
    const familyId = requirePhotoFamily(authContext.familyId);
    const body = requirePhotoWriteObject(await req.json(), ['photoId', 'activityType', 'activityId']);
    const input = {
      photoId: requirePhotoIdentifier(body.photoId, 'Photo ID'),
      activityType: requirePhotoIdentifier(body.activityType, 'Activity type'),
      activityId: requirePhotoIdentifier(body.activityId, 'Activity ID'),
    };
    const data = await withPhotoIntegrity(prisma, familyId, tx => attachPhotoToTarget(tx, familyId, input));
    return NextResponse.json<ApiResponse<PhotoLinkInfo>>({ success: true, data });
  } catch (error) { return photoErrorResponse(error, 'Failed to attach photo'); }
}

/** Explicit owned-photo cleanup: opaque link ID or the compatible exact triple. */
async function handleDelete(req: NextRequest, authContext: AuthResult) {
  if (!(await isPhotosEnabled())) return photosDisabledResponse();
  const writeCheck = checkWritePermission(authContext);
  if (!writeCheck.allowed) return writeCheck.response!;
  try {
    const familyId = requirePhotoFamily(authContext.familyId);
    const { searchParams } = new URL(req.url);
    const photoId = requirePhotoIdentifier(searchParams.get('photoId'), 'Photo ID');
    const linkId = searchParams.get('linkId');
    const activityType = searchParams.get('activityType');
    const activityId = searchParams.get('activityId');
    if (linkId !== null && (activityType !== null || activityId !== null)) throw new PhotoOwnershipError(400, 'Choose a link ID or an exact activity reference.');
    const selector = linkId !== null
      ? { photoId, linkId: requirePhotoIdentifier(linkId, 'Link ID') }
      : { photoId, activityType: requirePhotoIdentifier(activityType, 'Activity type'), activityId: requirePhotoIdentifier(activityId, 'Activity ID') };
    await withPhotoIntegrity(prisma, familyId, tx => detachPhotoLink(tx, familyId, selector));
    return NextResponse.json<ApiResponse<null>>({ success: true });
  } catch (error) { return photoErrorResponse(error, 'Failed to detach photo'); }
}

export const POST = withAuthContext(handlePost as any);
export const DELETE = withAuthContext(handleDelete as any);
