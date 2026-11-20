'use client';

import { useEffect, useRef, useState } from 'react';
import type { PhotoResponse } from '@/app/api/types';
import { Button } from '@/src/components/ui/button';
import { useLocalization } from '@/src/context/localization';
import { fetchPhoto, unlinkUnavailablePhotoLink, updatePhoto } from '@/src/utils/photoClientApi';

/** Explicit repair of owned link handles; no unavailable target identity is shown. */
export default function UnavailablePhotoLinks({ photo, onChanged, onPhotoUpdated }: {
  photo: PhotoResponse; onChanged?: () => void; onPhotoUpdated?: (photo: PhotoResponse) => void;
}) {
  const { t } = useLocalization();
  const [linkIds, setLinkIds] = useState(photo.unavailableLinkIds || []);
  const [milestone, setMilestone] = useState(!!photo.unavailableMilestone);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const linkKey = (photo.unavailableLinkIds || []).join('|');
  useEffect(() => {
    generation.current += 1;
    setLinkIds(photo.unavailableLinkIds || []);
    setMilestone(!!photo.unavailableMilestone);
    setPending(false);
    setError(false);
    return () => { generation.current += 1; };
  }, [photo.id, linkKey, photo.unavailableMilestone]);

  const remove = async (linkId?: string) => {
    const requestGeneration = generation.current;
    setPending(true);
    setError(false);
    try {
      if (linkId) await unlinkUnavailablePhotoLink(photo.id, linkId);
      else await updatePhoto(photo.id, { milestoneId: null });
      const refreshed = await fetchPhoto(photo.id);
      if (refreshed.id !== photo.id) throw new Error('Photo response does not match the requested photo');
      // The paginated gallery may safely refresh this ID even after navigation.
      onPhotoUpdated?.(refreshed);
      if (generation.current !== requestGeneration) return;
      setLinkIds(refreshed.unavailableLinkIds || []);
      setMilestone(!!refreshed.unavailableMilestone);
      onChanged?.();
    } catch {
      if (generation.current === requestGeneration) setError(true);
    } finally {
      if (generation.current === requestGeneration) setPending(false);
    }
  };

  if (!linkIds.length && !milestone && !error) return null;
  return <section className="space-y-2" aria-label={t('Unavailable attachments')}>
    <p className="photo-detail-hint photo-gallery-lightbox-row-label text-sm text-gray-500">{t('Removing an unavailable link keeps the photo and care record.')}</p>
    {linkIds.map((id, index) => <Button key={id} type="button" variant="outline"
      className="h-auto min-h-11 whitespace-normal" disabled={pending}
      aria-label={`${t('Remove unavailable link')} ${index + 1}`}
      data-testid="remove-unavailable-photo-link" onClick={() => remove(id)}>
      {t('Remove unavailable link')}
    </Button>)}
    {milestone && <Button type="button" variant="outline" className="h-auto min-h-11 whitespace-normal"
      disabled={pending} onClick={() => remove()}>{t('Remove unavailable milestone')}</Button>}
    {error && <p className="photo-detail-error text-sm text-red-500" role="alert">{t('Failed to update photo details')}</p>}
  </section>;
}
