"""Fail-closed policy checks: no Docker execution or real volumes in tests."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location(
    "sat_fake_docker_age", ROOT / "scripts" / "verify_age_docker_volume_synthetic.py"
)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


class FakeDockerAgePolicy(unittest.TestCase):
    def setUp(self):
        self.run = "123456789"
        self.nonce = "0123456789abcdef"
        self.names = mod.fake_volume_names(self.run, self.nonce)

    def test_deterministic_synthetic_only_volume_names(self):
        self.assertEqual(set(self.names), {"db", "env", "files"})
        self.assertEqual(len(set(self.names.values())), 3)
        for name in self.names.values():
            self.assertTrue(name.startswith("sat-synthonly-123456789-"))
            self.assertNotIn("babytracker-sprout", name)

    def test_invalid_name_identity_fails_closed(self):
        for value in ("", "../x", "abc", "1234567890" * 4):
            with self.subTest(value=value), self.assertRaises(mod.QualificationError):
                mod.fake_volume_names(value, self.nonce)
        for value in ("a" * 15, "A" * 16, "../../../file"):
            with self.subTest(value=value), self.assertRaises(mod.QualificationError):
                mod.fake_volume_names(self.run, value)

    def test_non_ci_environment_refused(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(mod.QualificationError) as exc:
                mod.require_ephemeral_ci()
        self.assertEqual(str(exc.exception), "NAMED_EPHEMERAL_CI_ONLY")

    def test_wrong_repository_or_os_refused(self):
        base = {"GITHUB_ACTIONS": "true", "GITHUB_RUN_ID": self.run,
                "GITHUB_REPOSITORY": mod.REPO, "RUNNER_OS": "Linux"}
        for key, value in (
            ("GITHUB_REPOSITORY", "incorrect/project"),
            ("RUNNER_OS", "Windows"),
            ("GITHUB_RUN_ID", "not a run"),
            ("GITHUB_ACTIONS", "false"),
        ):
            test = dict(base, **{key: value})
            with self.subTest(key=key), patch.dict(os.environ, test, clear=True):
                with self.assertRaises(mod.QualificationError):
                    mod.require_ephemeral_ci()

    def test_remote_docker_endpoint_refused(self):
        base = {"GITHUB_ACTIONS": "true", "GITHUB_RUN_ID": self.run,
                "GITHUB_REPOSITORY": mod.REPO, "RUNNER_OS": "Linux"}
        for key in ("DOCKER_HOST", "DOCKER_CONTEXT"):
            with self.subTest(key=key):
                test = dict(base, **{key: "tcp://untrusted"})
                with patch.dict(os.environ, test, clear=True):
                    with self.assertRaises(mod.QualificationError):
                        mod.require_ephemeral_ci()

    def test_valid_synthetic_ci_environment(self):
        with patch.dict(os.environ, {
            "GITHUB_ACTIONS": "true",
            "GITHUB_REPOSITORY": mod.REPO,
            "RUNNER_OS": "Linux",
            "GITHUB_RUN_ID": self.run,
        }, clear=True):
            self.assertEqual(mod.require_ephemeral_ci(), self.run)

    def test_snapshot_mount_names_are_explicit_and_read_only(self):
        mount = mod._mounts(self.names, readonly=True)
        self.assertEqual(mount.count("--mount"), 3)
        mounts = [mount[i + 1] for i, v in enumerate(mount) if v == "--mount"]
        self.assertTrue(all("readonly" in arg for arg in mounts))
        self.assertTrue(all(name in " ".join(mount) for name in self.names.values()))
        self.assertNotIn("babytracker", " ".join(mount))

    def test_population_mounts_are_not_readonly(self):
        mount = mod._mounts(self.names, readonly=False)
        self.assertEqual(mount.count("--mount"), 3)
        self.assertNotIn("readonly", " ".join(mount))

    def test_unknown_volume_name_blocked_before_inspection(self):
        with patch.object(mod, "labels_for") as check:
            with self.assertRaises(mod.QualificationError) as exc:
                mod.assert_owned("babytracker-sprout-db", self.run, self.nonce)
        self.assertEqual(str(exc.exception), "UNOWNED_VOLUME_NAME")
        check.assert_not_called()

    def test_missing_synthetic_label_blocks_cleanup(self):
        with patch.object(mod, "labels_for", return_value={mod.LABEL: "false"}):
            with self.assertRaises(mod.QualificationError) as exc:
                mod.assert_owned(self.names["db"], self.run, self.nonce)
        self.assertEqual(str(exc.exception), "UNOWNED_VOLUME_LABELS")

    def test_wrong_run_label_blocks_cleanup(self):
        bad = {mod.LABEL: "true", mod.RUN_LABEL: "other", mod.NONCE_LABEL: self.nonce}
        with patch.object(mod, "labels_for", return_value=bad):
            with self.assertRaises(mod.QualificationError):
                mod.assert_owned(self.names["files"], self.run, self.nonce)

    def test_exact_owned_cleanup_only_removes_created_names(self):
        good = {mod.LABEL: "true", mod.RUN_LABEL: self.run,
                mod.NONCE_LABEL: self.nonce}
        with patch.object(mod, "labels_for", return_value=good):
            with patch.object(mod, "docker") as docker:
                mod.cleanup_exact_owned_volumes(
                    self.names, [self.names["db"], self.names["env"]],
                    self.run, self.nonce
                )
        self.assertEqual(docker.call_count, 2)
        self.assertEqual([c.args[0] for c in docker.call_args_list],
                         [["volume", "rm", self.names["env"]],
                          ["volume", "rm", self.names["db"]]])

    def test_cleanup_refuses_uncreated_volume(self):
        with patch.object(mod, "docker") as docker:
            with self.assertRaises(mod.QualificationError):
                mod.cleanup_exact_owned_volumes(
                    self.names, ["babytracker-sprout-env"], self.run, self.nonce
                )
        docker.assert_not_called()

    def test_cli_rejects_real_paths_or_keys_without_echo(self):
        token = "NEVER_PRIVATE_BACKUP_LOCATION"
        p = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "verify_age_docker_volume_synthetic.py"),
             "--volume", token], capture_output=True, text=True, timeout=10
        )
        self.assertEqual(p.returncode, 2)
        self.assertEqual(json.loads(p.stdout)["reason"],
                         "NO_USER_DOCKER_OR_BACKUP_ARGUMENTS_ALLOWED")
        self.assertNotIn(token, p.stdout + p.stderr)

    def test_cli_outside_ci_fails_before_any_docker(self):
        with patch.dict(os.environ, {}, clear=True):
            with patch.object(mod, "docker") as run:
                with self.assertRaises(mod.QualificationError):
                    mod.check()
                run.assert_not_called()

    def test_script_contains_only_synthetic_volume_prefix(self):
        source = (ROOT / "scripts" / "verify_age_docker_volume_synthetic.py").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("babytracker-sprout-db", source)
        self.assertNotIn("babytracker-ocr-staging", source)
        self.assertNotIn("docker volume prune", source)
        self.assertIn("sat-synthonly-", source)
        self.assertIn("NAMED_EPHEMERAL_CI_ONLY", source)


if __name__ == "__main__":
    unittest.main()
