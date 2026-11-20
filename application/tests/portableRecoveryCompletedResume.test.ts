import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPortableArchive } from '@/src/lib/portable-recovery/archive';
import { recoveryConfiguration } from '@/src/lib/portable-recovery/configuration';
import { recoveryIntegrityTag, verifyRecoveryIntegrity } from '@/src/lib/portable-recovery/integrity-seal';
import { archiveDigest, recoverPortableArchive } from '@/src/lib/portable-recovery/engine';
import { inventoryReferencedMedia } from '@/src/lib/portable-recovery/media-inventory';
import { verifyCompletedRecovery } from '@/src/lib/portable-recovery/completed-resume';
import { assertNativeRestoredDestination, assertNativeEmptyDestination } from '@/src/lib/portable-recovery/startup-guard';
import { initializeRecoveryInstance, readRecoveryReceipt } from '@/src/lib/portable-recovery/storage';
import type { RecoveryReceipt } from '@/src/lib/portable-recovery/types';
import { exportedAt, restoredAt, recoveryFixture } from '../scripts/recovery-qualification-fixtures';
import { createMetadataTestDatabase, metadataRegistry } from './portableRecoveryTestUtils';

const key = 'aB' + 'ab'.repeat(31);
const fixtureRecords: ReturnType<typeof createMetadataTestDatabase>[] = [];
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
afterEach(async () => { for (const fixture of fixtureRecords.splice(0)) await fixture.close(); });

async function recovered() {
  const fixture = createMetadataTestDatabase(); fixtureRecords.push(fixture);
  const config = recoveryConfiguration({
    SAT_TRACKER_RECOVERY_MODE: '1', SAT_TRACKER_RECOVERY_TOKEN: 'ab'.repeat(32),
    SAT_TRACKER_RECOVERY_DATABASE_URL: 'file:' + fixture.file,
    SAT_TRACKER_RECOVERY_STATE_DIR: path.join(fixture.directory, 'private-state'),
  }, fixture.directory);
  expect(await assertNativeEmptyDestination(config, metadataRegistry)).toBe('current-empty');
  await initializeRecoveryInstance(config);
  const source = await recoveryFixture(metadataRegistry, key);
  const metadata = source.metadata('sqlite');
  const inventory = inventoryReferencedMedia(metadata, new Date(exportedAt));
  const media = inventory.entries.map(entry => {
    const ciphertext = source.files.get(entry.storagePath)!.ciphertext;
    return { ...entry, ciphertext, byteLength: ciphertext.length, sha256: sha(ciphertext) };
  });
  const bytes = await createPortableArchive({ metadata, media, omissions: inventory.omissions, sourceRevision: 'a'.repeat(40) }, key);
  const receipt = await recoverPortableArchive({ client: fixture.db, config, registry: metadataRegistry, bytes,
    exactSourceKey: key, expectedArchiveSha256: archiveDigest(bytes), now: new Date(restoredAt) });
  expect(receipt.mediaSnapshotAt).toBe(restoredAt);
  expect(receipt.integrityTag).toMatch(/^[a-f\d]{64}$/);
  return { ...fixture, config, receipt };
}

describe('completed recovery only resumes with authenticated exact metadata and ciphertext', () => {
  it('seals all receipt values, table hashes and media identity with the case-sensitive source key', () => {
    const receipt: RecoveryReceipt = {
      archiveSha256: 'a'.repeat(64), format: 'portable-v1', sourceProvider: 'sqlite', sourceRevision: 'b'.repeat(40),
      exportedAt, modelCount: 1, recordCount: 1, mediaCount: 1, mediaBytes: 34, coverage: 'complete',
      omissions: [], diagnostics: [], canRestore: true, status: 'RECOVERED', destinationProvider: 'sqlite',
      completedAt: restoredAt, tablesRestored: 1, recordsRestored: 1, filesRestored: 1, verified: true,
      activationRequired: true, mediaSnapshotAt: restoredAt,
    };
    const tables = { Family: 'sha256:' + 'f'.repeat(64) };
    const media = [{ storagePath: 'photo.enc', sha256: 'c'.repeat(64), byteLength: 34 }];
    receipt.integrityTag = recoveryIntegrityTag(receipt, tables, media, key);
    expect(() => verifyRecoveryIntegrity(receipt, tables, media, key)).not.toThrow();
    expect(() => verifyRecoveryIntegrity(receipt, tables, media, key.toLowerCase())).toThrow();
    expect(() => verifyRecoveryIntegrity({ ...receipt, recordsRestored: 2 }, tables, media, key)).toThrow();
    expect(() => verifyRecoveryIntegrity(receipt, { Family: 'sha256:' + '0'.repeat(64) }, media, key)).toThrow();
    expect(() => verifyRecoveryIntegrity(receipt, tables, [{ ...media[0], byteLength: 35 }], key)).toThrow();
    expect(() => verifyRecoveryIntegrity({ ...receipt, integrityTag: undefined }, tables, media, key)).toThrow();
  });

  it('accepts exact restored schema, media, private key and matching receipt; never accepts an empty-start guard', async () => {
    const { config, receipt } = await recovered();
    await expect(assertNativeRestoredDestination(config, metadataRegistry)).resolves.toBeUndefined();
    await expect(assertNativeEmptyDestination(config, metadataRegistry)).rejects.toMatchObject({ code: 'DESTINATION_NOT_EMPTY' });
    await expect(verifyCompletedRecovery(config, metadataRegistry)).resolves.toEqual(receipt);
    expect(await readRecoveryReceipt(config)).toEqual(receipt);
  }, 30_000);

  it('fails closed on modified metadata, changed ciphertext, unrelated media, missing key and forged receipt', async () => {
    const { config, db, receipt } = await recovered();
    const family = await db.family.findFirstOrThrow();
    await db.family.update({ where: { id: family.id }, data: { name: 'Synthetic changed name' } });
    await expect(verifyCompletedRecovery(config, metadataRegistry)).rejects.toMatchObject({ code: 'RECOVERY_RESUME_UNVERIFIED' });
    await db.family.update({ where: { id: family.id }, data: { name: family.name, updatedAt: family.updatedAt } });
    await expect(verifyCompletedRecovery(config, metadataRegistry)).resolves.toEqual(receipt);

    const photo = await db.photo.findFirstOrThrow();
    const filename = path.join(config.filesRoot, 'photos', photo.familyId!, photo.storedName!);
    const original = await fs.readFile(filename);
    const damaged = Buffer.from(original); damaged[damaged.length - 1] ^= 1;
    await fs.writeFile(filename, damaged);
    await expect(verifyCompletedRecovery(config, metadataRegistry)).rejects.toMatchObject({ code: 'RECOVERY_RESUME_UNVERIFIED' });
    await fs.writeFile(filename, original);
    const stranger = path.join(config.filesRoot, 'unreferenced.enc'); await fs.writeFile(stranger, 'synthetic unknown');
    await expect(verifyCompletedRecovery(config, metadataRegistry)).rejects.toMatchObject({ code: 'RECOVERY_RESUME_UNVERIFIED' });
    await fs.unlink(stranger);
    await expect(verifyCompletedRecovery(config, metadataRegistry)).resolves.toEqual(receipt);

    const privateKey = path.join(config.stateDir, 'recovery.env');
    const keyBytes = await fs.readFile(privateKey); await fs.unlink(privateKey);
    await expect(verifyCompletedRecovery(config, metadataRegistry)).rejects.toMatchObject({ code: 'RECOVERY_RESUME_UNVERIFIED' });
    await fs.writeFile(privateKey, keyBytes, { mode: 0o600 });
    const receiptPath = path.join(config.stateDir, 'receipt.json'), initialReceipt = await fs.readFile(receiptPath);
    const altered = JSON.parse(initialReceipt.toString()); altered.receipt.recordsRestored += 1;
    await fs.writeFile(receiptPath, JSON.stringify(altered));
    await expect(verifyCompletedRecovery(config, metadataRegistry)).rejects.toMatchObject({ code: 'RECOVERY_RESUME_UNVERIFIED' });
    await fs.writeFile(receiptPath, initialReceipt, { mode: 0o600 });
    await expect(verifyCompletedRecovery(config, metadataRegistry)).resolves.toEqual(receipt);
  }, 60_000);

  it('does not accept an unsealed older receipt as a new verified restart', async () => {
    const { config } = await recovered();
    const filename = path.join(config.stateDir, 'receipt.json'), stored = JSON.parse(await fs.readFile(filename, 'utf8'));
    delete stored.receipt.integrityTag;
    await fs.writeFile(filename, JSON.stringify(stored), { mode: 0o600 });
    await expect(verifyCompletedRecovery(config, metadataRegistry)).rejects.toMatchObject({ code: 'RECOVERY_RESUME_UNVERIFIED' });
  }, 30_000);
});
