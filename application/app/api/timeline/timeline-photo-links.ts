import { TimelinePhotoInfo } from '../types';
import { photoTargetKey, type OwnedPhotoTarget } from '../photos/photo-ownership';

export interface PhotoLinkTarget {
  activityType: string;
  ids: string[];
}

export interface PhotoLinkRow {
  activityType: string;
  activityId: string;
  photo: { id: string; caption: string | null };
}

export interface ScopedPhotoLinkRow extends PhotoLinkRow {
  photo: PhotoLinkRow['photo'] & { familyId: string | null; babyId: string; deletedAt: Date | null };
}

/** A malformed stored edge never borrows its target's read authorization. */
export function filterReadablePhotoLinks(
  rows: ScopedPhotoLinkRow[], targets: Map<string, OwnedPhotoTarget>, familyId: string, babyId: string,
): PhotoLinkRow[] {
  return rows.filter(row => {
    const target = targets.get(photoTargetKey(row));
    return target?.familyId === familyId && target.babyId === babyId
      && row.photo.familyId === familyId && row.photo.babyId === babyId && row.photo.deletedAt === null;
  });
}

/**
 * Build the (activityType, ids) pairs used to batch-load photo attachments
 * for a page of timeline activities. Types with no ids are dropped so the
 * downstream PhotoLink query's OR clause only includes types that matter.
 */
export function buildLinkTargets(idsByType: Record<string, string[]>): PhotoLinkTarget[] {
  return Object.entries(idsByType)
    .map(([activityType, ids]) => ({ activityType, ids }))
    .filter((target) => target.ids.length > 0);
}

/**
 * Group PhotoLink rows (as returned by the batched query) into a Map keyed
 * `${activityType}:${activityId}`, preserving the order rows arrived in.
 * If the same row appears twice (e.g. a duplicate link), it produces a
 * duplicate entry in the group — this function does not dedupe.
 */
export function groupPhotoLinks(rows: PhotoLinkRow[]): Map<string, TimelinePhotoInfo[]> {
  const photosByActivity = new Map<string, TimelinePhotoInfo[]>();
  for (const row of rows) {
    const key = `${row.activityType}:${row.activityId}`;
    if (!photosByActivity.has(key)) photosByActivity.set(key, []);
    photosByActivity.get(key)!.push({ id: row.photo.id, caption: row.photo.caption });
  }
  return photosByActivity;
}

/**
 * Whether a photo-log entry still has at least one live linked photo. The
 * batched PhotoLink query already excludes trashed photos, and purged photos
 * cascade-delete their links, so a log whose every photo is soft- or
 * hard-deleted simply has no entry in the map — such logs have nothing to
 * show and should be hidden from the timeline.
 */
export function photoLogHasLivePhotos(photosByActivity: Map<string, TimelinePhotoInfo[]>, photoLogId: string): boolean {
  return (photosByActivity.get(`photo:${photoLogId}`) || []).length > 0;
}
