#!/usr/bin/env python3
"""CI-owned fake Docker volumes -> age encryption -> isolated fake recovery.

NO user paths, keys or arguments. Only GitHub's ephemeral Linux CI runner
for MulattoTech/Sat-Tracker is allowed. This test never addresses, discovers,
opens, mounts or removes any actual babytracker production/staging volume.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import uuid

from verify_age_backup_synthetic import QualificationError, _recipient, _run
from verify_age_pipe_synthetic import create_fake_volumes
from verify_age_isolated_restore_synthetic import isolated_restore_fake_archive

REPO = "MulattoTech/Sat-Tracker"
IMAGE = "alpine@sha256:bc21487101ae47172509130ee1092cc273a831968d64b617776d1f69c81e42ab"
LABEL = "org.mtech.sat-tracker.synthetic"
RUN_LABEL = "org.mtech.sat-tracker.test-run"
NONCE_LABEL = "org.mtech.sat-tracker.test-nonce"
KINDS = ("db", "env", "files")
MAX_CIPHERTEXT_BYTES = 4 * 1024 * 1024
MAX_FAKE_TAR_BYTES = 2 * 1024 * 1024
PROCESS_TIMEOUT = 100


def require_ephemeral_ci() -> str:
    """This is test fixture code; fail closed on the owner's Windows host."""
    run = os.getenv("GITHUB_RUN_ID", "")
    if (os.getenv("GITHUB_ACTIONS") != "true"
            or os.getenv("GITHUB_REPOSITORY") != REPO
            or os.getenv("RUNNER_OS") != "Linux"
            or not re.fullmatch(r"[0-9]{1,20}", run)
            or os.getenv("DOCKER_HOST")
            or os.getenv("DOCKER_CONTEXT")):
        raise QualificationError("NAMED_EPHEMERAL_CI_ONLY")
    return run


def fake_volume_names(run: str, nonce: str) -> dict[str, str]:
    if not re.fullmatch(r"[0-9]{1,20}", run) or not re.fullmatch(r"[a-f0-9]{16}", nonce):
        raise QualificationError("INVALID_FAKE_DOCKER_IDENTITY")
    return {kind: f"sat-synthonly-{run}-{nonce}-{kind}" for kind in KINDS}


def docker(args: list[str], *, success: bool = True) -> subprocess.CompletedProcess[bytes]:
    # Never expose CLI stderr, which may contain environment-specific details.
    try:
        result = subprocess.run(
            ["docker", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=PROCESS_TIMEOUT, shell=False, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        raise QualificationError("SYNTHETIC_DOCKER_UNAVAILABLE") from None
    if success and result.returncode != 0:
        raise QualificationError("SYNTHETIC_DOCKER_STAGE_FAILED")
    return result


def labels_for(name: str) -> dict[str, str]:
    result = docker(["volume", "inspect", "--format", "{{json .Labels}}", name])
    try:
        labels = json.loads(result.stdout)
        if not isinstance(labels, dict):
            raise ValueError
        return labels
    except (ValueError, UnicodeError):
        raise QualificationError("SYNTHETIC_VOLUME_LABELS_INVALID") from None


def assert_owned(name: str, run: str, nonce: str) -> None:
    """Refuse cleanup/read of any volume without exact unique ownership."""
    if name not in fake_volume_names(run, nonce).values():
        raise QualificationError("UNOWNED_VOLUME_NAME")
    actual = labels_for(name)
    if (actual.get(LABEL) != "true"
            or actual.get(RUN_LABEL) != run
            or actual.get(NONCE_LABEL) != nonce):
        raise QualificationError("UNOWNED_VOLUME_LABELS")


def _mounts(names: dict[str, str], *, readonly: bool) -> list[str]:
    args: list[str] = []
    for kind in KINDS:
        mount = f"type=volume,source={names[kind]},target=/snapshot/{kind}"
        if readonly:
            mount += ",readonly"
        args.extend(["--mount", mount])
    return args


def _test_populate(names: dict[str, str], fake_source: Path) -> None:
    if fake_source.name != "fabricated-only" or fake_source.is_symlink():
        raise QualificationError("UNSAFE_FAKE_INPUT_ROOT")
    # No network, no access to the owner's PC; all bind/mount names are
    # generated inside this test and point to disposable fake resources.
    docker([
        "run", "--rm", "--network", "none", "--read-only",
        *_mounts(names, readonly=False),
        "--mount", f"type=bind,source={fake_source},target=/fixture,readonly",
        IMAGE, "sh", "-ec",
        "cp -a /fixture/db/. /snapshot/db/; "
        "cp -a /fixture/env/. /snapshot/env/; "
        "cp -a /fixture/files/. /snapshot/files/",
    ])


def _test_archive_to_age(
    names: dict[str, str], temporary: Path, recipients: tuple[str, str]
) -> None:
    """Stream binary tar directly from a throwaway Docker container to age."""
    tar_proc = None
    age_proc = None
    try:
        with temporary.open("xb") as output:
            try:
                tar_proc = subprocess.Popen(
                    [
                        "docker", "run", "--rm", "--network", "none", "--read-only",
                        *_mounts(names, readonly=True),
                        IMAGE, "sh", "-ec",
                        "exec tar -czf - -C /snapshot db env files",
                    ],
                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL, shell=False,
                )
                age_proc = subprocess.Popen(
                    ["age", "-r", recipients[0], "-r", recipients[1]],
                    stdin=tar_proc.stdout, stdout=output,
                    stderr=subprocess.DEVNULL, shell=False,
                )
            except OSError:
                raise QualificationError("FAKE_DOCKER_AGE_PIPE_FAILED") from None
            assert tar_proc.stdout is not None
            tar_proc.stdout.close()
            try:
                age_status = age_proc.wait(timeout=PROCESS_TIMEOUT)
                docker_status = tar_proc.wait(timeout=PROCESS_TIMEOUT)
            except subprocess.TimeoutExpired:
                raise QualificationError("FAKE_DOCKER_AGE_TIMEOUT") from None
            if age_status != 0 or docker_status != 0:
                raise QualificationError("FAKE_DOCKER_TAR_OR_AGE_FAILED")
            output.flush()
            os.fsync(output.fileno())
        if not 0 < temporary.stat().st_size <= MAX_CIPHERTEXT_BYTES:
            raise QualificationError("INVALID_FAKE_ENCRYPTED_OUTPUT_SIZE")
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    finally:
        for proc in (age_proc, tar_proc):
            if proc is not None and proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)


def cleanup_exact_owned_volumes(names: dict[str, str], created: list[str], run: str, nonce: str) -> None:
    for name in reversed(created):
        # Only remove resources created by THIS fixture and still bearing
        # its exact run and nonce labels. Never fallback to docker prune.
        if name not in names.values():
            raise QualificationError("UNOWNED_VOLUME_CLEANUP_REFUSED")
        assert_owned(name, run, nonce)
        docker(["volume", "rm", name])


def check() -> dict:
    run = require_ephemeral_ci()
    if not all(shutil.which(cmd) for cmd in ("docker", "age", "rage", "age-keygen")):
        raise QualificationError("SYNTHETIC_CI_TOOLS_MISSING")
    if docker(["info", "--format", "{{.OSType}}"]).stdout.decode("ascii", "replace").strip() != "linux":
        raise QualificationError("SYNTHETIC_DOCKER_DAEMON_NOT_LINUX")

    nonce = uuid.uuid4().hex[:16]
    names = fake_volume_names(run, nonce)
    created: list[str] = []
    with tempfile.TemporaryDirectory(prefix="sat-docker-fake-only-") as temp:
        scratch = Path(temp)
        scratch.chmod(0o700)
        fake = scratch / "fabricated-only"
        create_fake_volumes(fake)
        owner, r1 = _recipient("age-keygen", scratch, "synthetic-owner")
        recovery, r2 = _recipient("age-keygen", scratch, "synthetic-recovery")
        temporary = scratch / ".fabricated-incomplete.age"
        final = scratch / "completed-fabricated.age"
        try:
            # Pull immutable public Alpine image before allocating any volumes.
            docker(["image", "pull", IMAGE])
            for kind in KINDS:
                name = names[kind]
                if docker(["volume", "inspect", name], success=False).returncode == 0:
                    raise QualificationError("SYNTHETIC_VOLUME_COLLISION")
                docker([
                    "volume", "create", "--label", f"{LABEL}=true",
                    "--label", f"{RUN_LABEL}={run}",
                    "--label", f"{NONCE_LABEL}={nonce}", name,
                ])
                created.append(name)
                assert_owned(name, run, nonce)
            _test_populate(names, fake)
            _test_archive_to_age(names, temporary, (r1, r2))
            recovered_hashes = []
            for exe in ("age", "rage"):
                for identity in (owner, recovery):
                    # A failure/partial output is never written to a stage.
                    recovered = _run(
                        exe, ["-d", "-i", str(identity), "-o", "-", str(temporary)]
                    ).stdout
                    if not 0 < len(recovered) <= MAX_FAKE_TAR_BYTES:
                        raise QualificationError("FAKE_DOCKER_DECRYPT_SIZE_INVALID")
                    digest = __import__("hashlib").sha256(recovered).hexdigest()
                    target = scratch / f"new-fake-restore-{len(recovered_hashes)}"
                    isolated_restore_fake_archive(recovered, target, expected_sha256=digest)
                    recovered_hashes.append(digest)
            if len(set(recovered_hashes)) != 1:
                raise QualificationError("SYNTHETIC_DOCKER_RECOVERY_DIGEST_MISMATCH")
            if final.exists():
                raise QualificationError("FAKE_OUTPUT_ALREADY_EXISTS")
            os.link(temporary, final)
            return {
                "status": "SYNTHETIC_DOCKER_THREE_VOLUME_AGE_PASS",
                "test_owned_docker_volumes": 3,
                "read_only_snapshot_volume_mounts": True,
                "synthetic_archive_recoveries": 4,
                "no_plaintext_archive_disk_write": True,
                "only_test_owned_volume_cleanup": True,
                "synthetic_only": True,
                "production_modified": False,
                "real_backup_performed": False,
                "real_restore_performed": False,
                "deployment_authorized": False,
            }
        finally:
            temporary.unlink(missing_ok=True)
            cleanup_exact_owned_volumes(names, created, run, nonce)


def main() -> int:
    if len(sys.argv) != 1:
        print(json.dumps({"status": "BLOCKED", "reason": "NO_USER_DOCKER_OR_BACKUP_ARGUMENTS_ALLOWED"}))
        return 2
    try:
        result = check()
    except QualificationError as error:
        print(json.dumps({
            "status": "FAILED", "reason": str(error),
            "synthetic_only": True, "production_modified": False,
            "real_backup_performed": False,
        }, sort_keys=True))
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
