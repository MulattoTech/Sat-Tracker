import type { Prisma } from '@prisma/client';

export const PHOTO_ACTIVITY_TYPES = ['photo', 'feed', 'milestone', 'bath', 'play', 'measurement', 'foodLog', 'diaper'] as const;
export type PhotoActivityType = typeof PHOTO_ACTIVITY_TYPES[number];
export type PhotoTargetRef = { activityType: string; activityId: string };
export type OwnedPhotoTarget = PhotoTargetRef & { familyId: string; babyId: string };

export class PhotoOwnershipError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function requirePhotoFamily(familyId: unknown): string {
  if (typeof familyId !== 'string' || !familyId.trim()) throw new PhotoOwnershipError(403, 'A family context is required.');
  return familyId;
}

export function requirePhotoIdentifier(value: unknown, label = 'Identifier'): string {
  if (typeof value !== 'string' || !value.trim()) throw new PhotoOwnershipError(400, `${label} must be a non-empty string.`);
  return value;
}

export function requirePhotoWriteObject(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PhotoOwnershipError(400, 'A JSON object is required.');
  if (Object.keys(value).some(key => !allowedKeys.includes(key))) throw new PhotoOwnershipError(400, 'Unsupported photo field.');
  return value as Record<string, unknown>;
}

export function isPhotoActivityType(value: unknown): value is PhotoActivityType {
  return typeof value === 'string' && (PHOTO_ACTIVITY_TYPES as readonly string[]).includes(value);
}

export function photoTargetKey(ref: PhotoTargetRef): string { return `${ref.activityType}:${ref.activityId}`; }

export function livePhotoWhere(familyId: string, babyId?: string): Prisma.PhotoWhereInput {
  return { familyId: requirePhotoFamily(familyId), deletedAt: null, baby: { familyId, deletedAt: null }, ...(babyId === undefined ? {} : { babyId }) };
}

export async function requirePhotoBaby(db: Prisma.TransactionClient, familyId: string, babyId: string) {
  requirePhotoFamily(familyId); requirePhotoIdentifier(babyId, 'Baby ID');
  const baby = await db.baby.findFirst({ where: { id: babyId, familyId, deletedAt: null }, select: { id: true } });
  if (!baby) throw new PhotoOwnershipError(404, 'Baby not found in this family.');
  return baby;
}

/** Batch by supported type; invalid historical references remain unprojected. */
export async function resolveReadablePhotoTargets(
  db: Prisma.TransactionClient, familyId: string, refs: readonly PhotoTargetRef[],
): Promise<Map<string, OwnedPhotoTarget>> {
  requirePhotoFamily(familyId);
  const result = new Map<string, OwnedPhotoTarget>();
  await Promise.all(PHOTO_ACTIVITY_TYPES.map(async activityType => {
    const ids = [...new Set(refs.filter(ref => ref.activityType === activityType && typeof ref.activityId === 'string' && ref.activityId.trim()).map(ref => ref.activityId))];
    if (!ids.length) return;
    const args = {
      where: { id: { in: ids }, familyId, deletedAt: null, baby: { familyId, deletedAt: null } },
      select: { id: true, babyId: true, familyId: true },
    } as const;
    let rows: { id: string; babyId: string; familyId: string | null }[];
    switch (activityType) {
      case 'photo': rows = await db.photoLog.findMany(args); break;
      case 'feed': rows = await db.feedLog.findMany(args); break;
      case 'milestone': rows = await db.milestone.findMany(args); break;
      case 'bath': rows = await db.bathLog.findMany(args); break;
      case 'play': rows = await db.playLog.findMany(args); break;
      case 'measurement': rows = await db.measurement.findMany(args); break;
      case 'foodLog': rows = await db.foodLog.findMany(args); break;
      case 'diaper': rows = await db.diaperLog.findMany(args); break;
    }
    for (const row of rows) {
      if (row.familyId === familyId) {
        const target = { activityType, activityId: row.id, familyId, babyId: row.babyId };
        result.set(photoTargetKey(target), target);
      }
    }
  }));
  return result;
}

export async function requirePhotoTarget(
  db: Prisma.TransactionClient, familyId: string, ref: PhotoTargetRef, expectedBabyId?: string,
): Promise<OwnedPhotoTarget> {
  requirePhotoFamily(familyId);
  if (!isPhotoActivityType(ref.activityType)) throw new PhotoOwnershipError(400, 'Invalid activity type.');
  requirePhotoIdentifier(ref.activityId, 'Activity ID');
  const target = (await resolveReadablePhotoTargets(db, familyId, [ref])).get(photoTargetKey(ref));
  if (!target || (expectedBabyId !== undefined && target.babyId !== expectedBabyId)) {
    throw new PhotoOwnershipError(404, 'Activity not found for this child in this family.');
  }
  return target;
}
