import type { Prisma } from '@prisma/client';
import { isPhotoActivityType, type PhotoTargetRef } from '../photos/photo-ownership';
import { countRetainedAttachments } from '../photos/photo-link-service';
import { PhotoIntegrityError, requirePhotoFamily } from './photo-integrity';

/** These guards run only inside the family-first integrity transaction. */
async function mutationTarget(tx: Prisma.TransactionClient, familyId: string, ref: PhotoTargetRef) {
  requirePhotoFamily(familyId);
  if (!isPhotoActivityType(ref.activityType)) throw new PhotoIntegrityError('Invalid activity type.', 400);
  const args = { where: { id: ref.activityId, familyId }, select: { id: true, babyId: true, deletedAt: true } };
  let row: { id: string; babyId: string; deletedAt: Date | null } | null;
  switch (ref.activityType) {
    case 'photo': row = await tx.photoLog.findFirst(args); break;
    case 'feed': row = await tx.feedLog.findFirst(args); break;
    case 'milestone': row = await tx.milestone.findFirst(args); break;
    case 'bath': row = await tx.bathLog.findFirst(args); break;
    case 'play': row = await tx.playLog.findFirst(args); break;
    case 'measurement': row = await tx.measurement.findFirst(args); break;
    case 'foodLog': row = await tx.foodLog.findFirst(args); break;
    case 'diaper': row = await tx.diaperLog.findFirst(args); break;
  }
  if (!row) throw new PhotoIntegrityError('Activity not found in this family.', 404, 'PHOTO_TARGET_MISSING');
  return row;
}

/** Conditional/indirect deletion has no authority to discard later attachments. */
export async function assertPhotoTargetUnlinked(tx: Prisma.TransactionClient, ref: PhotoTargetRef) {
  if (await countRetainedAttachments(tx, ref)) {
    throw new PhotoIntegrityError('Photos are attached to this entry. Review the entry and detach them before removing it.', 409, 'PHOTO_TARGET_ATTACHED');
  }
}

export async function assertPhotoTargetMove(
  tx: Prisma.TransactionClient, familyId: string, ref: PhotoTargetRef, nextBabyId: string | undefined,
) {
  const row = await mutationTarget(tx, familyId, ref);
  if (nextBabyId === undefined || nextBabyId === row.babyId) return row;
  if (typeof nextBabyId !== 'string' || !nextBabyId.trim()) {
    throw new PhotoIntegrityError('A valid baby ID is required.', 400, 'PHOTO_TARGET_INVALID');
  }
  if (row.deletedAt) throw new PhotoIntegrityError('This activity is no longer available.', 404, 'PHOTO_TARGET_MISSING');
  await assertPhotoTargetUnlinked(tx, ref);
  if (!await tx.baby.findFirst({ where: { id: nextBabyId, familyId, deletedAt: null }, select: { id: true } })) {
    throw new PhotoIntegrityError('Baby not found in this family.', 404, 'PHOTO_TARGET_MISSING');
  }
  return row;
}

/** An explicit care deletion detaches valid owned associations and keeps the
 * photos. A malformed historical association blocks the whole operation, so
 * deletion never becomes an implicit repair of hidden/foreign metadata. */
export async function detachPhotoTargetForDeletion(
  tx: Prisma.TransactionClient, familyId: string, ref: PhotoTargetRef,
) {
  const target = await mutationTarget(tx, familyId, ref);
  const links = await tx.photoLink.findMany({
    where: { activityType: ref.activityType, activityId: ref.activityId }, include: { photo: { select: { id: true, familyId: true, babyId: true } } },
  });
  const tagged = ref.activityType === 'milestone'
    ? await tx.photo.findMany({ where: { milestoneId: ref.activityId }, select: { id: true, familyId: true, babyId: true } })
    : [];
  const references = [...links.map(link => link.photo), ...tagged];
  const childOwned = !references.length || await tx.baby.findFirst({
    where: { id: target.babyId, familyId }, select: { id: true },
  });
  if (!childOwned || references.some(photo =>
    !photo || photo.familyId !== familyId || photo.babyId !== target.babyId)) {
    throw new PhotoIntegrityError('An attachment cannot be removed safely. Open its photo and explicitly detach it before deleting this entry.', 409, 'PHOTO_TARGET_REVIEW_REQUIRED');
  }
  if (links.length) await tx.photoLink.deleteMany({ where: { id: { in: links.map(link => link.id) } } });
  if (tagged.length) await tx.photo.updateMany({
    where: { id: { in: tagged.map(photo => photo.id) }, milestoneId: ref.activityId, familyId, babyId: target.babyId },
    data: { milestoneId: null },
  });
  return target;
}
