import { beforeAll, describe, expect, it, vi, afterEach } from 'vitest';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { createPortableArchive, preflightPortableArchive, readBoundedZip } from '@/src/lib/portable-recovery/archive';
import { inventoryReferencedMedia } from '@/src/lib/portable-recovery/media-inventory';
import { createKeyProof } from '@/src/lib/portable-recovery/crypto';
import { parsePortableSchema } from '@/src/lib/portable-recovery/schema';
import { createPortableMetadata, validatePortableMetadata } from '@/src/lib/portable-recovery/metadata-codec';
import type { VerifiedMedia } from '@/src/lib/portable-recovery/media-types';
import { sealOcrState } from '@/src/lib/ocr/crypto';

const key = 'aB'.repeat(32), time = '2026-11-20T12:00:00.000Z', revision = 'f'.repeat(40);
const registry = parsePortableSchema(readFileSync('prisma/schema.prisma', 'utf8'));
afterEach(() => vi.unstubAllEnvs());
function row(model: string, overrides: Record<string, unknown>) {
  return Object.fromEntries(registry.models.find(m => m.name === model)!.fields.map(field => [field.name,
    Object.hasOwn(overrides, field.name) ? overrides[field.name] : field.nullable ? null : field.type === 'DateTime' ? time
      : field.type === 'Boolean' ? false : field.type === 'Int' || field.type === 'Float' ? 0 : field.type === 'Enum' ? field.enumValues![0] : 'synthetic',
  ]));
}
function encrypted() {
  const iv = randomBytes(16), cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const body = Buffer.concat([cipher.update(Buffer.from('synthetic')), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}
function fixture(withMedia = false, withOcr = false) {
  vi.stubEnv('ENC_HASH', key);
  const tables = Object.fromEntries(registry.models.map(m => [m.name, [] as Record<string, unknown>[]]));
  if (withMedia || withOcr) {
    tables.Family.push(row('Family', { id: 'family', slug: 'synthetic-family' }));
    tables.Baby.push(row('Baby', { id: 'child', familyId: 'family' }));
  }
  if (withMedia) {
    tables.Photo.push(row('Photo', { id: 'photo', familyId: 'family', babyId: 'child', storedName: `${randomUUID()}.enc`, thumbStoredName: `${randomUUID()}.enc`, fileSize: 9, thumbSize: 9, deletedAt: '2026-11-19T00:00:00.000Z' }));
    tables.PhotoLink.push(row('PhotoLink', { id: 'hidden-link', photoId: 'photo', activityType: 'unsupported-historical-target', activityId: 'foreign-unresolved-target' }));
  }
  if (withOcr) tables.OcrDocument.push(row('OcrDocument', { id: 'document', familyId: 'family', babyId: 'child', sourceFile: `${randomUUID()}.enc`, previewFiles: JSON.stringify([{ page: 1, file: `${randomUUID()}.enc` }]), pageCount: 1, byteSize: 9,
    sourceHash: createHash('sha256').update('synthetic').digest('hex'), sourceExpiresAt: '2026-11-21T12:00:00.000Z', originalState: sealOcrState({}, 'family:document:original'), reviewState: sealOcrState({}, 'family:document:review') }));
  const metadata = createPortableMetadata(registry, { provider: 'sqlite', exportedAt: time }, tables);
  const inventory = inventoryReferencedMedia(metadata, new Date(time));
  const media: VerifiedMedia[] = inventory.entries.map(entry => { const ciphertext = encrypted(); return { ...entry, ciphertext, byteLength: ciphertext.length, sha256: createHash('sha256').update(ciphertext).digest('hex') }; });
  return { metadata, media, omissions: inventory.omissions, sourceRevision: revision };
}
async function pack(entries: readonly [string, Buffer | string][], compression: 'STORE' | 'DEFLATE' = 'STORE') {
  const zip = new JSZip();
  for (const [name, bytes] of entries) zip.file(name, bytes, { createFolders: false, date: new Date('1980-01-02T00:00:00.000Z'), unixPermissions: 0o100600 });
  return zip.generateAsync({ type: 'nodebuffer', compression, platform: 'UNIX', streamFiles: false });
}
async function rewrite(bytes: Buffer, change: (entries: Map<string, Buffer>) => void) {
  const entries = new Map(readBoundedZip(bytes)); change(entries); return pack([...entries]);
}
function locations(bytes: Buffer) {
  const end = bytes.length - 22, central = bytes.readUInt32LE(end + 16);
  return { central, end, local: bytes.readUInt32LE(central + 42) };
}

describe('portable archive proof and complete declared-media preflight', () => {
  it('roundtrips all 66 tables including empty tables, retained trash, opaque historical links and unchanged encrypted bytes', async () => {
    const input = fixture(true, true), before = JSON.stringify(input.metadata);
    const archive = await createPortableArchive(input, key), result = preflightPortableArchive(archive, key, { now: new Date(time) });
    const validated = validatePortableMetadata(result.metadata, registry);
    expect(result.manifest.tables).toHaveLength(66);
    expect(result.manifest.tables.find(table => table.name === 'GiftCode')?.rowCount).toBe(0);
    expect(result.manifest.tables.find(table => table.name === 'Photo')?.sha256).toBe(validated.tableHashes.Photo);
    expect(result.manifest.exclusions).toMatchObject({ environment: true, separateApiLogDatabase: true, diagnosticApiLogs: 'separate-or-colocated', sourceEncryptionKey: true });
    expect(result.manifest.sourceRevision).toBe(revision);
    expect(result.mediaToRestore).toHaveLength(4);
    expect(JSON.stringify(result.metadata)).toBe(before);
    for (const file of result.media) expect(file.ciphertext).toEqual(input.media.find(source => source.storagePath === file.storagePath)!.ciphertext);
    expect([...readBoundedZip(archive).keys()].some(name => /env|key/.test(name))).toBe(false);
    expect(archive.includes(Buffer.from(key))).toBe(false);
  });
  it('authenticates an empty installation archive and rejects a wrong-case key', async () => {
    const archive = await createPortableArchive(fixture(), key);
    expect(preflightPortableArchive(archive, key).mediaToRestore).toEqual([]);
    expect(() => preflightPortableArchive(archive, key.toLowerCase())).toThrow(/authenticated/);
  });
  it('refuses to omit an empty declared table from the archive inventory', async () => {
    const input = fixture(), metadata = JSON.parse(JSON.stringify(input.metadata)); delete metadata.tables.GiftCode;
    await expect(createPortableArchive({ ...input, metadata }, key)).rejects.toThrow(/including empty models/);
  });
  it('authenticates every included OCR file but omits newly expired bytes at restore without changing metadata', async () => {
    const input = fixture(false, true), archive = await createPortableArchive(input, key);
    const result = preflightPortableArchive(archive, key, { now: new Date('2026-11-22T12:00:00.000Z') });
    expect(result.media).toHaveLength(2); expect(result.mediaToRestore).toEqual([]);
    expect(result.omissions[0].reason).toBe('ocr-expired'); expect(result.metadata).toEqual(input.metadata);
    // Even a correctly re-signed manifest cannot excuse a damaged expired cipher.
    const damaged = await rewrite(archive, entries => {
      const name = [...entries.keys()].find(name => name.startsWith('media/'))!;
      const bytes = Buffer.from(entries.get(name)!); bytes[20] ^= 1; entries.set(name, bytes);
      const manifest = JSON.parse(entries.get('manifest.json')!.toString());
      manifest.media.find((item: { path: string }) => item.path === name).sha256 = createHash('sha256').update(bytes).digest('hex');
      const { keyProof: _old, ...descriptor } = manifest; manifest.keyProof = createKeyProof(descriptor, key);
      entries.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    });
    expect(() => preflightPortableArchive(damaged, key, { now: new Date('2026-11-22T12:00:00.000Z') })).toThrow(/authenticated/);
  });
  it('rejects source-clock omissions when recovery still requires those retained OCR files', async () => {
    const input = fixture(false, true), metadata = { ...input.metadata, source: { ...input.metadata.source, exportedAt: '2026-11-22T12:00:00.000Z' } };
    const omissions = inventoryReferencedMedia(metadata, new Date(metadata.source.exportedAt)).omissions;
    const before = JSON.stringify(metadata);
    const archive = await createPortableArchive({ ...input, metadata, media: [], omissions }, key);
    expect(() => preflightPortableArchive(archive, key, { now: new Date(time) })).toThrow(/source clock/);
    expect(JSON.stringify(metadata)).toBe(before);
  });
  it('does not reject a future export timestamp when no required media was omitted', async () => {
    const input = fixture(true), metadata = { ...input.metadata, source: { ...input.metadata.source, exportedAt: '2026-11-22T12:00:00.000Z' } };
    const archive = await createPortableArchive({ ...input, metadata }, key);
    const restored = preflightPortableArchive(archive, key, { now: new Date(time) });
    expect(restored.mediaToRestore).toHaveLength(2); expect(restored.metadata).toEqual(metadata);
  });
  it('rejects metadata tampering, ciphertext tampering, missing media and extra files before returning a restore plan', async () => {
    const archive = await createPortableArchive(fixture(true), key);
    for (const change of [
      (entries: Map<string, Buffer>) => { const data = JSON.parse(entries.get('metadata.json')!.toString()); data.tables.Photo.rows[0].caption = 'tampered'; entries.set('metadata.json', Buffer.from(JSON.stringify(data))); },
      (entries: Map<string, Buffer>) => { const name = [...entries.keys()].find(name => name.startsWith('media/'))!; const bytes = Buffer.from(entries.get(name)!); bytes[33] ^= 1; entries.set(name, bytes); },
      (entries: Map<string, Buffer>) => { entries.delete([...entries.keys()].find(name => name.startsWith('media/'))!); },
      (entries: Map<string, Buffer>) => { entries.set('backup.env', Buffer.from('synthetic untrusted environment')); },
      (entries: Map<string, Buffer>) => { entries.set('media/orphan.enc', encrypted()); },
    ]) {
      // Repacked bytes exercise the real ZIP and manifest boundaries.
      const changed = await rewrite(archive, change);
      expect(() => preflightPortableArchive(changed, key)).toThrow();
    }
  });
  it('rejects unsupported manifest versions, forged proof, altered counts and unsafe source-key embedding', async () => {
    const archive = await createPortableArchive(fixture(), key);
    for (const edit of [(m: any) => { m.version = 2; }, (m: any) => { m.keyProof.tag = Buffer.alloc(16).toString('base64'); }, (m: any) => { m.tables[0].rowCount = 1; }]) {
      const changed = await rewrite(archive, entries => { const m = JSON.parse(entries.get('manifest.json')!.toString()); edit(m); entries.set('manifest.json', Buffer.from(JSON.stringify(m))); });
      expect(() => preflightPortableArchive(changed, key)).toThrow();
    }
    const input = fixture(true);
    for (const exposed of [key, key.toLowerCase(), key.toUpperCase()]) {
      const raw = JSON.parse(JSON.stringify(input.metadata)); raw.tables.Photo.rows[0].caption = exposed;
      await expect(createPortableArchive({ ...input, metadata: raw }, key)).rejects.toThrow(/key appears/);
    }
  });
  it('enforces lower size/count limits and refuses raised limits or partial archives', async () => {
    const input = fixture(true), archive = await createPortableArchive(input, key);
    await expect(createPortableArchive(input, key, { archiveBytes: 100 })).rejects.toThrow(/limit|bounded/);
    await expect(createPortableArchive(input, key, { mediaEntries: 1 })).rejects.toThrow(/limit/);
    expect(() => preflightPortableArchive(archive, key, { limits: { archiveBytes: archive.length - 1 } })).toThrow(/limit/);
    expect(() => readBoundedZip(archive, { archiveBytes: 1024 * 1024 * 1024 })).toThrow(/lowered/);
  });
});

describe('bounded ZIP headers are checked before any normalization or extraction', () => {
  let stored: Buffer, deflated: Buffer;
  beforeAll(async () => { stored = await pack([['one.enc', 'synthetic']]); deflated = await pack([['one.enc', 'a'.repeat(100_000)]], 'DEFLATE'); });
  it('reads standard STORE and DEFLATE entries with verified CRCs', () => {
    expect(readBoundedZip(stored).get('one.enc')!.toString()).toBe('synthetic');
    expect(readBoundedZip(deflated).get('one.enc')).toEqual(Buffer.from('a'.repeat(100_000)));
  });
  it.each(['../escape.enc', '/absolute.enc', 'C:/file.enc', 'a\\b.enc', 'file.enc:stream', 'CON.enc', 'a/../b.enc', 'unicode-é.enc'])('rejects unsafe raw member %s', async name => {
    const bytes = await pack([[name, 'synthetic']]); expect(() => readBoundedZip(bytes)).toThrow();
  });
  it('rejects duplicate and case-colliding names that JSZip would merge', async () => {
    for (const replacement of ['a.enc', 'A.enc']) {
      const bytes = await pack([['a.enc', 'aaa'], ['b.enc', 'bbb']]);
      for (let offset = bytes.indexOf('b.enc'); offset >= 0; offset = bytes.indexOf('b.enc', offset + 1)) bytes.write(replacement, offset, 'ascii');
      expect(() => readBoundedZip(bytes)).toThrow(/Duplicate|colliding/);
    }
  });
  it.each(['symlink', 'directory', 'encrypted', 'zip64', 'crc', 'header-name', 'local-offset'])('rejects %s header manipulation', mutation => {
    const bytes = Buffer.from(stored), { central, local } = locations(bytes);
    if (mutation === 'symlink') bytes.writeUInt32LE((0o120777 * 65536) >>> 0, central + 38);
    if (mutation === 'directory') bytes.writeUInt32LE(0x10, central + 38);
    if (mutation === 'encrypted') { bytes.writeUInt16LE(1, central + 8); bytes.writeUInt16LE(1, local + 6); }
    if (mutation === 'zip64') bytes.writeUInt32LE(0xffffffff, central + 24);
    if (mutation === 'crc') { bytes.writeUInt32LE(0, central + 16); bytes.writeUInt32LE(0, local + 14); }
    if (mutation === 'header-name') bytes[local + 30] = 'x'.charCodeAt(0);
    if (mutation === 'local-offset') bytes.writeUInt32LE(1, central + 42);
    expect(() => readBoundedZip(bytes)).toThrow();
  });
  it('rejects declared and lying decompression bombs, truncated archives and trailing bytes', () => {
    expect(() => readBoundedZip(deflated, { entryBytes: 1024 })).toThrow(/expansion/);
    const bytes = Buffer.from(deflated), { central, local } = locations(bytes);
    bytes.writeUInt32LE(8, central + 24); bytes.writeUInt32LE(8, local + 22);
    expect(() => readBoundedZip(bytes)).toThrow(/bounded expansion/);
    expect(() => readBoundedZip(stored.subarray(0, stored.length - 1))).toThrow();
    expect(() => readBoundedZip(Buffer.concat([stored, Buffer.from('extra')]))).toThrow();
  });
  it('rejects undeclared compressed trailing data even with matching length headers', () => {
    const original = Buffer.from(deflated), { central, local } = locations(original);
    const bytes = Buffer.concat([original.subarray(0, central), Buffer.from('xx'), original.subarray(central)]);
    bytes.writeUInt32LE(central + 2, bytes.length - 22 + 16);
    bytes.writeUInt32LE(original.readUInt32LE(local + 18) + 2, local + 18);
    bytes.writeUInt32LE(original.readUInt32LE(central + 20) + 2, central + 2 + 20);
    expect(() => readBoundedZip(bytes)).toThrow(/trailing data/);
  });
});
