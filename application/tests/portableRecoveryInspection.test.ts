import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { inspectRecoveryInput } from '@/src/lib/portable-recovery/inspection';
import { createPortableArchive } from '@/src/lib/portable-recovery/archive';
import { createPortableMetadata } from '@/src/lib/portable-recovery/metadata-codec';
import { createMetadataTestDatabase, metadataRegistry } from './portableRecoveryTestUtils';

const key = 'aB'.repeat(32);
const databases: ReturnType<typeof createMetadataTestDatabase>[] = [];
afterEach(async () => { for (const database of databases.splice(0)) await database.close(); });
function database() { const result = createMetadataTestDatabase(); databases.push(result); return result; }
const zipBytes = (zip: JSZip) => zip.generateAsync({ type: 'nodebuffer', compression: 'STORE', streamFiles: false });

describe('legacy inspection is explicitly incomplete', () => {
  it('inspects a full-schema native SQLite file without modifying it or claiming live/WAL/media completeness', async () => {
    const source = database(), bytes = await readFile(source.file);
    const result = await inspectRecoveryInput(bytes, key, metadataRegistry);
    expect(result).toMatchObject({ format: 'legacy', coverage: 'incomplete', canRestore: false, sourceProvider: 'sqlite',
      sourceRevision: null, exportedAt: null, modelCount: 66, recordCount: 0, mediaCount: 0 });
    expect(result.diagnostics.join(' ')).toContain('WAL');
    expect((await readFile(source.file)).equals(bytes)).toBe(true);
  });

  it('ignores an archived environment, including a different key, database URL and command text', async () => {
    const source = database(), bytes = await readFile(source.file);
    const zip = new JSZip().file('baby-tracker.db', bytes).file('2026-11-20.backup.env',
      'ENC_HASH="' + '11'.repeat(32) + '"\nDATABASE_URL="file:/never-touch.db"\nCOMMAND="$(never-run-this)"\n');
    const before = process.env.ENC_HASH;
    const result = await inspectRecoveryInput(await zipBytes(zip), key, metadataRegistry);
    expect(result).toMatchObject({ canRestore: false, coverage: 'incomplete', modelCount: 66 });
    expect(process.env.ENC_HASH).toBe(before);
    expect((await readFile(source.file)).equals(bytes)).toBe(true);
  });

  it('does not invent missing JSON tables, counts, provenance or a key proof', async () => {
    const bytes = await zipBytes(new JSZip().file('data.json', JSON.stringify({ Family: [] })));
    const result = await inspectRecoveryInput(bytes, key, metadataRegistry);
    expect(result).toMatchObject({ format: 'legacy', canRestore: false, coverage: 'incomplete', modelCount: 0, recordCount: 0 });
    expect(result.diagnostics.join(' ')).toContain('Counts are not validated');
  });

  it('rejects ambiguous legacy payloads and refuses downgrade of a portable archive with extra legacy files', async () => {
    const source = database();
    await expect(inspectRecoveryInput(await zipBytes(new JSZip().file('baby-tracker.db', await readFile(source.file)).file('data.json', '{}')), key, metadataRegistry)).rejects.toMatchObject({ code: 'INVALID_LEGACY_ARCHIVE' });
    await expect(inspectRecoveryInput(await zipBytes(new JSZip().file('data.json', '{}').file('manifest.json', '{}')), key, metadataRegistry)).rejects.toMatchObject({ code: 'INVALID_ARCHIVE' });
  });

  it('requires key authentication and exact schema completeness for a modern archive, including an empty installation', async () => {
    const metadata = createPortableMetadata(metadataRegistry, { provider: 'sqlite', exportedAt: '2026-11-20T00:00:00.000Z' },
      Object.fromEntries(metadataRegistry.models.map(model => [model.name, []])));
    const bytes = await createPortableArchive({ metadata, media: [], omissions: [], sourceRevision: 'a'.repeat(40) }, key);
    expect(await inspectRecoveryInput(bytes, key, metadataRegistry)).toMatchObject({ format: 'portable-v1', coverage: 'complete', canRestore: true, modelCount: 66, recordCount: 0 });
    await expect(inspectRecoveryInput(bytes, key.toLowerCase(), metadataRegistry)).rejects.toMatchObject({ code: 'DECRYPTION_FAILED' });
  });
});
