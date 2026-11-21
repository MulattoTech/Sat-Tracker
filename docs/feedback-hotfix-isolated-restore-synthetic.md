# Sat-Tracker Phase A: isolated synthetic encrypted restore qualification

**SOURCE ONLY — FAKE DATA ONLY — NO PRODUCTION BACKUP OR RESTORE.**

This work extends the binary tar-to-age streaming rehearsal with an isolated
restore checkpoint. It cannot read, stop, restart, mount, restore or deploy a
live Docker service or a private family backup.

A streaming decryptor can emit early plaintext before later authentication
fails. Therefore, this test requires a fully successful age CLI exit and
complete recovery verification before any fake data is staged.

## Synthetic qualification

The Python tool scripts/verify_age_isolated_restore_synthetic.py accepts no
archive paths or arguments, and runs only in the named ephemeral GitHub
Actions Linux/Windows environment. It generates fabricated primary and log
SQLite databases, fake configuration, and fake media, then:

1. Streams a fabricated three-folder tar directly into age using native
   subprocess file descriptors; never writes a plaintext tar archive.
2. Decrypts the fake ciphertext four times, using both Go age and Rust rage
   under two separate throwaway synthetic identities.
3. Requires successful completion of each decryptor before staging any
   recovered file, and checks the exact recovered tar SHA-256.
4. Rejects links, traversal, unknown or duplicate names, missing or
   oversized members and malformed archives using a strict four-file and
   three-directory allowlist.
5. Checks all recovered file contents before creating a new temporary
   isolated directory, then verifies both SQLite databases on disk with
   integrity and foreign-key checks and exact fake data row counts.
6. Checks the fabricated persistent configuration and media bytes exactly,
   and cleans only test-owned staging directories after failures.
7. Removes the entire disposable fixture, including all fake identities.

The dedicated synthetic age CI runs this test on both Linux and Windows.
Local fail-closed policy tests require no age executable.

    python -m unittest discover -s tests/ops -p test_age_isolated_restore_synthetic.py -v

## Critical limitations

This is a test-owned filesystem directory, not a Docker restore or proof
of real family data preservation. The test-only fake keys and fake media
are not real persistent encryption keys or photographs.

This test does not enable production acquisition, private backup storage,
real identity custody or hotfix deployment. A later production procedure
requires separate owner confirmation of a caregiver/offline-device write
freeze, approved confidential destination and recoverable identities,
binary-safe quiesced source capture without plaintext temporary storage,
a checksum-pinned private isolated three-volume restore, successful
media/key/record checks, and distinct approval for cutover.

Never send actual private age identities or household records to GitHub
Actions artifacts. Never decrypt partial output into production volumes.
Open privacy issue #25 and release/readiness issues #50/#113 remain open.
