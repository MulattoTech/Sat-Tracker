# Complete portable backup and isolated recovery

Portable recovery captures the application metadata and every referenced encrypted file that remains eligible for retention. It restores into a fresh, isolated destination running the same supported application schema. It does not replace a running installation or merge families.

## Create a backup

Open **Backup and recovery** from the installation administrator controls. A signed installation administrator session and the current, configured administrator password are required. The default `admin` password, a family administrator, system caretaker `00`, an account owner, and a setup invitation do not qualify.

Download the portable ZIP and use **Download recovery key** to save the source installation's exact `ENC_HASH` separately. The key is 64 hexadecimal characters. Its letter case is significant for encrypted configuration; spaces, line breaks, case conversion, and replacement keys are rejected. The ZIP never embeds the source key or replays an environment file. Protect the ZIP as private family and installation data, and keep its recovery key separately.

The source database's native snapshot lock remains held while metadata and referenced ciphertext are read. A missing file, invalid ownership path, incompatible schema, unknown application table/column, or failed decryption stops the export. There is no partial-success backup.

Production images built by the accepted-image workflow carry `SAT_TRACKER_SOURCE_REVISION`. A custom image should supply the exact clean source commit through the build argument of the same name. A local checkout without this setting must have a clean application tree and a resolvable Git commit before exporting.

### Included and explicitly excluded content

| Content | Behavior |
| --- | --- |
| Application metadata | Every model and scalar field in the trusted Prisma schema, including empty tables; currently 66 models and 766 scalar fields. |
| Identities and history | Exact IDs, relationships, owners, timestamps, nulls, false/zero values, provenance, favorites and soft-deletion timestamps. |
| Photos | Encrypted display and thumbnail files, including retained trash. Original uploads are not retained by the photo subsystem and cannot be reconstructed. |
| Vaccine documents and feedback attachments | Referenced encrypted files with original storage identity and metadata. |
| OCR sources and previews | Retained encrypted files; expired or purged sources are explicitly omitted. Expiry during transport is applied again before recovery without changing the original metadata. |
| Encrypted database fields | Original configuration, OCR state and audit ciphertext, authenticated with the separate exact source key. |
| Diagnostic API logs | Explicitly excluded, including the known `api_logs` table when colocated. Application `NotificationLog` and other application models remain included. |
| Environment, application/model assets and unreferenced files | Excluded. Database URLs, the source key and normal environment settings are not imported from a ZIP. |

Unknown legacy `Milestone.photo` references are reported as incomplete rather than silently omitted. Historical polymorphic photo links remain unchanged; this package does not repair or relabel them.

## Start an isolated destination

Use the qualified image by immutable digest, a new empty database, a separate empty media volume and a private recovery state directory. Never attach the production database, media or environment volumes.

The recovery entry point requires these operator-provided settings:

| Setting | Required value |
| --- | --- |
| `SAT_TRACKER_RECOVERY_MODE` | `1` |
| `SAT_TRACKER_RECOVERY_TOKEN` | A newly generated random capability containing 64–128 hexadecimal characters. |
| `SAT_TRACKER_RECOVERY_DATABASE_URL` | An absolute `file:/.../recovery.db` URL, or an explicit PostgreSQL database URL. |
| `SAT_TRACKER_RECOVERY_STATE_DIR` | An absolute private directory, separate from the database and `/app/Files`. |

The startup guard runs before ordinary environment initialization, migration, seeding, converters or scheduled jobs. It accepts a fresh destination or a complete compatible empty application schema; it rejects partial or drifted schemas. Schema initialization runs only for a fresh destination, and an existing compatible empty schema skips all DDL. The destination must be exclusively owned by this isolated recovery process during initialization. Startup never creates default families, resets an administrator password, imports an archived environment, or synchronizes a diagnostic-log database.

A PostgreSQL destination must already exist and use a separate empty schema. Schema names must be lowercase identifiers. Only `schema` and `sslmode` connection URL options are accepted. Both Prisma queries and native checks use the selected schema.

Example for a new local SQLite recovery container (replace the image digest with the qualified candidate):

```sh
docker volume create sat-recovery-db
docker volume create sat-recovery-files
docker volume create sat-recovery-state
export SAT_TRACKER_RECOVERY_TOKEN="$(openssl rand -hex 32)"
docker run --name sat-recovery --restart=no \
  --publish 127.0.0.1:3100:3000 \
  --env SAT_TRACKER_RECOVERY_MODE=1 \
  --env SAT_TRACKER_RECOVERY_TOKEN \
  --env SAT_TRACKER_RECOVERY_DATABASE_URL=file:/db/recovery.db \
  --env SAT_TRACKER_RECOVERY_STATE_DIR=/recovery-state \
  --mount source=sat-recovery-db,target=/db \
  --mount source=sat-recovery-files,target=/app/Files \
  --mount source=sat-recovery-state,target=/recovery-state \
  ghcr.io/mulattotech/babytracker-master@sha256:REPLACE_WITH_QUALIFIED_DIGEST
```

Use newly named volumes for each attempt. A blocked or completed destination must be reviewed before it is reused. The capability is entered in the recovery page and sent only in the `X-Sat-Recovery-Token` header; it is not a family login token.

## Inspect, then recover

Open `/recovery` on the isolated instance. Enter its operator token, choose the portable archive and enter the separate exact source key. Check the destination, then inspect the archive. The summary shows the source revision/provider, application and media counts, archive digest, retention omissions, and any incomplete legacy diagnostics.

Select **Recover into this empty destination** only for an eligible complete archive. Commit repeats the archive/key/schema/checksum checks and verifies the same archive digest. It then acquires an exclusive operation marker, locks the destination application tables, rechecks emptiness, imports every scalar and relationship, publishes authenticated ciphertext, and verifies exact table hashes before success.

Normal application pages and APIs remain unavailable throughout recovery and after success. A successful receipt has `activationRequired: true`. The original source key is saved only to private `recovery.env` in the recovery state directory, with owner-only file permissions. The normal `.env` is unchanged.

### Restarting a completed recovery-only destination

A new completed recovery carries a separate, key-bound integrity seal covering its receipt, all recovered table hashes, and every retained encrypted file path, length, and digest. On a recovery-only restart, the startup guard checks the bound private instance, exact schema, permission-restricted source key and receipt, authenticates all referenced media and encrypted scalar values, verifies the saved completeness seal, and checks for unexpected extra files. It then serves **only** the recovery page/status while leaving every normal application route disabled. The startup must not migrate, import, reseed, rewrite media, apply environment settings or activate the destination.

An interrupted journal, changed metadata or ciphertext, missing/modified receipt or key, altered schema, changed token/destination identity, or unexpected file **blocks startup without repair**. Older successful receipts lacking this new seal are *not* retroactively trusted: retain their database, media and private state and obtain independent operator review. An earlier source image that failed to restart after recovery cannot be made safe by deleting evidence or forcing a fresh migration.

Activation is a separate operator decision: review the successful receipt, source revision, intended database/media volumes and exact key configuration before any normal application startup. This procedure does not activate a deployment, change a production container, rotate keys or merge historical data.

## Failure and interruption behavior

The filesystem and database do not form a live atomic switch. Recovery uses a private staging directory and retained journal while normal access is blocked. On an ordinary failure, it removes only its own unchanged files and only after a fresh native transaction proves that all destination application tables are empty. Caller-owned files are never swept.

An uncertain commit response, process interruption, changed owned file, conflicting destination, or incomplete receipt leaves recovery blocked with retained evidence. Do not delete its journal, retry its transaction or activate the destination until the database and files have been independently reviewed. Starting with a different fresh isolated destination preserves the failed attempt for inspection.

All included ciphertext is authenticated even when its OCR retention has expired during transfer. Recovery never resurrects expired/purged OCR media or extends trash retention.

## Legacy inputs and supported limits

Raw SQLite files and the recognized historical ZIP layout can be inspected. A current-schema SQLite file is opened read-only through a private temporary copy, with explicit legacy date conversion and cleanup. Missing models/fields, unknown tables/columns or ambiguous dates produce diagnostics. No omitted field is synthesized. A supplied database file cannot prove that the latest live source WAL was included.

Historical JSON exports can omit empty or failed tables. Legacy inputs lack the complete authenticated media manifest and source provenance required for this recovery contract, so their summary remains `coverage: incomplete` and `canRestore: false`. Archived environment values are ignored. When possible, create a new portable archive from the original installation.

The versioned reader accepts ordinary file-only ZIP32 STORE/DEFLATE archives. It rejects duplicate names, case collisions, traversal, symlinks, directory entries, comments/extra fields, ZIP64, encryption, data descriptors, inconsistent headers, invalid CRCs and undeclared bytes.

| Limit | Maximum |
| --- | --- |
| Archive and expanded total | 512 MiB each |
| Single archive member | 64 MiB |
| Application metadata | 32 MiB |
| Manifest | 8 MiB |
| Encrypted media entries | 20,000 |
| Raw legacy SQLite inspection | 128 MiB |

Requests are bounded by the bytes actually streamed, before multipart parsing. Exports exceeding these limits fail without producing a partial archive.

## Qualification

The independent `portable-recovery` CI job exercises SQLite→SQLite, SQLite→PostgreSQL, PostgreSQL→SQLite and PostgreSQL→PostgreSQL on disposable synthetic databases, with separately generated provider clients. It checks exact metadata, byte-identical encrypted media, retention, invalid keys, tampering, occupied destinations, rollback, cleanup and replay refusal. Its browser stage covers actual recovery startup, upload/inspection/commit, failed draft retention and the continued normal-API blockade. Existing runtime, photo and PostgreSQL acceptance stages remain separate.
