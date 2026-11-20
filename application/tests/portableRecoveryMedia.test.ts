import { afterEach, describe, expect, it } from 'vitest';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertPortablePath, inventoryReferencedMedia, readReferencedMedia } from '@/src/lib/portable-recovery/media-inventory';
import type { MediaMetadata } from '@/src/lib/portable-recovery/media-types';

const key = 'aB'.repeat(32), now = new Date('2026-11-20T12:00:00.000Z');
const owned: string[] = [];
afterEach(async () => { for (const directory of owned.splice(0)) await rm(directory, { recursive: true, force: true }); });
function metadata() {
  const rows: Record<string, Record<string, unknown>[]> = {
    Family: [{ id: 'family' }], Baby: [{ id: 'child', familyId: 'family', deletedAt: null }],
    VaccineLog: [{ id: 'vaccine', familyId: 'family' }], Feedback: [{ id: 'feedback', familyId: null }],
    Milestone: [{ id: 'milestone', photo: null }], Photo: [], VaccineDocument: [], FeedbackAttachment: [], OcrDocument: [],
  };
  return { rows, build: (): MediaMetadata => ({ tables: Object.fromEntries(Object.entries(rows).map(([name, values]) => [name, { rows: values, rowCount: values.length }])) }) };
}
function photo(id = 'photo') {
  return { id, babyId: 'child', familyId: 'family', storedName: `${randomUUID()}.enc`, thumbStoredName: `${randomUUID()}.enc`, fileSize: 9, thumbSize: 9, deletedAt: '2026-11-19T12:00:00.000Z', milestoneId: 'unavailable-historical-target' };
}
function ocr(expiry = '2026-11-21T12:00:00.000Z', purgedAt: string | null = null) {
  return { id: randomUUID(), familyId: 'family', babyId: 'child', sourceFile: `${randomUUID()}.enc`, previewFiles: JSON.stringify([{ page: 3, file: `${randomUUID()}.enc` }]), pageCount: 1,
    byteSize: 9, sourceHash: createHash('sha256').update('synthetic').digest('hex'), sourceExpiresAt: expiry, purgedAt };
}
function cipher(value = Buffer.from('synthetic')) {
  const iv = randomBytes(16), c = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  return Buffer.concat([iv, c.update(value), c.final(), c.getAuthTag()]);
}
// Use the established on-disk ordering, independent from the recovery reader.
function stored(value = Buffer.from('synthetic')) {
  const encrypted = cipher(value);
  return Buffer.concat([encrypted.subarray(0, 16), encrypted.subarray(-16), encrypted.subarray(16, -16)]);
}
async function directory() { const result = await mkdtemp(path.join(tmpdir(), 'sat-recovery-media-')); owned.push(result); return result; }

describe('portable media inventory preserves declared references and retention boundaries', () => {
  it('covers display/thumbnail trash, vaccine, nullable-family feedback and retained OCR files without editing metadata', () => {
    const m = metadata(); m.rows.Photo.push(photo()); m.rows.OcrDocument.push(ocr());
    m.rows.VaccineDocument.push({ id: 'vd', vaccineLogId: 'vaccine', storedName: `${randomUUID()}.enc`, fileSize: 9 });
    m.rows.FeedbackAttachment.push({ id: 'fa', feedbackId: 'feedback', storedName: `${randomUUID()}.enc`, fileSize: 9 });
    const data = m.build(), before = JSON.stringify(data), inventory = inventoryReferencedMedia(data, now);
    expect(inventory.entries).toHaveLength(6);
    expect(new Set(inventory.entries.flatMap(e => e.references.map(r => r.role)))).toEqual(new Set(['photo-display', 'photo-thumbnail', 'vaccine-document', 'feedback-attachment', 'ocr-source', 'ocr-preview']));
    expect(inventory.omissions).toEqual([]); expect(JSON.stringify(data)).toBe(before);
    expect(m.rows.Photo[0].milestoneId).toBe('unavailable-historical-target');
  });
  it('omits expired and purged OCR bytes while preserving original metadata and timestamps', () => {
    const m = metadata(); m.rows.OcrDocument.push(ocr(now.toISOString()), ocr('2026-11-21T12:00:00.000Z', '2026-11-19T12:00:00.000Z'));
    const data = m.build(), before = JSON.stringify(data), inventory = inventoryReferencedMedia(data, now);
    expect(inventory.entries).toEqual([]);
    expect(new Set(inventory.omissions.map(o => o.reason))).toEqual(new Set(['ocr-expired', 'ocr-purged']));
    expect(inventory.omissions.every(o => o.storagePaths.length === 2)).toBe(true);
    expect(JSON.stringify(data)).toBe(before);
  });
  it('records purged documents even when their source and preview references are already cleared', () => {
    const m = metadata(); m.rows.OcrDocument.push({ ...ocr(), sourceFile: null, previewFiles: '[]', purgedAt: now.toISOString() });
    expect(inventoryReferencedMedia(m.build(), now).omissions[0].storagePaths).toEqual([]);
  });
  it('rejects unknown legacy milestone paths instead of claiming media completeness', () => {
    const m = metadata(); m.rows.Milestone[0].photo = '/historical/image.jpg';
    expect(() => inventoryReferencedMedia(m.build(), now)).toThrow(/Milestone.photo/);
  });
  it.each(['other-family', null, '../outside'])('rejects unresolved Photo namespace %s without inferring ownership', familyId => {
    const m = metadata(); m.rows.Photo.push({ ...photo(), familyId });
    expect(() => inventoryReferencedMedia(m.build(), now)).toThrow();
  });
  it('rejects sibling-family ownership, missing parents and duplicate/case-colliding stored paths', () => {
    const m = metadata(); m.rows.Photo.push(photo()); m.rows.Baby[0].familyId = 'foreign';
    expect(() => inventoryReferencedMedia(m.build(), now)).toThrow(); m.rows.Baby[0].familyId = 'family';
    m.rows.Photo[0].thumbStoredName = String(m.rows.Photo[0].storedName).toUpperCase().replace('.ENC', '.enc');
    expect(() => inventoryReferencedMedia(m.build(), now)).toThrow(/collide/);
    m.rows.Photo = []; m.rows.VaccineDocument.push({ id: 'missing-parent', vaccineLogId: 'absent', storedName: `${randomUUID()}.enc`, fileSize: 9 });
    expect(() => inventoryReferencedMedia(m.build(), now)).toThrow(/missing parent/);
  });
  it.each(['not-json', '{}', '[{"page":1,"file":"../outside.enc"}]', '[{"page":0,"file":"bad.enc"}]'])('rejects invalid OCR reference JSON %s', previewFiles => {
    const m = metadata(); m.rows.OcrDocument.push({ ...ocr(), previewFiles });
    expect(() => inventoryReferencedMedia(m.build(), now)).toThrow();
  });
  it.each(['/absolute.enc', '../escape.enc', 'a/../b.enc', 'C:/file.enc', 'a\\file.enc', 'file.enc:stream', 'a//b.enc', 'CON.enc', 'a/nul', 'a./b.enc', 'é.enc', 'e\u0301.enc', 'a/'])('rejects nonportable path %s', value => {
    expect(() => assertPortablePath(value)).toThrow();
  });
});

describe('portable media reads are bounded, authenticated and confined to explicit roots', () => {
  it('reads only referenced ciphertext including an explicit OCR root; unrelated files are untouched', async () => {
    const root = await directory(), ocrRoot = await directory(), m = metadata(); m.rows.Photo.push(photo()); m.rows.OcrDocument.push(ocr());
    const inventory = inventoryReferencedMedia(m.build(), now), bytes = stored();
    for (const entry of inventory.entries) {
      const file = entry.storagePath.startsWith('ocr/') ? path.join(ocrRoot, entry.storagePath.slice(4)) : path.join(root, entry.storagePath);
      await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
    }
    await writeFile(path.join(root, 'unreferenced.enc'), Buffer.from('not an archive member'));
    const result = await readReferencedMedia(inventory, { filesRoot: root, ocrRoot }, key);
    expect(result).toHaveLength(4); expect(result.every(file => file.ciphertext.equals(bytes))).toBe(true);
    expect(await readFile(path.join(root, 'unreferenced.enc'), 'utf8')).toBe('not an archive member');
  });
  it('rejects missing referenced bytes and incorrect file ciphertext before any destination action', async () => {
    const root = await directory(), m = metadata(); m.rows.Photo.push(photo()); const inventory = inventoryReferencedMedia(m.build(), now);
    await expect(readReferencedMedia(inventory, { filesRoot: root }, key)).rejects.toThrow(/missing/);
    for (const entry of inventory.entries) { const file = path.join(root, entry.storagePath); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, stored()); }
    await expect(readReferencedMedia(inventory, { filesRoot: root }, 'cd'.repeat(32))).rejects.toThrow(/authenticated/);
    await expect(readReferencedMedia(inventory, { filesRoot: root }, key, { entryBytes: 32 })).rejects.toThrow(/limit/);
    await expect(readReferencedMedia(inventory, { filesRoot: root }, key, { mediaEntries: 1 })).rejects.toThrow(/limit/);
  });
  it('rejects symlinked source directories and final file links', async () => {
    const root = await directory(), outside = await directory(), m = metadata(); m.rows.Photo.push(photo()); const inventory = inventoryReferencedMedia(m.build(), now);
    await mkdir(path.join(outside, 'family')); await symlink(outside, path.join(root, 'photos'), 'dir');
    await expect(readReferencedMedia(inventory, { filesRoot: root }, key)).rejects.toThrow(/symlinks/);
    await rm(path.join(root, 'photos')); await mkdir(path.join(root, 'photos', 'family'), { recursive: true });
    const source = path.join(outside, 'cipher.enc'), original = stored(); await writeFile(source, original);
    await symlink(source, path.join(root, inventory.entries[0].storagePath));
    await expect(readReferencedMedia(inventory, { filesRoot: root }, key)).rejects.toThrow(/symlinks/);
    expect(await readFile(source)).toEqual(original);
  });
});
