import type { Prisma } from '@prisma/client';
import type { PhotoAttachmentListResponse, PhotoResponse } from '../types';
import { MAX_PHOTOS_PER_ACTIVITY } from '@/src/utils/photoUtils';
import {
  PHOTO_INCLUDE, toPhotoResponse, type FavoriteOwner, type PhotoWithRelations,
} from './photo-service';
import {
  livePhotoWhere, photoTargetKey, requirePhotoTarget, resolveReadablePhotoTargets,
  type PhotoTargetRef,
} from './photo-ownership';
import { countRetainedAttachments } from './photo-link-service';

/** Read projection only: invalid historical relationships remain stored. */
export async function toAuthorizedPhotoResponses(
  db: Prisma.TransactionClient,
  familyId: string,
  photos: readonly PhotoWithRelations[],
  owner: FavoriteOwner | null,
): Promise<PhotoResponse[]> {
  const candidates = photos.filter(photo => photo.familyId === familyId);
  if (!candidates.length) return [];
  const babies = await db.baby.findMany({
    where: { id: { in: [...new Set(candidates.map(photo => photo.babyId))] }, familyId, deletedAt: null },
    select: { id: true },
  });
  const childIds = new Set(babies.map(baby => baby.id));
  const owned = candidates.filter(photo => childIds.has(photo.babyId));
  const refs: PhotoTargetRef[] = owned.flatMap(photo => [
    ...photo.links,
    ...(photo.milestoneId ? [{ activityType: 'milestone', activityId: photo.milestoneId }] : []),
  ]);
  const targets = await resolveReadablePhotoTargets(db, familyId, refs);
  return owned.map(photo => {
    const readable = (ref: PhotoTargetRef) => targets.get(photoTargetKey(ref))?.babyId === photo.babyId;
    const links = photo.links.filter(readable);
    const milestoneReadable = !!photo.milestoneId && readable({ activityType: 'milestone', activityId: photo.milestoneId });
    return {
      ...toPhotoResponse({
        ...photo,
        links,
        milestoneId: milestoneReadable ? photo.milestoneId : null,
        milestone: milestoneReadable ? photo.milestone : null,
      }, owner),
      unavailableLinkIds: photo.links.filter(link => !readable(link)).map(link => link.id),
      unavailableMilestone: !!photo.milestoneId && !milestoneReadable,
    };
  });
}

/** Load a target's attachments independently of the paginated family gallery. */
export async function readPhotoAttachments(
  db: Prisma.TransactionClient,
  familyId: string,
  ref: PhotoTargetRef,
  owner: FavoriteOwner | null,
): Promise<PhotoAttachmentListResponse> {
  const target = await requirePhotoTarget(db, familyId, ref);
  const [links, retainedLinkCount, milestonePhotos] = await Promise.all([
    db.photoLink.findMany({
      where: { activityType: ref.activityType, activityId: ref.activityId, photo: livePhotoWhere(familyId, target.babyId) },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { photo: { include: PHOTO_INCLUDE } },
    }),
    countRetainedAttachments(db, ref),
    ref.activityType === 'milestone' ? db.photo.findMany({
      where: { ...livePhotoWhere(familyId, target.babyId), milestoneId: ref.activityId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: PHOTO_INCLUDE,
    }) : [],
  ]);
  const photos = new Map(links.map(link => [link.photo.id, link.photo]));
  for (const photo of milestonePhotos) if (!photos.has(photo.id)) photos.set(photo.id, photo);
  return {
    photos: await toAuthorizedPhotoResponses(db, familyId, [...photos.values()], owner),
    retainedLinkCount,
    maxPhotos: MAX_PHOTOS_PER_ACTIVITY,
  };
}
