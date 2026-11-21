# Phase A — ephemeral Docker-volume encryption rehearsal

**Synthetic-only source qualification. No live backup or Docker operation.**

This experiment tests a future confidential three-volume backup design:
read bytes from three **test-created** Docker named volumes, stream them into
age encryption without writing a plaintext archive, then verify complete
recovery in isolated disposable directories.

The script verify_age_docker_volume_synthetic.py is for an **ephemeral GitHub
Actions Ubuntu runner only**. It accepts no paths, user archives, passphrases,
identity files or command-line parameters. It refuses Windows/remote Docker.
No Docker command is run on the user's actual host by this change.

## Test fixtures and boundaries

- Generate fabricated SQLite primary/log databases, fake persistent
  configuration and fake encrypted media under a throwaway directory.
- Create exactly three new Docker volumes, each uniquely named with the
  sat-synthonly prefix, GitHub run ID, and unpredictable 16-hex nonce.
  Require precise run-ID and nonce ownership labels on every volume.
- Use pinned public official Alpine image digest
  alpine@sha256:bc21487101ae47172509130ee1092cc273a831968d64b617776d1f69c81e42ab,
  checked with a read-only imagetools inspection on November 20, 2026.
  The copy container has no network, and mounts only the three new fake
  volumes and the fake input directory read-only.
- Take a second **read-only mount** of those same fake volumes. Docker tar
  stdout feeds age stdin using Python binary subprocess descriptors,
  shell=False, not PowerShell's text pipeline. Require success from BOTH
  Docker/tar and age. A plaintext tar.gz is never saved to disk.
- Keep ciphertext in a temporary output file until a full decrypt via
  two distinct fabricated age identities and both Go age and Rust rage.
  Stage four complete synthetic recoveries and verify SQLite integrity,
  foreign keys, expected fake table/rows, exact fake configuration/media,
  and the same recovered archive hash. Only then use an exclusive hard link
  to publish test ciphertext without overwriting existing files.
- Delete **only volumes created by this test run**, with exact run and
  nonce labels checked again before deletion. No Docker prune, lookup of
  production volumes, or prefix-based deletion. A label mismatch is a
  fail-closed condition, not permission to guess.
- Output only sanitized fake-data counts and explicit indicators that
  no real backup or production modification occurred.

The local unit tests intentionally do not call Docker. They check CLI
refusal, source environment restriction, volume ownership and cleanup,
read-only snapshot mounts, and refusal of external Docker endpoints.
The complete Docker-volume test runs on disposable hosted Linux CI.

## What this does not establish

This fixture does not stop a live service, inspect any real database,
read care/media records or encryption keys, reconcile offline caregiver
queues, select backup storage, restore actual volumes or deploy images.
It is not a production capture adapter and does not authorize Phase A.

Actual backup still requires an approved confidential destination,
two owner-held recoverable encryption identities, independently reviewed
capture tooling, verified all-caregiver and disconnected-device write freeze,
a separately authorized controlled interruption, and a complete private
checksum-pinned isolated restore proving historical care record/media/key
readability with write preservation. The protected preview stays untouched.

The minimal feedback attachment isolation hotfix is still published
but undeployed. Security issue #25, release issue #50, and key custody
issue #113 remain open.
