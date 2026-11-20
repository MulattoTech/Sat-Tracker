import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../../db';
import { ApiResponse } from '../../../types';
import { withAuthContext, AuthResult } from '../../../utils/auth';
import { checkWritePermission } from '../../../utils/writeProtection';
import { withPhotoIntegrity } from '../../../utils/photo-integrity';
import { isPhotosEnabled, photosDisabledResponse, photoErrorResponse } from '../../photo-service';
import { PhotoOwnershipError, requirePhotoFamily, requirePhotoIdentifier } from '../../photo-ownership';

/** Restore retains the original reservations; invalid historical links stay hidden. */
async function handlePost(req: NextRequest, authContext: AuthResult) {
  if (!(await isPhotosEnabled())) return photosDisabledResponse();
  const writeCheck = checkWritePermission(authContext);
  if (!writeCheck.allowed) return writeCheck.response!;
  try {
    const familyId = requirePhotoFamily(authContext.familyId);
    const id = requirePhotoIdentifier(new URL(req.url).pathname.split('/').at(-2), 'Photo ID');
    await withPhotoIntegrity(prisma, familyId, async tx => {
      const existing = await tx.photo.findFirst({ where: { id, familyId } });
      if (!existing) throw new PhotoOwnershipError(404, 'Photo not found.');
      if (existing.deletedAt) await tx.photo.update({ where: { id }, data: { deletedAt: null } });
    });
    return NextResponse.json<ApiResponse<null>>({ success: true });
  } catch (error) { return photoErrorResponse(error, 'Failed to restore photo'); }
}

export const POST = withAuthContext(handlePost as any);
