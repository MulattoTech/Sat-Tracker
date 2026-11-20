# Phase A — synthetic streaming tar-to-age rehearsal (NOT a live backup)

**Status: SOURCE-ONLY / SYNTHETIC / NO PRODUCTION ACQUISITION.** This test
does not accept a path, backup destination, Docker volume, real identity,
password or command-line option. It refuses execution outside the named
GitHub Actions repository and disposable Linux/Windows runners.

## Objective

Existing scripts/backup.ps1 stops and restarts the production sprout service
and creates a plaintext archive containing the production db/env/files
volumes, including care records and persistent encryption configuration.
This is not authorized by source-only continuation and must **not** run on
an unverified disk.

scripts/verify_age_pipe_synthetic.py is an explicitly **non-production**
rehearsal of a safer principle: put the raw tar.gz bytes directly from a
native tar subprocess stdout into a **separate native age stdin**, without
passing binary bytes through PowerShell's text pipeline and without writing a
plaintext tar.gz intermediate. Both subprocesses receive argument arrays,
not a shell command or a user-supplied root. Its only input is a fresh
fabricated three-folder directory created under a restricted temporary
directory.

The test must establish all of:

- Both tar and age subprocesses return success. An exit-zero encryptor after
  a failed or partial tar is **not** sufficient.
- Encryption first writes a temporary ciphertext-only file, and failure
  removes it. Never overwrite or silently replace an existing destination.
- Before publishing the synthetic ciphertext, **both Go age and separate
  Rust rage** must decrypt it with **two disposable synthetic recipient
  identities** and return the same archive hash.
- Both disposable SQLite databases must pass integrity and foreign-key
  checks; fake env keys and fake media members must be present.
- The final ciphertext is published with an exclusive no-overwrite file
  link only after successful end-of-stream and full fake-data checks.
- No plaintext tar.gz archive file exists at any point in the test-owned
  directory; all temporary test material is removed after the run.
- Missing fake volumes, unexpected paths, symlinks, expired subprocess
  deadlines, missing executables, partial tar failure, and pre-existing
  ciphertext output block publication.

Run the unit-level fail-closed checks (no age executable required):

    python -m unittest discover -s tests/ops -p test_age_pipe_synthetic.py -v

The dedicated age-backup-synthetic.yml workflow exercises the real native
tar-to-age stream using the already pinned age v1.3.2 and rage v0.12.1
executables on disposable Ubuntu and Windows runners.

## What this does NOT authorize

The test-owned source folder is not a volume mount and the test has **no
Docker invocation**. It does not establish that a production Docker snapshot
is quiescent, that a real stream can be captured safely, that every
offline caregiver outbox is reconciled, that a confidential destination and
owner-managed recovery identities exist, or that encrypted family media
can be restored and read.

Do NOT reuse these fake keys or write real private identities into GitHub
Actions artifacts. Do NOT pipe a failed decryption into production:
authenticated streaming decoders can emit early plaintext before a late
integrity failure. Future real recovery must use isolated staging, successful
final process completion, exact digest and full SQLite/media/key checks.

Before a real production backup, require a separately reviewed and approved
capture implementation, verified confidential destination, owner-controlled
two-recipient key custody with recovery drills, explicit caregiver write-freeze
including offline devices, explicit permission for a controlled production
stop/restart, and a private checksum-pinned full three-volume isolated restore
without touching the protected preview. Later hotfix deployment requires
a separate approval and must never erase post-snapshot care writes.

This source-only qualification does **not** deploy the minimal attachment
authorization security hotfix. Privacy issue #25, release #50, and encryption
design/custody #113 remain open.
