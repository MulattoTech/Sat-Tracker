import { describe, expect, it } from 'vitest';
import { availablePhotoSlots, photoLogEditPayload, photoMetadataEditPayload, reservedPhotoSlots } from '@/src/utils/photoAttachmentState';

describe('visible photo editing preserves hidden historical relationships', () => {
  it('does not convert a filtered read into a replacement or an unrelated milestone clear', () => {
    expect(photoLogEditPayload('2026-11-20T12:30:00.123Z', false, ['visible-photo'], false)).toEqual({});
    expect(photoMetadataEditPayload('Updated caption', 'Original caption', '', '')).toEqual({ caption: 'Updated caption' });
  });

  it('carries an intentional time correction without rewriting photo membership', () => {
    const time = '2026-11-20T12:30:00.123Z';
    expect(photoLogEditPayload(time, true, ['visible-photo'], false)).toEqual({ time });
  });

  it('preserves historical caption whitespace on an untouched metadata save', () => {
    expect(photoMetadataEditPayload('  Historical caption  ', '  Historical caption  ', '', '')).toEqual({});
    expect(photoMetadataEditPayload('Historical caption', '  Historical caption  ', '', '')).toEqual({});
  });

  it('carries explicit removal of the last visible photo without changing the care time', () => {
    expect(photoLogEditPayload('unused-time', false, [], true)).toEqual({ photoIds: [] });
  });

  it('clears or changes only deliberately edited metadata', () => {
    expect(photoMetadataEditPayload('', 'Old caption', '', '')).toEqual({ caption: null });
    expect(photoMetadataEditPayload('Caption', 'Caption', '', 'old-milestone')).toEqual({ milestoneId: null });
    expect(photoMetadataEditPayload('Caption', 'Caption', 'new-milestone', '')).toEqual({ milestoneId: 'new-milestone' });
    expect(photoMetadataEditPayload('  Caption  ', 'Caption', '', '')).toEqual({});
  });
});

describe('retained photo capacity', () => {
  it('reserves hidden and trashed slots without exposing those photos', () => {
    expect(reservedPhotoSlots(4, 1)).toBe(3);
    expect(availablePhotoSlots(4, 1, 0, reservedPhotoSlots(4, 1))).toBe(0);
  });

  it('allows replacing a deliberately removed visible photo while keeping reserved slots', () => {
    expect(availablePhotoSlots(4, 0, 0, 3)).toBe(1);
    expect(availablePhotoSlots(4, 0, 1, 3)).toBe(0);
  });

  it('never gives a negative slice limit for legacy over-cap sets', () => {
    expect(availablePhotoSlots(4, 3, 0, reservedPhotoSlots(7, 3))).toBe(0);
  });

  it('supports legacy responses that omit capacity without inventing reservations', () => {
    expect(reservedPhotoSlots(undefined, 2)).toBe(0);
    expect(reservedPhotoSlots(Number.NaN, 2)).toBe(0);
    expect(reservedPhotoSlots(1, 2)).toBe(0);
  });
});
