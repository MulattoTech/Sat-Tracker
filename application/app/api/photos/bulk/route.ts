import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../db';
import { ApiResponse } from '../../types';
import { withAuthContext, AuthResult } from '../../utils/auth';
import { checkWritePermission } from '../../utils/writeProtection';
import { withPhotoIntegrity } from '../../utils/photo-integrity';
import { isPhotosEnabled, photosDisabledResponse, purgePhotosPermanently, photoErrorResponse } from '../photo-service';
import { PhotoOwnershipError, requirePhotoFamily, requirePhotoIdentifier, requirePhotoWriteObject } from '../photo-ownership';

/** Gallery trash/restore preserve link reservations; purge explicitly removes them. */
async function handlePost(req: NextRequest, authContext: AuthResult) {
  if (!(await isPhotosEnabled())) return photosDisabledResponse();
  const writeCheck = checkWritePermission(authContext);
  if (!writeCheck.allowed) return writeCheck.response!;
  try {
    const familyId = requirePhotoFamily(authContext.familyId);
    const body = requirePhotoWriteObject(await req.json(), ['action', 'ids']);
    if (!Array.isArray(body.ids) || !body.ids.length) throw new PhotoOwnershipError(400, 'Photo IDs are required.');
    const ids = [...new Set(body.ids.map(id => requirePhotoIdentifier(id, 'Photo ID')))];
    if (!['trash', 'restore', 'purge'].includes(body.action as string)) throw new PhotoOwnershipError(400, 'Invalid bulk action.');
    const count = body.action === 'purge'
      ? await purgePhotosPermanently(ids, familyId)
      : await withPhotoIntegrity(prisma, familyId, async tx => {
        const trash = body.action === 'trash';
        const result = await tx.photo.updateMany({
          where: { id: { in: ids }, familyId, deletedAt: trash ? null : { not: null } },
          data: { deletedAt: trash ? new Date() : null },
        });
        return result.count;
      });
    return NextResponse.json<ApiResponse<{ count: number }>>({ success: true, data: { count } });
  } catch (error) { return photoErrorResponse(error, 'Failed to perform bulk action'); }
}

export const POST = withAuthContext(handlePost as any);
