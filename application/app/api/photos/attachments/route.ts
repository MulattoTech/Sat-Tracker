import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../db';
import { withAuthContext, type AuthResult } from '../../utils/auth';
import { isPhotosEnabled, photosDisabledResponse, resolveFavoriteOwner } from '../photo-service';
import { PhotoOwnershipError } from '../photo-ownership';
import { readPhotoAttachments } from '../photo-read';

async function handleGet(req: NextRequest, auth: AuthResult) {
  if (!(await isPhotosEnabled())) return photosDisabledResponse();
  const params = new URL(req.url).searchParams;
  const activityType = params.get('activityType');
  const activityId = params.get('activityId');
  if (!activityType || !activityId) {
    return NextResponse.json({ success: false, error: 'activityType and activityId are required' }, { status: 400 });
  }
  if (!auth.familyId) return NextResponse.json({ success: false, error: 'Activity not found' }, { status: 404 });
  try {
    const owner = await resolveFavoriteOwner(auth);
    const data = await readPhotoAttachments(prisma, auth.familyId, { activityType, activityId }, owner);
    return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof PhotoOwnershipError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error('Error loading photo attachments:', error);
    return NextResponse.json({ success: false, error: 'Failed to load photos' }, { status: 500 });
  }
}

export const GET = withAuthContext(handleGet as any);
