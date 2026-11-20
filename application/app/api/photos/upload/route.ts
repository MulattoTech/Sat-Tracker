import { NextRequest, NextResponse } from 'next/server';
import prisma from '../../db';
import { ApiResponse, PhotoUploadResult, PhotoResponse } from '../../types';
import { withAuthContext, AuthResult } from '../../utils/auth';
import { checkWritePermission } from '../../utils/writeProtection';
import { PhotoIntegrityError, withPhotoIntegrity } from '../../utils/photo-integrity';
import { encryptAndStore, generateStoredName, deleteEncryptedFile } from '@/src/lib/file-encryption';
import { processPhoto } from '../photo-processing';
import { isPhotosEnabled, photosDisabledResponse, photoSubdir, getQuotaInfo, purgeExpiredPhotos, photoErrorResponse, requirePhotoTimestamp, resolveFavoriteOwner, PHOTO_INCLUDE } from '../photo-service';
import { PhotoOwnershipError, requirePhotoFamily, requirePhotoIdentifier, requirePhotoBaby, requirePhotoTarget } from '../photo-ownership';
import { setPhotoMilestone } from '../photo-link-service';
import { toAuthorizedPhotoResponses } from '../photo-read';
import { validatePhotoFile, isHeifContainer, isOverQuota, resolveTakenAt, MAX_PHOTOS_PER_BATCH, HEIF_CONTAINER_ERROR } from '@/src/utils/photoUtils';

function formText(form: FormData, key: string): string | null {
  const value = form.get(key);
  if (value !== null && typeof value !== 'string') throw new PhotoOwnershipError(400, key + ' must be text.');
  return value;
}

/** Files are processed outside retryable transactions; each row/tag/edge commits together. */
async function handlePost(req: NextRequest, authContext: AuthResult) {
  if (!(await isPhotosEnabled())) return photosDisabledResponse();
  const writeCheck = checkWritePermission(authContext);
  if (!writeCheck.allowed) return writeCheck.response!;
  try {
    const familyId = requirePhotoFamily(authContext.familyId);
    const formData = await req.formData();
    const entries = formData.getAll('files');
    if (!entries.length || entries.some(file => !(file instanceof File))) throw new PhotoOwnershipError(400, 'At least one image file is required.');
    const files = entries as File[];
    if (files.length > MAX_PHOTOS_PER_BATCH) throw new PhotoOwnershipError(400, 'A maximum of ' + MAX_PHOTOS_PER_BATCH + ' photos can be uploaded at once.');
    const babyId = requirePhotoIdentifier(formText(formData, 'babyId'), 'Baby ID');
    const takenAtRaw = formText(formData, 'takenAt');
    const explicitTakenAt = takenAtRaw ? requirePhotoTimestamp(takenAtRaw, 'Taken at') : null;
    const caption = formText(formData, 'caption')?.trim() || null;
    const milestoneId = formText(formData, 'milestoneId')?.trim() || null;

    // Fast preflight, repeated authoritatively inside the family lock below.
    await requirePhotoBaby(prisma, familyId, babyId);
    if (milestoneId) await requirePhotoTarget(prisma, familyId, { activityType: 'milestone', activityId: milestoneId }, babyId);
    await purgeExpiredPhotos(familyId);
    const quota = await getQuotaInfo(familyId);
    let runningUsed = quota.usedBytes;
    const photos: PhotoResponse[] = [];
    const errors: { fileName: string; error: string; index: number }[] = [];
    const favoriteOwner = await resolveFavoriteOwner(authContext);

    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const validation = validatePhotoFile({ mimeType: file.type, fileSize: file.size });
      if (!validation.valid) { errors.push({ fileName: file.name, error: validation.error!, index }); continue; }
      let storedName: string | undefined, thumbStoredName: string | undefined;
      let safeToRemoveFiles = true;
      try {
        const rawBuffer = Buffer.from(await file.arrayBuffer());
        if (isHeifContainer(rawBuffer)) { errors.push({ fileName: file.name, error: HEIF_CONTAINER_ERROR, index }); continue; }
        const processed = await processPhoto(rawBuffer, file.type.toLowerCase());
        const incomingBytes = processed.display.data.length + processed.thumbnail.data.length;
        if (isOverQuota(runningUsed, incomingBytes, quota.totalBytes)) { errors.push({ fileName: file.name, error: 'Photo storage quota exceeded', index }); continue; }
        storedName = generateStoredName(); thumbStoredName = generateStoredName();
        encryptAndStore(processed.display.data, storedName, photoSubdir(familyId));
        encryptAndStore(processed.thumbnail.data, thumbStoredName, photoSubdir(familyId));
        const takenAt = explicitTakenAt ?? resolveTakenAt(null, processed.exifTakenAt, new Date());

        // Unknown commit outcomes retain bytes. Only a callback that threw before
        // commit, or a failure before starting DB work, can safely remove them.
        const photo = await withPhotoIntegrity(prisma, familyId, async tx => {
          safeToRemoveFiles = false;
          try {
            await requirePhotoBaby(tx, familyId, babyId);
            const created = await tx.photo.create({ data: {
              originalName: file.name, storedName: storedName!, thumbStoredName: thumbStoredName!,
              mimeType: processed.display.mimeType, fileSize: processed.display.data.length,
              thumbSize: processed.thumbnail.data.length, takenAt, caption, babyId,
              caretakerId: authContext.caretakerId, milestoneId: null, familyId,
            } });
            if (milestoneId) await setPhotoMilestone(tx, familyId, created.id, milestoneId);
            return await tx.photo.findUniqueOrThrow({ where: { id: created.id }, include: PHOTO_INCLUDE });
          } catch (error) { safeToRemoveFiles = true; throw error; }
        });
        safeToRemoveFiles = false;
        runningUsed += incomingBytes;
        photos.push(...await toAuthorizedPhotoResponses(prisma, familyId, [photo], favoriteOwner));
      } catch (error) {
        console.error('Error processing photo upload:', error);
        if (safeToRemoveFiles) {
          for (const name of [storedName, thumbStoredName]) {
            if (!name) continue;
            try { deleteEncryptedFile(name, photoSubdir(familyId)); }
            catch (cleanupError) { console.error('Failed to clean up orphaned photo file:', cleanupError); }
          }
        } else if (storedName || thumbStoredName) {
          console.error('Retained encrypted photo bytes after an uncertain transaction or response outcome; reconciliation is required.');
        }
        errors.push({ fileName: file.name, error: error instanceof PhotoOwnershipError || error instanceof PhotoIntegrityError ? error.message : 'Failed to process photo', index });
      }
    }
    return NextResponse.json<ApiResponse<PhotoUploadResult>>({ success: true, data: { photos, errors, quota: await getQuotaInfo(familyId) } });
  } catch (error) { return photoErrorResponse(error, 'Failed to upload photos'); }
}

export const POST = withAuthContext(handlePost as any);
