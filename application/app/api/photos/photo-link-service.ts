import type { Prisma } from '@prisma/client';
import { MAX_PHOTOS_PER_ACTIVITY } from '@/src/utils/photoUtils';
import { livePhotoWhere, PhotoOwnershipError, requirePhotoFamily, requirePhotoIdentifier, requirePhotoTarget, type PhotoTargetRef } from './photo-ownership';

/** Every mutation here requires the caller's family-first integrity transaction. */
async function retainedPhotoIds(db: Prisma.TransactionClient, ref: PhotoTargetRef): Promise<Set<string>> {
  const links = await db.photoLink.findMany({ where: { activityType: ref.activityType, activityId: ref.activityId }, select: { photoId: true } });
  const ids = new Set(links.map(link => link.photoId));
  if (ref.activityType === 'milestone') {
    const tagged = await db.photo.findMany({ where: { milestoneId: ref.activityId }, select: { id: true } });
    for (const photo of tagged) ids.add(photo.id);
  }
  return ids;
}

export async function countRetainedAttachments(db: Prisma.TransactionClient, ref: PhotoTargetRef): Promise<number> {
  return (await retainedPhotoIds(db, ref)).size;
}

function capacityError(): never {
  throw new PhotoOwnershipError(400, `A maximum of ${MAX_PHOTOS_PER_ACTIVITY} photos can be attached to an activity.`);
}

export async function attachPhotoToTarget(
  tx: Prisma.TransactionClient, familyId: string, input: PhotoTargetRef & { photoId: string },
) {
  requirePhotoIdentifier(input.photoId, 'Photo ID');
  const ref = { activityType: input.activityType, activityId: input.activityId };
  const target = await requirePhotoTarget(tx, familyId, ref);
  const photo = await tx.photo.findFirst({ where: { id: input.photoId, ...livePhotoWhere(familyId, target.babyId) }, select: { id: true } });
  if (!photo) throw new PhotoOwnershipError(404, 'Photo not found for this child in this family.');
  const where = { photoId: photo.id, ...ref };
  if (await tx.photoLink.findFirst({ where, select: { id: true } })) return ref;
  const retained = await retainedPhotoIds(tx, ref);
  // A legacy scalar-only milestone tag already reserves this photo's slot.
  if (!retained.has(photo.id) && retained.size >= MAX_PHOTOS_PER_ACTIVITY) capacityError();
  await tx.photoLink.create({ data: where });
  return ref;
}

export function validatePhotoIdList(value: unknown, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length)) throw new PhotoOwnershipError(400, 'At least one photo is required.');
  if (value.length > MAX_PHOTOS_PER_ACTIVITY) capacityError();
  const ids = value.map(id => requirePhotoIdentifier(id, 'Photo ID'));
  if (new Set(ids).size !== ids.length) throw new PhotoOwnershipError(400, 'Duplicate photos in request.');
  return ids;
}

/** Replace only the surfaced live set. Hidden/trashed references reserve slots. */
export async function replaceVisiblePhotoLinks(
  tx: Prisma.TransactionClient, familyId: string, ref: PhotoTargetRef, requestedIds: string[],
) {
  // PhotoLog's explicit set replacement is separate from milestone primary tags.
  if (ref.activityType !== 'photo') throw new PhotoOwnershipError(400, 'Only photo log attachment sets can be replaced.');
  const ids = validatePhotoIdList(requestedIds, true);
  const targetRef = { activityType: ref.activityType, activityId: ref.activityId };
  const target = await requirePhotoTarget(tx, familyId, targetRef);
  const photos = await tx.photo.findMany({ where: { id: { in: ids }, ...livePhotoWhere(familyId, target.babyId) }, select: { id: true } });
  if (photos.length !== ids.length) throw new PhotoOwnershipError(404, 'One or more photos were not found for this child in this family.');
  const existing = await tx.photoLink.findMany({ where: targetRef, include: { photo: { select: { familyId: true, babyId: true, deletedAt: true } } } });
  const requested = new Set(ids);
  const removed = existing.filter(link => link.photo.familyId === familyId && link.photo.babyId === target.babyId && link.photo.deletedAt === null && !requested.has(link.photoId));
  const kept = existing.filter(link => !removed.some(old => old.id === link.id));
  const finalIds = new Set([...kept.map(link => link.photoId), ...ids]);
  const added = ids.filter(id => !existing.some(link => link.photoId === id));
  if (added.length && finalIds.size > MAX_PHOTOS_PER_ACTIVITY) capacityError();
  if (removed.length) await tx.photoLink.deleteMany({ where: { id: { in: removed.map(link => link.id) } } });
  for (const photoId of added) await tx.photoLink.create({ data: { photoId, ...targetRef } });
}

export async function setPhotoMilestone(
  tx: Prisma.TransactionClient, familyId: string, photoId: string, milestoneId: string | null,
) {
  requirePhotoFamily(familyId); requirePhotoIdentifier(photoId, 'Photo ID');
  if (milestoneId !== null) requirePhotoIdentifier(milestoneId, 'Milestone ID');
  const photo = await tx.photo.findFirst({ where: { id: photoId, familyId } });
  if (!photo) throw new PhotoOwnershipError(404, 'Photo not found.');
  // Validate and reserve the new destination before releasing the old tag.
  // Existing manual edges and scalar-only reservations are successful no-ops.
  if (milestoneId !== null) await attachPhotoToTarget(tx, familyId, { photoId, activityType: 'milestone', activityId: milestoneId });
  if (photo.milestoneId && photo.milestoneId !== milestoneId) {
    await tx.photoLink.deleteMany({ where: { photoId, activityType: 'milestone', activityId: photo.milestoneId } });
  }
  if (photo.milestoneId !== milestoneId) await tx.photo.update({ where: { id: photoId }, data: { milestoneId } });
}

type DetachSelector = { photoId: string; linkId?: string; activityType?: string; activityId?: string };

/** The owned photo establishes authority even if a historical target is invalid. */
export async function detachPhotoLink(tx: Prisma.TransactionClient, familyId: string, input: DetachSelector) {
  requirePhotoFamily(familyId); requirePhotoIdentifier(input.photoId, 'Photo ID');
  const photo = await tx.photo.findFirst({ where: { id: input.photoId, familyId }, select: { id: true, milestoneId: true } });
  if (!photo) throw new PhotoOwnershipError(404, 'Photo not found.');
  let ref: PhotoTargetRef | undefined;
  if (input.linkId !== undefined) {
    requirePhotoIdentifier(input.linkId, 'Link ID');
    const link = await tx.photoLink.findFirst({ where: { id: input.linkId, photoId: photo.id }, select: { id: true, activityType: true, activityId: true } });
    if (link) {
      ref = link;
      await tx.photoLink.delete({ where: { id: link.id } });
    }
  } else {
    ref = { activityType: requirePhotoIdentifier(input.activityType, 'Activity type'), activityId: requirePhotoIdentifier(input.activityId, 'Activity ID') };
    await tx.photoLink.deleteMany({ where: { photoId: photo.id, ...ref } });
  }
  // An explicit exact triple also clears a legacy scalar-only milestone tag.
  if (ref?.activityType === 'milestone' && photo.milestoneId === ref.activityId) {
    await tx.photo.update({ where: { id: photo.id }, data: { milestoneId: null } });
  }
}
