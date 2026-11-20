# Sat-Tracker Phase A: standard age format qualification (synthetic-only)

**Status: FORMAT EVALUATION / NO LIVE BACKUP.** This design note evaluates a
standard encrypted-file format against the experimental custom SATBKUP1
envelope in draft PR #112. It is neither an approval to back up household
records nor authorization to interrupt, restore, or deploy the live app.

## Decision direction: prefer standard age recipient encryption

The [age C2SP file specification](https://c2sp.org/age) defines authenticated,
binary-safe streamed file encryption and multiple recipients. The
[official age CLI manual](https://github.com/FiloSottile/age/blob/main/doc/age.1.html)
defines encryption to recipients, passphrase mode, and standard-input/output
handling. The standard format permits decryption outside this particular
repository or custom Python code.

Our recommended *candidate* is recipient-based age encryption, not a custom
SATBKUP1-only format or an unencrypted tarball. A proposed owner-controlled
design is to encrypt each backup to **two distinct public recipients**:

- A primary identity that remains accessible for authorized recovery.
- A physically/logically separate offline recovery identity retained
  by the owner, not in GitHub, application configuration or backup media.

The public recipient strings are not private keys, but their storage and
exposure should still be reviewed. The corresponding **private identities**
must be generated, stored and recovered using an independently reviewed
process. No real identities or passwords are created or stored by this PR.

age also supports an interactive passphrase mode, but the format specification
does **not** allow mixing scrypt passphrase stanzas with other recipient
stanzas. Therefore our multi-recipient candidate deliberately avoids
`--passphrase`. A recovery identity provides a second independently
usable key instead.

## Synthetic reproducible format experiment

`scripts/verify_age_backup_synthetic.py` has **no user archive, Docker
volume, encryption-key, filesystem destination, or production options**.
It uses only fake data generated inside a disposable temporary directory.
It will fail closed if the official `age` and `age-keygen` executables
are unavailable or report an unexpected version.

The [dedicated CI workflow](../.github/workflows/age-backup-synthetic.yml)
qualifies the fake-data recipe on **two disposable GitHub runner operating
systems**. Linux builds official Go `filippo.io/age` **v1.3.2** and downloads
Rust `rage` **v0.12.1**, verifying official release SHA-256
`c5d7ab41fbf1213590e89721fd2b8eb122e84518c155ce35866f1c5759a3a29f`.
The separate Windows runner downloads the official age and rage Windows
archives and verifies SHA-256 digests
`f48d8f8f9ebe903ab5027ed067652f2cc1db94bc206976430133b905dcd8e8c7`
and `da5b8111c8f097c7822df505ad504696e4891ff8adec06a39171f8d717590b2c`
respectively. These are pinned to the respective official GitHub release
assets; no software is installed on the user's Windows host. The experiment:

1. Creates two artificial SQLite databases, fake configuration names and
   artificial media, packed into `db/`, `env/`, and `files/` members.
2. Generates three **throwaway** age identities; only two become authorized
   recipients and the third is deliberately unrelated.
3. Sends the fabricated tar.gz over a binary pipe to `age`; a plaintext
   archive **is never written to disk** by this experiment.
4. Verifies each recipient identity recovers **exactly the same bytes**
   using both the **Go age** and **Rust rage** decryption implementations,
   with SQLite integrity and foreign-key checks on disposable recovered fake
   databases. It also encrypts with Rust rage and decrypts with Go age.
5. Verifies the unrelated identity cannot decrypt in either implementation;
   independently verifies both reject tampered and truncated fake ciphertext.
6. Deletes the entire test-owned directory, including fake identities.
   The test reports counts and booleans only—not private key material,
   public recipient values, plaintext, or full paths.

The workflow has no production domain access, no deployment credentials,
no Docker volume mounts and no real backup inputs. Building the pinned CLI
requires ordinary Go module downloads. It does not attempt to turn the
historical `scripts/backup.ps1` (which stops and restarts production and
writes plaintext) into a live acquisition pipeline.

## What this does and does not prove

Passing synthetic age tests is promising evidence of **format
interoperability across the official Go age and separate Rust rage CLI
implementations** and recovery by two distinct test identities. This
qualifies *synthetic* cross-implementation recovery on each GitHub CI OS
when both jobs pass. Each runner creates its **own** fake archive and keys;
this does **not** transfer the exact same encrypted artifact between Windows
and Linux or prove a production recovery across distinct hardware.
Do not call this an audited backup or a successful restoration of real care
records, image encryption configuration, or encrypted media.

**Important streaming-decryption boundary:** a decrypting CLI can output
partial plaintext before detecting a damaged later chunk or truncated final
chunk. Never stream recovered bytes directly into production volumes or treat
partial output as a restored backup. A future restored-data pipeline must
stage to an isolated disposable area, require a successful final decryption
exit, independently validate bytes and data, and only then consider a
separately approved restoration. Likewise, ciphertext producers must avoid
publishing incomplete output before a verified successful exit.

Before using this approach with sensitive family data:

- Independently verify official binary provenance, fixed age CLI version,
  and a secure installation method on the production host.
- Create and independently recover the **two owner-controlled private age
  identities** without ever placing them in chat, GitHub, CI, application
  environment volumes, backup media or other unsafe locations.
- Obtain a private destination and an explicitly approved live caregiver
  write freeze, including offline/outbox reconciliation across all devices.
- Build and independently review a **binary-safe Docker volume snapshot to
  encrypted age output**. No transient plaintext tar on an unverified drive.
- Keep the original three production volumes and protected preview
  isolated. Restore one pinned encrypted archive to **new disposable
  volumes**, verify both SQLite databases, WAL/foreign keys, persistent key
  identity, retained media decryptability and every historical care record.
- Require a new, itemized authorization for actual downtime or backup, and
  another authorization for production image cutover. A snapshot rollback
  must never erase newer post-snapshot care records.

The custom-envelope PR #112 remains an **unapproved prototype**; the age
design decision should be made before enabling any backup producer. This
source package does not enable any producer, restore operation, backup
acquisition, or hotfix deployment. Security issue #25 and release issue
#50 remain open.
