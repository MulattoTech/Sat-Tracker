import { NextResponse } from 'next/server';
import prisma from '../db';
import { ApiResponse, PhotoResponse } from '../types';
import { deleteEncryptedFile } from '@/src/lib/file-encryption';
import { getEffectiveQuotaMb, mbToBytes, isPurgeEligible, TRASH_RETENTION_DAYS } from '@/src/utils/photoUtils';
import { formatForResponse, toUTC } from '../utils/timezone';
import { AuthResult } from '../utils/auth';
import type { Prisma } from '@prisma/client';
import { PhotoIntegrityError, withPhotoIntegrity } from '../utils/photo-integrity';
import { PhotoOwnershipError, requirePhotoFamily } from './photo-ownership';

export function photoSubdir(familyId: string): string {
  return `photos/${familyId}`;
}

export async function isPhotosEnabled(): Promise<boolean> {
  const config = await prisma.appConfig.findFirst({ select: { enablePhotos: true } });
  return config?.enablePhotos ?? false;
}

export function photosDisabledResponse(): NextResponse {
  return NextResponse.json<ApiResponse<null>>(
    { success: false, error: 'Photos feature is not enabled' },
    { status: 403 }
  );
}

export function photoErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof PhotoIntegrityError) return error.response();
  if (error instanceof PhotoOwnershipError) return NextResponse.json<ApiResponse<null>>({ success: false, error: error.message }, { status: error.status });
  if (error instanceof SyntaxError) return NextResponse.json<ApiResponse<null>>({ success: false, error: 'Invalid JSON request.' }, { status: 400 });
  console.error(fallback, error);
  return NextResponse.json<ApiResponse<null>>({ success: false, error: fallback }, { status: 500 });
}

export function requirePhotoTimestamp(value: unknown, label: string): Date {
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) {
    throw new PhotoOwnershipError(400, `${label} must be a valid timestamp.`);
  }
  const date = toUTC(value);
  if (!Number.isFinite(date.getTime())) throw new PhotoOwnershipError(400, `${label} must be a valid timestamp.`);
  return date;
}

/**
 * Family quota usage. Trashed photos still occupy disk, so they count
 * toward usage until purged (spec section 4).
 */
export async function getQuotaInfo(familyId: string): Promise<{ usedBytes: number; totalBytes: number }> {
  requirePhotoFamily(familyId);
  const [aggregate, settings, appConfig] = await Promise.all([
    prisma.photo.aggregate({
      where: { familyId },
      _sum: { fileSize: true, thumbSize: true },
    }),
    prisma.settings.findFirst({ where: { familyId }, select: { photoQuotaMB: true } }),
    prisma.appConfig.findFirst({ select: { defaultPhotoQuotaMB: true } }),
  ]);
  const usedBytes = (aggregate._sum.fileSize || 0) + (aggregate._sum.thumbSize || 0);
  const quotaMb = getEffectiveQuotaMb(settings?.photoQuotaMB, appConfig?.defaultPhotoQuotaMB ?? 5120);
  return { usedBytes, totalBytes: mbToBytes(quotaMb) };
}

/**
 * Commit eligible trashed rows first, then delete only their files outside the
 * retried transaction. A concurrent restore cannot revive a row whose files
 * were already removed. Failed file cleanup leaves an orphan, never a live row
 * without bytes; existing cleanup logging is retained.
 */
export async function purgePhotosPermanently(photoIds: string[], familyId: string, deletedBefore?: Date): Promise<number> {
  requirePhotoFamily(familyId);
  if (photoIds.length === 0) return 0;
  const photos = await withPhotoIntegrity(prisma, familyId, async tx => {
    const eligible = await tx.photo.findMany({
      where: { id: { in: photoIds }, familyId, deletedAt: { not: null, ...(deletedBefore ? { lt: deletedBefore } : {}) } },
      select: { id: true, storedName: true, thumbStoredName: true },
    });
    await tx.photo.deleteMany({ where: { id: { in: eligible.map(photo => photo.id) }, familyId } });
    return eligible;
  });
  for (const photo of photos) {
    for (const name of [photo.storedName, photo.thumbStoredName]) {
      try { deleteEncryptedFile(name, photoSubdir(familyId)); }
      catch (error) { console.error(`Failed to delete orphaned photo file for ${photo.id}:`, error); }
    }
  }
  return photos.length;
}

/**
 * Lazy trash purge: called from photo list/upload routes. Removes photos
 * whose deletedAt is older than TRASH_RETENTION_DAYS.
 */
export async function purgeExpiredPhotos(familyId: string): Promise<number> {
  requirePhotoFamily(familyId);
  const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const expired = await prisma.photo.findMany({
    where: { familyId, deletedAt: { not: null, lt: cutoff } },
    select: { id: true, deletedAt: true },
  });
  const eligibleIds = expired.filter((p) => isPurgeEligible(p.deletedAt, new Date())).map((p) => p.id);
  return purgePhotosPermanently(eligibleIds, familyId, cutoff);
}

/** Standard Prisma include for building a PhotoResponse. */
export const PHOTO_INCLUDE = {
  links: { select: { id: true, activityType: true, activityId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  favorites: true,
  milestone: { select: { title: true } },
} satisfies Prisma.PhotoInclude;

export type PhotoWithRelations = {
  id: string; originalName: string; mimeType: string; fileSize: number; thumbSize: number;
  takenAt: Date; caption: string | null; babyId: string; caretakerId: string | null;
  familyId: string | null; milestoneId: string | null; createdAt: Date; updatedAt: Date; deletedAt: Date | null;
  links: { id: string; activityType: string; activityId: string }[];
  favorites: { caretakerId: string | null; accountId: string | null }[];
  milestone: { title: string } | null;
};

export type FavoriteOwner = { caretakerId: string } | { accountId: string };

/**
 * The identity a favorite is keyed to. Caretaker identity wins when present
 * so PIN logins and account logins of the same person share favorites;
 * accounts with no linked caretaker fall back to accountId.
 * Used by BOTH favorite reads (toPhotoResponse) and writes (favorite route)
 * so the two can never diverge.
 *
 * A sysadmin browsing a family via "Login to family" has neither identity —
 * auth.ts nulls caretakerId for sysadmin tokens — so its favorites are keyed to
 * the family's system caretaker ('00') and are therefore shared with anyone
 * signed in with the family PIN (#216). Pure: the caller supplies the looked-up
 * id, or resolveFavoriteOwner does it for them.
 */
export function favoriteOwnerFilter(
  authContext: AuthResult,
  systemCaretakerId?: string | null
): FavoriteOwner | null {
  if (authContext.caretakerId) return { caretakerId: authContext.caretakerId };
  if (authContext.accountId) return { accountId: authContext.accountId };
  if (authContext.isSysAdmin && systemCaretakerId) return { caretakerId: systemCaretakerId };
  return null;
}

/**
 * favoriteOwnerFilter plus the system-caretaker lookup a sysadmin needs. Costs one
 * extra query on the sysadmin path only; every other caller short-circuits.
 * Returns null when the family has no system caretaker to attribute to — the
 * favorite route turns that into a 400 rather than inventing a caretaker row.
 */
export async function resolveFavoriteOwner(authContext: AuthResult): Promise<FavoriteOwner | null> {
  const direct = favoriteOwnerFilter(authContext);
  if (direct || !authContext.isSysAdmin || !authContext.familyId) return direct;

  // Not filtered on `inactive`: the system caretaker is deactivated once a family
  // configures real caretakers, but it remains a valid thing to attribute to.
  const systemCaretaker = await prisma.caretaker.findFirst({
    where: { loginId: '00', familyId: authContext.familyId, deletedAt: null },
    select: { id: true },
  });
  return favoriteOwnerFilter(authContext, systemCaretaker?.id);
}

export function toPhotoResponse(photo: PhotoWithRelations, owner: FavoriteOwner | null): PhotoResponse {
  const isFavorite = !!owner && photo.favorites.some((fav) =>
    'caretakerId' in owner ? fav.caretakerId === owner.caretakerId : fav.accountId === owner.accountId
  );
  return {
    id: photo.id,
    originalName: photo.originalName,
    mimeType: photo.mimeType,
    fileSize: photo.fileSize,
    thumbSize: photo.thumbSize,
    takenAt: formatForResponse(photo.takenAt) || '',
    caption: photo.caption,
    babyId: photo.babyId,
    caretakerId: photo.caretakerId,
    milestoneId: photo.milestoneId,
    milestoneTitle: photo.milestone?.title ?? null,
    isFavorite,
    links: photo.links.map(({ activityType, activityId }) => ({ activityType, activityId })),
    createdAt: formatForResponse(photo.createdAt) || '',
    updatedAt: formatForResponse(photo.updatedAt) || '',
    deletedAt: formatForResponse(photo.deletedAt),
  };
}
