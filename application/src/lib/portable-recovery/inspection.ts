import { readBoundedZip } from './archive';
import { assertSourceKey, verifyEncryptedMetadata } from './crypto';
import { archiveDigest, preparePortableRecovery } from './engine';
import { readLegacySQLiteMetadata } from './legacy-metadata';
import { PortableMetadataError, MAX_PORTABLE_METADATA_BYTES } from './metadata-codec';
import type { PortableSchemaRegistry } from './schema';
import { RecoveryError, type InspectionSummary } from './types';

const sqliteMagic = Buffer.from('SQLite format 3\0');
const legacyName = (name: string) => ['baby-tracker.db', 'data.json'].includes(name) || /^\d{4}-\d{2}-\d{2}\.backup\.env$/.test(name);

/** Classification only selects the strict parser. It never authorizes a recovery or trusts ZIP paths. */
function mayBeLegacyZip(bytes: Buffer): boolean {
  if (bytes.length < 30 || bytes.readUInt32LE(0) !== 0x04034b50) return false;
  const length = bytes.readUInt16LE(26);
  return length > 0 && length <= 512 && 30 + length <= bytes.length && legacyName(bytes.subarray(30, 30 + length).toString('ascii'));
}

/** Old formats are inspectable evidence, not proof of a complete recoverable installation. */
export async function inspectRecoveryInput(bytes: Buffer, exactSourceKey: string, registry: PortableSchemaRegistry): Promise<InspectionSummary> {
  assertSourceKey(exactSourceKey);
  let database: Buffer | undefined = bytes.subarray(0, 16).equals(sqliteMagic) ? bytes : undefined;
  let json: Buffer | undefined;
  if (!database && mayBeLegacyZip(bytes)) {
    const files = readBoundedZip(bytes, {}, legacyName);
    database = files.get('baby-tracker.db'); json = files.get('data.json');
    if ((!database && !json) || (database && json) || files.size > 2) throw new RecoveryError('INVALID_LEGACY_ARCHIVE', 'A legacy backup must contain exactly one recognized database payload.');
    // Environment members are deliberately neither parsed nor replayed. The source key is separate.
  }
  if (!database && !json) return preparePortableRecovery(bytes, exactSourceKey, registry).summary;

  const summary: InspectionSummary = {
    archiveSha256: archiveDigest(bytes), format: 'legacy', sourceProvider: database ? 'sqlite' : 'postgresql',
    sourceRevision: null, exportedAt: null, modelCount: 0, recordCount: 0, mediaCount: 0, mediaBytes: 0,
    coverage: 'incomplete', canRestore: false,
    omissions: ['No authenticated complete media manifest or exact source revision is available.'],
    diagnostics: ['This legacy input cannot be used for complete recovery. Create a versioned portable backup from the source installation when available.',
      'Archived environment values are ignored. The supplied key is never replaced with an archived value.'],
  };
  if (database) {
    try {
      const legacy = await readLegacySQLiteMetadata(database, registry);
      verifyEncryptedMetadata(legacy.metadata, exactSourceKey);
      summary.modelCount = registry.models.length;
      summary.recordCount = Object.values(legacy.metadata.tables).reduce((sum, table) => sum + table.rowCount, 0);
      summary.diagnostics.push('The supplied SQLite file was inspected read-only. Inclusion of the latest live source writes or WAL state cannot be proven.');
    } catch (error) {
      if (!(error instanceof PortableMetadataError)) throw error;
      const counts = new Map<string, number>();
      for (const diagnostic of error.diagnostics) counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
      summary.diagnostics.push(`Legacy metadata validation failed: ${error.code}. Counts are not validated.`);
      for (const [code, count] of counts) summary.diagnostics.push(`${code}: ${count}`);
    }
  } else {
    if (json!.length > MAX_PORTABLE_METADATA_BYTES) throw new RecoveryError('LEGACY_METADATA_SIZE_LIMIT', 'Legacy JSON exceeds the metadata inspection limit.');
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json!)); }
    catch { throw new RecoveryError('INVALID_LEGACY_METADATA', 'Legacy JSON is not a valid metadata document.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(rows => !Array.isArray(rows))) {
      throw new RecoveryError('INVALID_LEGACY_METADATA', 'Legacy JSON does not have the recognized table-array shape.');
    }
    summary.diagnostics.push('Unversioned JSON can omit empty or failed tables and has no trustworthy schema inventory or key proof. Counts are not validated; the provider is inferred from the legacy export format.');
  }
  return summary;
}
