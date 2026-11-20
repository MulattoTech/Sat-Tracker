# Sat-Tracker Phase A — encrypted backup envelope preparation (source only)

**Status: NOT AN APPROVED LIVE BACKUP.** This is a standalone,
non-deploying source prototype and synthetic acceptance suite. It does not
capture a production volume, start or stop a container, choose a private
storage destination, read household data, create or retain a real passphrase,
or authorize a restore or production cutover.

## Reason for this package

Existing `scripts/backup.ps1` stops and restarts `babytracker-sprout`, then
creates a **plaintext** `tar.gz` from the production `db`, `env`, and `files`
volumes. The environment volume includes persistent encryption and login keys.
Copying that plaintext archive to a disk with unknown encryption/protection
would create an unnecessary confidentiality risk.

The Windows host has cryptography and Argon2 packages; synthetic AES-256-GCM
and Argon2id verification passed. Windows BitLocker status remains **UNKNOWN**
because the status queries were denied. Storage capacity alone is not an
acceptable confidentiality control.

## New prototype: streaming authenticated encryption

`scripts/feedback_hotfix_encrypted_archive.py` implements a narrowly scoped
encrypted archive envelope:

- 1 MiB chunks, each encrypted using AES-256-GCM with a distinct nonce and
  authenticated header, chunk type and exact sequence index.
- 256-bit key derived from a private passphrase using Argon2id with fixed
  64 MiB memory, three iterations, one lane and a random 128-bit salt.
- A separately authenticated final record containing the exact byte/chunk
  counts; reject missing/truncated/swapped frames, appended data, malformed
  headers, modified KDF parameters and any failed authentication.
- A distinct 96-bit nonce per chunk, combining a random prefix and monotonic
  64-bit counter. No nonce reuse within one archive.
- Exclusive, no-overwrite ciphertext file publishing *only after* a full
  decrypt-and-authenticate pass; temporary output consists solely of
  ciphertext and is cleaned after failure. Passwords are never accepted on
  command lines, in environment variables or printed in logs.
- Read-only `--verify-only` mode authenticates a previously encrypted file
  from an interactive private terminal without ever extracting plaintext.
  The reported SHA-256 is computed on the **same open file stream** that was
  authenticated, rather than reopening its path after verification. Open-time
  file identity and size are checked to reject replacement between the
  filesystem identity check and opening the file. Invalid CLI options refuse
  without echoing unexpected argument text.

The `.satenc` format is a private internal v1 envelope, not an interchangeable
ZIP, age, GPG or VeraCrypt archive. Do not rely on it as the **only** recoverable
copy until independent cryptographic and cross-machine restore review succeeds.
A strong unique passphrase must have an **independently verified recovery
method**, kept out of Git, chat, Docker logs and workflow artifacts.

The Python streaming core is used in tests with fabricated input. Its
`--encrypt-stdin` command is intentionally **blocked**, returning
`PRODUCTION_ACQUISITION_ADAPTER_NOT_APPROVED`. There is no authorized
producer/consumer pipeline for a real production archive yet. Do not create a
plaintext archive as a workaround. The `--verify-only` command cannot decrypt
to disk or perform a restore.

## Synthetic qualification

The test dependencies are pinned in
`scripts/requirements-encrypted-backup.txt`. The GitHub operations workflow
installs them on its ephemeral runner before running the existing complete
operations suite. Windows local dependency versions match these pins.

Run the dedicated new source tests without Docker or household data:

```powershell
python -m unittest discover -s tests/ops -p test_feedback_hotfix_encrypted_archive.py -v
```

The tests cover one- and two-frame roundtrips, authenticated final markers,
wrong passwords, bit flips, truncation, reordering, a malicious KDF header,
unrecognized fields, size limits, file collision refusal, temporary ciphertext
cleanup, safe CLI error output and symlink rejection where the OS permits it.
Additional synthetic checks use a **separately written, test-only decoder**
to recover the original bytes from a multiple-frame envelope and refuse wrong
passwords/tampering; they also verify the digest is calculated from the same
open file and detect a simulated file replacement during open. This does not
constitute independent cryptographic review or true cross-machine recovery.
The Linux-hosted suite must run the symlink case; a Windows permissions skip
must be reported rather than counted as executed.

## Separate outstanding release gates

Before **any** live acquisition, require all of the following:

1. A specific caregiver-synchronized write freeze (including all offline
   queues, unsent medication/diaper/feed/sleep entries, and active timers).
2. A private designated destination, with confidentiality/authentication
   controls, verified recoverability of the passphrase, and independent
   recovery storage; volume encryption status alone is insufficient.
3. Independently reviewed, synthetic-tested streaming acquisition that
   captures the exact three production volumes consistently **without a
   transient plaintext archive on an unverified disk**. Existing
   `scripts/backup.ps1` does not satisfy this requirement.
4. A separately itemized approval for any actual production stop/restart and
   private data acquisition, including expected interruption and rollback.
5. Verified checksum-pinned, *private isolated* archive decryption and restore,
   intact DB and WAL/foreign keys, persistent key identity, ciphertext/media
   readability, all record preservation and recorded cleanup, using no
   production or protected-preview mounts.

**Do not run** the existing production backup or promotion scripts under this
source-only package. This prototype does not change either live service and
does not patch the deployed feedback-attachment authorization defect. Issue
#25 remains open until the separately approved, pinned minimal hotfix is
activated and its family-isolation checks pass; issue #50 tracks release
readiness.

**No actual family data, encryption keys, real backup, production volumes or
live containers were read, stopped, altered, copied or restarted.**
