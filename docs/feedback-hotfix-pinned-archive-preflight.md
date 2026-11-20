# Sat-Tracker — checksum-pinned offline backup archive preflight

**Status: SOURCE-ONLY SAFETY TOOL / NOT A LIVE BACKUP OR RESTORE.** This
document applies to the separately published feedback-attachment authorization
hotfix from release branch `release/feedback-security-b24ccc9`, not the
broader feature branch or a generic backup system.

The offline checker is `scripts/feedback_hotfix_archive_verify.py`. It can
inspect **one explicitly supplied** `.tar.gz` archive without touching Docker,
the current production/preview containers, their three volumes, GitHub, DNS,
Cloudflare, or any application endpoint. It does not extract files into
production or create permanent restored copies. Only synthetic fixtures were
used when developing and qualifying it.

## Why this tool exists

The original `scripts/backup.ps1` stops and restarts the live service and
saves `db/`, `env/`, and `files/` into one archive. That is not a read-only
operation and still requires a new approval explicitly covering the service
interruption and caregiver write quiescence.

The existing `scripts/test-restore.ps1` chooses the **newest** archive by
timestamp. It cannot establish that it tested the exact snapshot planned for
release, and its existing verification checks SQLite database integrity and
environment key-name presence but not all encrypted media bytes.

This independent, **non-executing** preflight checks the exact SHA-256 of an
operator-selected archive *before reading its contents*. It rejects:

- Unpinned, absent, symlinked, oversized, malformed, or hash-mismatched archives
- Unexpected top-level roots, directory traversal, absolute/Windows paths,
  links/devices and duplicate or case-colliding tar entries
- Missing `db/baby-tracker.db`, `db/baby-tracker-logs.db`, or `env/.env`
- Corrupted SQLite or foreign-key failures in either database
- Missing/duplicate/empty persistent `ENC_HASH` or `JWT_SECRET` entries

Accepted archive contents are streamed through SHA-256 with bounded member
counts and unpacked sizes. Both SQLite databases and optional WAL sidecars
are copied exclusively into a temporary restricted scratch directory for
read-only SQLite integrity checks. That scratch directory is deleted; no
database row or secret value is displayed. The verifier counts and hashes
all retained files under `files/`, but intentionally **does not decrypt**
those files or prove the application can read them with the restored key.

The tool never lists private archive paths or filenames in its JSON output.
Its aggregate hashes and counts should still be treated as private evidence
if they originate from a real household backup.

## Synthetic qualification

Run the synthetic regression suite without an archive from production:

```powershell
python -m unittest discover -s tests/ops -p test_feedback_hotfix_archive_verify.py -v
```

The fixtures generate disposable SQLite databases, artificial configuration
and fake media. They include malformed archives, traversal and link attacks,
checksum changes, missing files, missing keys, foreign-key failures and
unsupported `--apply`. Test skips on OSes that forbid symlinks must be
recorded; Linux hosted CI should exercise the symlink refusal case.

For a *fabricated* archive and a known SHA-256, this is the illustrative form:

```powershell
python scripts/feedback_hotfix_archive_verify.py --synthetic --archive <synthetic.tar.gz> --sha256 <64-hex-sha256>
```

There is deliberately **no** `--apply`, `--restore`, `--docker`, or
`--production` option. The checker can also read an operator-supplied
offline archive without `--synthetic`, but **do not** use it on a real family
backup without a separately authorized, confidential acquisition and
verification procedure. The code alone does not grant that permission.

## Security and scope of a PASS

A PASS means only the **specific archive's bytes** match the supplied digest
and pass static archive/SQLite/configuration checks. Every successful JSON
response explicitly contains:

- `media_decryption_verified=false`
- `live_snapshot_consistency_proven=false`
- `private_backup_restore_approved=false`
- `production_restore_authorized=false`
- `deployment_authorized=false`
- `production_modified=false`

Its digest is supplied by the operator, not independently attested by this
tool. The result does not prove the archive was taken during a genuine
write-freeze, that every offline device was reconciled, that media decrypts,
that a full isolated restore of all three volumes succeeds, or that the
previous image can safely read writes made after cutover.

A future separately approved private verification must bind the snapshot
digest to an authenticated acquisition receipt; import **that exact archive**
into fresh isolated restricted volumes; check the source key configuration and
all media decryptions using authorized methods; verify database/row identity
without publishing data; and pass the write-preserving rollback decision
policy. An isolated restore must not mount any existing production or
protected-preview volume.

The minimal published hotfix has not been deployed under this tool's
source-only approval. Keep security issue #25 and release-control issue #50
open until the live release and post-release security evidence exist.
