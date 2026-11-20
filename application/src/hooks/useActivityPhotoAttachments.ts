'use client';

import { useEffect, useState } from 'react';
import { fetchPhotoAttachments } from '@/src/utils/photoClientApi';
import { reservedPhotoSlots } from '@/src/utils/photoAttachmentState';
import type { AttachedPhotoInfo } from '@/src/components/ui/photo-attachments/photo-attachments.types';

/** A cancelled target request must never repopulate a subsequently opened record. */
export function useActivityPhotoAttachments({ activityType, activityId, babyId, isOpen, enabled }: {
  activityType: string;
  activityId?: string;
  babyId?: string;
  isOpen: boolean;
  enabled: boolean;
}) {
  const requestKey = isOpen && enabled && activityId ? `${babyId || ''}:${activityType}:${activityId}` : null;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [photos, setPhotos] = useState<AttachedPhotoInfo[]>([]);
  const [reservedSlots, setReservedSlots] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setPhotos([]);
    setReservedSlots(0);
    setError(false);
    setLoadedKey(requestKey);
    setLoading(!!requestKey);
    if (requestKey && activityId) {
      fetchPhotoAttachments(activityType, activityId)
        .then(data => {
          if (cancelled) return;
          if (babyId && data.photos.some(photo => photo.babyId !== babyId)) throw new Error('Photo attachments do not match this child');
          setPhotos(data.photos.map(photo => ({ id: photo.id, caption: photo.caption })));
          setReservedSlots(reservedPhotoSlots(data.retainedLinkCount, data.photos.length));
        })
        .catch(() => { if (!cancelled) setError(true); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }
    return () => { cancelled = true; };
  }, [requestKey, activityType, activityId, babyId, revision]);
  const current = loadedKey === requestKey;
  return {
    photos: current ? photos : [], setPhotos,
    reservedSlots: current ? reservedSlots : 0,
    loading: !!requestKey && (!current || loading),
    error: current && error,
    reload: () => setRevision(value => value + 1),
  };
}
