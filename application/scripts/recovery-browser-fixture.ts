/** All fixture data and ciphertext are synthetic; no application singleton or persisted environment is read. */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parsePortableSchema } from '../src/lib/portable-recovery/schema';
import { inventoryReferencedMedia } from '../src/lib/portable-recovery/media-inventory';
import { createPortableArchive, preflightPortableArchive } from '../src/lib/portable-recovery/archive';
import { validatePortableMetadata } from '../src/lib/portable-recovery/metadata';
import { createPortableMetadata } from '../src/lib/portable-recovery/metadata-codec';
import { recoveryFixture, sha256 } from './recovery-qualification-fixtures';

export async function createRecoveryBrowserFixture(directory: string, sourceRevision: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const registry = parsePortableSchema(await readFile(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8'));
  signal?.throwIfAborted();
  const sourceKey = 'aB' + randomBytes(31).toString('hex');
  const operatorToken = randomBytes(32).toString('hex');
  const fixture = await recoveryFixture(registry, sourceKey);
  signal?.throwIfAborted();
  const original = fixture.metadata('sqlite');
  const rows = Object.fromEntries(Object.entries(original.tables).map(([name, table]) => [name, table.rows.map(row => ({ ...row }))]));
  const now = Date.now();
  const relative = (milliseconds: number) => new Date(now + milliseconds).toISOString();
  for (const row of rows.OcrDocument) {
    row.sourceExpiresAt = relative(row.id === fixture.ocrIds.retained ? 2 * 86_400_000 :
      row.id === fixture.ocrIds['transit-expired'] ? -30 * 60_000 : -2 * 3_600_000);
    if (row.purgedAt !== null) row.purgedAt = relative(-3_600_000);
  }
  // Prove that the framework proxy does not silently truncate legitimate uploads
  // at its default 10 MiB limit. This remains below the metadata/archive limits.
  rows.Note[0].content = 'Synthetic recovery upload boundary.\n'.repeat(360_000);
  const metadata = createPortableMetadata(registry, { ...original.source, exportedAt: relative(-3_600_000) }, rows);
  const inventory = inventoryReferencedMedia(metadata, new Date(metadata.source.exportedAt));
  const media = inventory.entries.map(entry => {
    const ciphertext = fixture.files.get(entry.storagePath)!.ciphertext;
    return { ...entry, ciphertext, byteLength: ciphertext.length, sha256: sha256(ciphertext) };
  });
  const bytes = await createPortableArchive({ metadata, media, omissions: inventory.omissions, sourceRevision }, sourceKey);
  signal?.throwIfAborted();
  const prepared = preflightPortableArchive(bytes, sourceKey);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  signal?.throwIfAborted();
  const archivePath = path.join(directory, 'synthetic-portable.zip');
  await writeFile(archivePath, bytes, { mode: 0o600, signal });
  signal?.throwIfAborted();
  return { registry, sourceKey, operatorToken, metadata, tableHashes: validatePortableMetadata(metadata, registry).tableHashes,
    bytes, archivePath, archiveSha256: sha256(bytes), files: fixture.files, prepared };
}
