# Complete backup and isolated recovery

`BackupRestore` provides installation-owner downloads and a link to the operator setup instructions for a separate
recovery instance. It never overwrites the running installation.

## Source installation

The existing App Configuration screen renders `OwnerBackupControls` for the
installation administrator. Each download requires both a signed system-admin
session and a fresh check of the current, configured administrator password.
Blank/default `admin` credentials do not qualify. Family `ADMIN`, system caretaker
`00`, account ownership and setup invitations do not grant installation authority.

- **Download complete backup** calls `POST /api/database/backup` with JSON
  `{password}` and downloads the portable metadata/encrypted-media archive.
- **Download recovery key** calls `POST /api/database/recovery-key` with the same
  fresh password check. This separate text attachment contains the exact source
  encryption key, including its original case. It is never embedded in the ZIP.
- Both responses are `no-store`; keys/passwords are not placed in URLs or browser
  storage, and privileged auditing contains only request metadata.
- The password field clears after a successful download. A failed request retains
  the field for correction and displays an accessible error.

Keep the archive and recovery key private and separately protected. A complete
archive includes application metadata that can contain personal information and
installation credentials even though media remains encrypted.

## Empty destination

`/recovery` renders `RecoveryPanel` in an explicitly started, isolated recovery
instance. Startup is owned by `scripts/recovery-startup.ts`; it checks the explicit
SQLite/PostgreSQL destination and media directory before schema preparation. It
never runs normal seeding or activates the application.

The bootstrap credential is the operator-provided `SAT_TRACKER_RECOVERY_TOKEN`
(64–128 hexadecimal characters). The UI holds it only in component memory and
sends it as `X-Sat-Recovery-Token`. Ordinary JWTs, cookies and URL query parameters
cannot replace it. All recovery APIs first require
`SAT_TRACKER_RECOVERY_MODE=1` and a constant-time exact-token match.

1. Enter the operator token and choose **Check recovery destination**. Status must
   be empty and ready. A completed destination can display its existing receipt;
   it cannot accept another import.
2. Choose a `.zip`, `.db` or `.sqlite` archive and enter the exact 64-character
   source recovery key. It is the existing encryption key, not a new password.
3. Choose **Inspect backup**. Review source provider, complete/incomplete coverage,
   source revision and UTC export time, model/record/media counts, omissions,
   diagnostics and the archive SHA-256.
4. Only a restorable inspection enables **Recover into this empty destination**.
   The commit includes the inspected digest and the server repeats preflight and
   destination checks. Changing the archive, key or token invalidates the review.
5. A verified receipt reports completion and the separate activation requirement.
   The screen does not reload, seed, migrate, restart services or activate normal
   application access. Failed requests retain the selected file and draft.

Legacy native SQLite files and database-only ZIPs are inspectable as incomplete
backups. They do not satisfy the complete metadata/media contract and cannot be
committed through this flow. Archived environment files are never replayed.

## Request boundaries

| Endpoint | Method | Request |
| --- | --- | --- |
| `/api/recovery/status` | GET | Bootstrap header; no upload or source key |
| `/api/recovery/inspect` | POST | Multipart `archive`, `sourceKey` |
| `/api/recovery/commit` | POST | Multipart `archive`, `sourceKey`, `archiveSha256` |

The source key is case-sensitive. `archiveSha256` is 64 lowercase hexadecimal
characters. Duplicate/unknown multipart fields are rejected. The server counts
actual streamed bytes before multipart parsing, capped at 512 MiB plus 64 KiB of
multipart overhead; the file itself remains capped at 512 MiB. Content-Length is
an early rejection hint, not proof of the body size. The Next proxy clone cap is
also 512 MiB plus 64 KiB; its internal bounded clone happens before the proxy
callback. The shared token check prevents unauthorized forwarding, and route
authorization/current empty-ready status are checked before application upload
reading or multipart parsing. This does not claim zero framework buffering.

In recovery mode the global Next proxy allows only the recovery page, the three
explicit recovery API methods, required static chunks and icons. Other pages and
APIs, including authentication, public configuration, setup, cron and care
writers, remain blocked even after recovery completes. Normal-mode routing is
unchanged; recovery inspection and commit are unavailable there.

## Retired operations and compatibility

The previous `/api/database` download/restore, `restore-initial`, `migrate`,
`migrate-initial`, `pre-migration-check`, and `pre-migration-check-initial` handlers
now check system-admin authority and then return HTTP 410. They cannot replay an
`.env`, replace a live database file, reset administrator credentials, invoke
Prisma CLI commands or run conversion/seed scripts.

Existing `BackupRestoreProps` callbacks remain source-compatible. Restore and
administrator-reset callbacks are deprecated and never invoked. `initialSetup`
and `importOnly` display operator setup documentation instead of an import action.

## Verification

- `portableRecoveryHttp.test.ts`: exact bootstrap capability, actual streamed
  upload limits, multipart ambiguity and the recovery-only proxy allowlist.
- `portableRecoveryRoutes.integration.test.ts`: real SQLite fixtures and actual
  login-issued credentials, configured-owner reauthentication, denial before
  body parsing, retired endpoint immutability, and exact service arguments.
- The portable recovery engine/provider tests own archive integrity, all-model
  emptiness, cross-provider fidelity, transaction/media rollback and durable
  receipts. Route tests deliberately mock that service boundary while preserving
  actual authorization and request handling.
- `acceptance-recovery-browser.mjs` exercises the real isolated application UI and
  HTTP boundary with disposable synthetic source/archive/destination fixtures.
