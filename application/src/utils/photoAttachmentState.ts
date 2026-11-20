import type { PhotoLogCreate } from '@/app/api/types';

/** Hidden or trashed references reserve capacity but must not become visible photos. */
export function reservedPhotoSlots(retained: number | undefined, visible: number): number {
  return typeof retained === 'number' && Number.isFinite(retained)
    ? Math.max(0, Math.floor(retained) - visible) : 0;
}

export function availablePhotoSlots(maximum: number, visible: number, pending: number, reserved: number): number {
  return Math.max(0, maximum - visible - pending - Math.max(0, reserved));
}

/** A time/caption-only edit must not replace a read-filtered historical photo set. */
export function photoLogEditPayload(time: string, timeTouched: boolean, photoIds: string[], photosTouched: boolean): Partial<PhotoLogCreate> {
  return { ...(timeTouched && { time }), ...(photosTouched && { photoIds }) };
}

/** Omit unchanged metadata, including milestone tags hidden by the read projection. */
export function photoMetadataEditPayload(caption: string, initialCaption: string, milestoneId: string, initialMilestoneId: string) {
  const trimmed = caption.trim();
  return {
    ...(trimmed !== initialCaption.trim() && { caption: trimmed || null }),
    ...(milestoneId !== initialMilestoneId && { milestoneId: milestoneId || null }),
  };
}
