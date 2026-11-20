import { NextRequest, NextResponse } from 'next/server';
import prisma from '../db';
import { ApiResponse, PhotoLogResponse } from '../types';
import { withAuthContext, AuthResult } from '../utils/auth';
import { formatForResponse } from '../utils/timezone';
import { checkWritePermission } from '../utils/writeProtection';
import { withPhotoIntegrity } from '../utils/photo-integrity';
import { detachPhotoTargetForDeletion } from '../utils/photo-target-mutations';
import { isPhotosEnabled, photosDisabledResponse, photoErrorResponse, requirePhotoTimestamp, resolveFavoriteOwner } from '../photos/photo-service';
import { PhotoOwnershipError, requirePhotoFamily, requirePhotoBaby, requirePhotoIdentifier, requirePhotoWriteObject, requirePhotoTarget } from '../photos/photo-ownership';
import { replaceVisiblePhotoLinks, validatePhotoIdList } from '../photos/photo-link-service';
import { readPhotoAttachments } from '../photos/photo-read';

async function toPhotoLogResponse(photoLog: { id: string; time: Date; babyId: string; caretakerId: string | null; familyId: string | null; createdAt: Date; updatedAt: Date; deletedAt: Date | null }, authContext: AuthResult): Promise<PhotoLogResponse> {
  const familyId = requirePhotoFamily(authContext.familyId);
  const owner = await resolveFavoriteOwner(authContext);
  const attachments = await readPhotoAttachments(prisma, familyId, { activityType: 'photo', activityId: photoLog.id }, owner);
  return {
    id: photoLog.id, time: formatForResponse(photoLog.time) || '', babyId: photoLog.babyId,
    caretakerId: photoLog.caretakerId, familyId: photoLog.familyId,
    createdAt: formatForResponse(photoLog.createdAt) || '', updatedAt: formatForResponse(photoLog.updatedAt) || '',
    deletedAt: formatForResponse(photoLog.deletedAt), photos: attachments.photos, retainedLinkCount: attachments.retainedLinkCount,
  };
}

async function handlePost(req: NextRequest, authContext: AuthResult) {
  if (!(await isPhotosEnabled())) return photosDisabledResponse();
  const writeCheck = checkWritePermission(authContext);
  if (!writeCheck.allowed) return writeCheck.response!;
  try {
    const familyId = requirePhotoFamily(authContext.familyId);
    const body = requirePhotoWriteObject(await req.json(), ['babyId', 'time', 'photoIds']);
    const babyId = requirePhotoIdentifier(body.babyId, 'Baby ID');
    const time = requirePhotoTimestamp(body.time, 'Time');
    const photoIds = validatePhotoIdList(body.photoIds);
    const photoLog = await withPhotoIntegrity(prisma, familyId, async tx => {
      await requirePhotoBaby(tx, familyId, babyId);
      const created = await tx.photoLog.create({ data: { babyId, time, caretakerId: authContext.caretakerId, familyId } });
      await replaceVisiblePhotoLinks(tx, familyId, { activityType: 'photo', activityId: created.id }, photoIds);
      return created;
    });
    return NextResponse.json<ApiResponse<PhotoLogResponse>>({ success: true, data: await toPhotoLogResponse(photoLog, authContext) });
  } catch (error) { return photoErrorResponse(error, 'Failed to create photo log'); }
}

async function handleGet(req: NextRequest, authContext: AuthResult) {
  if (!(await isPhotosEnabled())) return photosDisabledResponse();
  try {
    const familyId = requirePhotoFamily(authContext.familyId);
    const id = requirePhotoIdentifier(new URL(req.url).searchParams.get('id'), 'Photo log ID');
    const photoLog = await prisma.photoLog.findFirst({ where: { id, familyId, deletedAt: null } });
    if (!photoLog) throw new PhotoOwnershipError(404, 'Photo log not found.');
    return NextResponse.json<ApiResponse<PhotoLogResponse>>({ success: true, data: await toPhotoLogResponse(photoLog, authContext) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return photoErrorResponse(error, 'Failed to fetch photo log'); }
}

async function handlePut(req: NextRequest, authContext: AuthResult) {
  if (!(await isPhotosEnabled())) return photosDisabledResponse();
  const writeCheck = checkWritePermission(authContext);
  if (!writeCheck.allowed) return writeCheck.response!;
  try {
    const familyId = requirePhotoFamily(authContext.familyId);
    const id = requirePhotoIdentifier(new URL(req.url).searchParams.get('id'), 'Photo log ID');
    const body = requirePhotoWriteObject(await req.json(), ['babyId', 'time', 'photoIds']);
    const babyId = 'babyId' in body ? requirePhotoIdentifier(body.babyId, 'Baby ID') : undefined;
    const time = 'time' in body ? requirePhotoTimestamp(body.time, 'Time') : undefined;
    const photoIds = 'photoIds' in body ? validatePhotoIdList(body.photoIds, true) : undefined;
    const photoLog = await withPhotoIntegrity(prisma, familyId, async tx => {
      const target = await requirePhotoTarget(tx, familyId, { activityType: 'photo', activityId: id });
      // Existing clients echo the child ID; a PhotoLog replacement is not a move.
      if (babyId !== undefined && babyId !== target.babyId) throw new PhotoOwnershipError(400, 'The child for this photo log cannot be changed.');
      if (photoIds !== undefined) await replaceVisiblePhotoLinks(tx, familyId, target, photoIds);
      return time === undefined
        ? tx.photoLog.findUniqueOrThrow({ where: { id } })
        : tx.photoLog.update({ where: { id }, data: { time } });
    });
    return NextResponse.json<ApiResponse<PhotoLogResponse>>({ success: true, data: await toPhotoLogResponse(photoLog, authContext) });
  } catch (error) { return photoErrorResponse(error, 'Failed to update photo log'); }
}

async function handleDelete(req: NextRequest, authContext: AuthResult) {
  if (!(await isPhotosEnabled())) return photosDisabledResponse();
  const writeCheck = checkWritePermission(authContext);
  if (!writeCheck.allowed) return writeCheck.response!;
  try {
    const familyId = requirePhotoFamily(authContext.familyId);
    const id = requirePhotoIdentifier(new URL(req.url).searchParams.get('id'), 'Photo log ID');
    await withPhotoIntegrity(prisma, familyId, async tx => {
      const existing = await tx.photoLog.findFirst({ where: { id, familyId, deletedAt: null } });
      if (!existing) throw new PhotoOwnershipError(404, 'Photo log not found.');
      await detachPhotoTargetForDeletion(tx, familyId, { activityType: 'photo', activityId: id });
      await tx.photoLog.update({ where: { id }, data: { deletedAt: new Date() } });
    });
    return NextResponse.json<ApiResponse<null>>({ success: true });
  } catch (error) { return photoErrorResponse(error, 'Failed to delete photo log'); }
}

export const POST = withAuthContext(handlePost as any);
export const GET = withAuthContext(handleGet as any);
export const PUT = withAuthContext(handlePut as any);
export const DELETE = withAuthContext(handleDelete as any);
