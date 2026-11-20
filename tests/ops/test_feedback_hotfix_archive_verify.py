"""Synthetic-only tests for pinned offline archive validation. Never uses live data."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "scripts" / "feedback_hotfix_archive_verify.py"
spec = importlib.util.spec_from_file_location("archive_check", SOURCE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class PinnedArchiveTests(unittest.TestCase):
    def setUp(self):
        self.workspace = tempfile.TemporaryDirectory(prefix="sat-synthetic-archive-")
        self.root = Path(self.workspace.name)
        self.counter = 0
        self.entries = self.standard_entries()

    def tearDown(self):
        self.workspace.cleanup()

    def db_file(self, label, bad_fk=False):
        location = self.root / (label + ".db")
        con = sqlite3.connect(location)
        try:
            con.execute("CREATE TABLE parent(id INTEGER PRIMARY KEY, description TEXT)")
            con.execute("CREATE TABLE care(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id), amount INTEGER)")
            con.execute("INSERT INTO parent VALUES (1,'FAKE_PARENT')")
            con.execute("INSERT INTO care VALUES (1,1,95)")
            if bad_fk:
                con.execute("INSERT INTO care VALUES (2,999,80)")
            con.commit()
        finally:
            con.close()
        return location.read_bytes()

    def standard_entries(self):
        return [
            ("db/", None, None),
            ("db/baby-tracker.db", self.db_file("main"), None),
            ("db/baby-tracker-logs.db", self.db_file("logs"), None),
            ("env/", None, None),
            ("env/.env", b'ENC_HASH="synthetic-not-a-real-key"\nJWT_SECRET="synthetic-only"\n', None),
            ("files/", None, None),
            ("files/synthetic.enc", b"not-real-encrypted-media-fixture", None),
        ]

    def create(self, entries=None, raw_content=None):
        self.counter += 1
        path = self.root / ("archive-%03d.tar.gz" % self.counter)
        if raw_content is not None:
            path.write_bytes(raw_content)
        else:
            with tarfile.open(path, "w:gz") as tar:
                for name, contents, entry_type in (entries if entries is not None else self.entries):
                    info = tarfile.TarInfo(name)
                    info.mtime = 0
                    if entry_type:
                        info.type = entry_type
                        if entry_type in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                            info.linkname = "../../outside"
                    elif contents is None:
                        info.type = tarfile.DIRTYPE
                        info.mode = 0o700
                    if contents is not None and info.type == tarfile.REGTYPE:
                        info.size = len(contents)
                        tar.addfile(info, io.BytesIO(contents))
                    else:
                        tar.addfile(info)
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    def assert_block(self, entries=None, code=None, raw_content=None):
        archive, sha = self.create(entries, raw_content)
        with self.assertRaises(mod.Blocked) as context:
            mod.verify(archive, sha)
        if code:
            self.assertEqual(str(context.exception), code)
        return archive, sha

    def test_good_archive_has_correct_roots_and_counts_but_never_authorizes_restore(self):
        archive, sha = self.create()
        result = mod.verify(archive, sha)
        self.assertEqual(result["status"], "OFFLINE_ARCHIVE_BYTES_VERIFIED")
        self.assertTrue(result["all_three_roots_present"])
        self.assertTrue(result["both_sqlite_integrity_and_fk_verified"])
        self.assertTrue(result["required_secret_key_names_present"])
        self.assertEqual(result["media_file_count"], 1)
        self.assertEqual(result["sqlite_table_count"], 4)
        for flag in ("media_decryption_verified", "live_snapshot_consistency_proven",
                     "private_backup_restore_approved", "production_restore_authorized",
                     "deployment_authorized", "production_modified"):
            self.assertFalse(result[flag])

    def test_sha_is_mandatory_and_must_be_64_hex(self):
        archive, _ = self.create()
        for wrong in ("", "0", "b"*63, "g"*64, "A"*64):
            with self.subTest(wrong=wrong), self.assertRaises(mod.Blocked) as context:
                mod.verify(archive, wrong)
            self.assertEqual(str(context.exception), "EXPECTED_SHA256_REQUIRED")

    def test_archive_digest_change_is_blocked_before_reading_tar(self):
        archive, sha = self.create()
        with archive.open("ab") as f:
            f.write(b"tampering")
        with self.assertRaises(mod.Blocked) as context:
            mod.verify(archive, sha)
        self.assertEqual(str(context.exception), "PINNED_SHA256_MISMATCH")

    def test_missing_archive_blocked(self):
        with self.assertRaises(mod.Blocked):
            mod.verify(self.root / "no-private-data.tar.gz", "a"*64)

    def test_directory_is_not_regular_archive(self):
        with self.assertRaises(mod.Blocked) as context:
            mod.verify(self.root, "a"*64)
        self.assertEqual(str(context.exception), "ARCHIVE_NOT_REGULAR_FILE")

    def test_symlink_archive_refused(self):
        original, sha = self.create()
        link = self.root / "alias.tar.gz"
        try:
            link.symlink_to(original)
        except OSError:
            self.skipTest("OS cannot create filesystem symlinks")
        with self.assertRaises(mod.Blocked) as context:
            mod.verify(link, sha)
        self.assertEqual(str(context.exception), "ARCHIVE_NOT_REGULAR_FILE")

    def test_empty_archive_refused(self):
        self.assert_block(raw_content=b"", code="ARCHIVE_NOT_REGULAR_FILE")

    def test_not_a_tar_archive_refused(self):
        self.assert_block(raw_content=b"not a tar", code="ARCHIVE_CONTENT_INVALID")

    def test_truncated_gzip_refused_with_its_own_current_digest(self):
        archive, _ = self.create()
        data = archive.read_bytes()
        self.assert_block(raw_content=data[:len(data)//2], code="ARCHIVE_CONTENT_INVALID")

    def test_missing_media_root_even_if_no_media_required_is_blocked(self):
        self.assert_block([entry for entry in self.entries if not entry[0].startswith("files/")],
                          "THREE_VOLUME_ROOTS_INCOMPLETE")

    def test_empty_media_volume_is_only_byte_validated_not_decryption_qualified(self):
        entries = [entry for entry in self.entries if entry[0] != "files/synthetic.enc"]
        archive, sha = self.create(entries)
        result = mod.verify(archive, sha)
        self.assertEqual(result["media_file_count"], 0)
        self.assertFalse(result["media_decryption_verified"])

    def test_missing_primary_database_refused(self):
        self.assert_block([entry for entry in self.entries if entry[0] != "db/baby-tracker.db"],
                          "REQUIRED_FILES_MISSING")

    def test_missing_log_database_refused(self):
        self.assert_block([entry for entry in self.entries if entry[0] != "db/baby-tracker-logs.db"],
                          "REQUIRED_FILES_MISSING")

    def test_missing_environment_file_refused(self):
        self.assert_block([entry for entry in self.entries if entry[0] != "env/.env"],
                          "REQUIRED_FILES_MISSING")

    def test_env_without_required_secret_names_refused(self):
        entries = [(name, b"TZ=UTC\n" if name == "env/.env" else raw, kind)
                   for name, raw, kind in self.entries]
        self.assert_block(entries, "PERSISTENT_CONFIG_KEYS_MISSING_OR_DUPLICATE")

    def test_env_with_duplicate_key_refused(self):
        entries = [(name, raw + b"ENC_HASH=duplicate\n" if name == "env/.env" else raw, kind)
                   for name, raw, kind in self.entries]
        self.assert_block(entries, "PERSISTENT_CONFIG_KEYS_MISSING_OR_DUPLICATE")

    def test_empty_secret_value_refused(self):
        entries = [(name, b"ENC_HASH=\nJWT_SECRET=synthetic\n" if name == "env/.env" else raw, kind)
                   for name, raw, kind in self.entries]
        self.assert_block(entries, "PERSISTENT_CONFIG_KEYS_MISSING_OR_DUPLICATE")

    def test_archive_extra_root_refused(self):
        self.assert_block(self.entries + [("unrelated/private", b"data", None)], "UNEXPECTED_ARCHIVE_ROOT")

    def test_directory_traversal_refused(self):
        self.assert_block(self.entries + [("files/../../outside", b"data", None)], "UNSAFE_MEMBER_NAME")

    def test_absolute_name_refused(self):
        self.assert_block(self.entries + [("/private/file", b"data", None)], "UNSAFE_MEMBER_NAME")

    def test_windows_backslash_path_refused(self):
        self.assert_block(self.entries + [("files\\evil", b"data", None)], "UNSAFE_MEMBER_NAME")

    def test_symlink_member_refused(self):
        self.assert_block(self.entries + [("files/escape", None, tarfile.SYMTYPE)],
                          "UNSAFE_TAR_MEMBER_TYPE")

    def test_hardlink_member_refused(self):
        self.assert_block(self.entries + [("files/copy", None, tarfile.LNKTYPE)],
                          "UNSAFE_TAR_MEMBER_TYPE")

    def test_duplicate_member_refused(self):
        self.assert_block(self.entries + [("files/synthetic.enc", b"another", None)],
                          "DUPLICATE_OR_CASE_COLLIDING_MEMBER")

    def test_case_colliding_member_refused(self):
        self.assert_block(self.entries + [("files/SYNTHETIC.enc", b"another", None)],
                          "DUPLICATE_OR_CASE_COLLIDING_MEMBER")

    def test_invalid_sqlite_blocked(self):
        entries = [(name, b"garbage.sqlite" if name == "db/baby-tracker.db" else raw, kind)
                   for name, raw, kind in self.entries]
        self.assert_block(entries, "SQLITE_INTEGRITY_FAILED")

    def test_sqlite_foreign_key_failure_blocked(self):
        entries = [(name, self.db_file("bad", True) if name == "db/baby-tracker.db" else raw, kind)
                   for name, raw, kind in self.entries]
        self.assert_block(entries, "SQLITE_FOREIGN_KEY_FAILED")

    def test_tar_with_accepted_dot_prefix(self):
        entries = [("./" + name, raw, kind) for name, raw, kind in self.entries]
        path, sha = self.create(entries)
        self.assertEqual(mod.verify(path, sha)["status"], "OFFLINE_ARCHIVE_BYTES_VERIFIED")

    def test_cli_synthetic_returns_only_safe_fields(self):
        archive, sha = self.create()
        r = subprocess.run([sys.executable, str(SOURCE), "--archive", str(archive),
                            "--sha256", sha, "--synthetic"], capture_output=True,
                           text=True, timeout=15)
        self.assertEqual(r.returncode, 0, r.stderr)
        output = json.loads(r.stdout)
        self.assertEqual(output["mode"], "SYNTHETIC")
        self.assertNotIn("FAKE_PARENT", r.stdout)
        self.assertNotIn("synthetic-not-a-real-key", r.stdout)
        self.assertNotIn("synthetic.enc", r.stdout)
        self.assertFalse(output["production_restore_authorized"])

    def test_cli_apply_is_unknown(self):
        archive, sha = self.create()
        r = subprocess.run([sys.executable, str(SOURCE), "--archive", str(archive),
                            "--sha256", sha, "--apply"], capture_output=True, text=True, timeout=15)
        self.assertNotEqual(r.returncode, 0)

    def test_cli_bad_digest_fails_closed_without_paths(self):
        archive, _ = self.create()
        r = subprocess.run([sys.executable, str(SOURCE), "--archive", str(archive),
                            "--sha256", "c"*64, "--synthetic"], capture_output=True,
                           text=True, timeout=15)
        self.assertEqual(r.returncode, 2)
        self.assertEqual(json.loads(r.stdout)["reason"], "PINNED_SHA256_MISMATCH")
        self.assertNotIn(str(archive), r.stdout)


if __name__ == "__main__":
    unittest.main()
