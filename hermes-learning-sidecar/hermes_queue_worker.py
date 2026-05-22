#!/usr/bin/env python3
"""Queue-backed Hermes worker for the local Docker runtime group.

This worker consumes sanitized trajectory jobs from the local Redis queue and
runs the existing Hermes sidecar with Wiki auto-publish disabled.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


JOB_SCHEMA_VERSION = "hermes-local-queue-job-v1"
RESULT_SCHEMA_VERSION = "hermes-local-queue-result-v1"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def workspace_path(root: Path, relative_path: str) -> Path:
    resolved_root = root.resolve()
    resolved = (resolved_root / relative_path).resolve()
    if resolved != resolved_root and resolved_root not in resolved.parents:
        raise ValueError("hermes_worker_path_outside_workspace")
    return resolved


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class RedisClient:
    def __init__(self, host: str, port: int, timeout: float = 30.0) -> None:
        self.host = host
        self.port = port
        self.timeout = timeout

    def command(self, *args: str, timeout: float | None = None) -> Any:
        payload = self._encode(args)
        with socket.create_connection((self.host, self.port), timeout=timeout or self.timeout) as sock:
            sock.settimeout(timeout or self.timeout)
            sock.sendall(payload)
            return self._read(sock)

    def _encode(self, args: tuple[str, ...]) -> bytes:
        parts = [f"*{len(args)}\r\n".encode("utf-8")]
        for arg in args:
            item = str(arg).encode("utf-8")
            parts.append(f"${len(item)}\r\n".encode("utf-8"))
            parts.append(item + b"\r\n")
        return b"".join(parts)

    def _read_line(self, sock: socket.socket) -> bytes:
        chunks: list[bytes] = []
        while True:
            char = sock.recv(1)
            if not char:
                raise ConnectionError("redis_connection_closed")
            chunks.append(char)
            if len(chunks) >= 2 and chunks[-2:] == [b"\r", b"\n"]:
                return b"".join(chunks[:-2])

    def _read(self, sock: socket.socket) -> Any:
        prefix = sock.recv(1)
        if not prefix:
            raise ConnectionError("redis_connection_closed")
        line = self._read_line(sock).decode("utf-8")
        if prefix == b"+":
            return line
        if prefix == b"-":
            raise RuntimeError(f"redis_error:{line}")
        if prefix == b":":
            return int(line)
        if prefix == b"$":
            length = int(line)
            if length == -1:
                return None
            data = b""
            while len(data) < length + 2:
                chunk = sock.recv(length + 2 - len(data))
                if not chunk:
                    raise ConnectionError("redis_connection_closed")
                data += chunk
            return data[:length].decode("utf-8")
        if prefix == b"*":
            count = int(line)
            if count == -1:
                return None
            return [self._read(sock) for _ in range(count)]
        raise RuntimeError(f"redis_protocol_unknown_type:{prefix!r}")


def validate_job(job: dict[str, Any]) -> None:
    if job.get("schemaVersion") != JOB_SCHEMA_VERSION:
        raise ValueError("hermes_worker_job_schema_invalid")
    for field in ("jobId", "runDirRelative"):
        if not job.get(field):
            raise ValueError(f"hermes_worker_job_missing_{field}")


def process_job(job: dict[str, Any], workspace_root: Path) -> dict[str, Any]:
    validate_job(job)
    run_dir = workspace_path(workspace_root, str(job["runDirRelative"]))
    out_relative = str(job.get("outRelative") or f"{job['runDirRelative'].rstrip('/')}/artifacts/hermes-docker")
    out_dir = workspace_path(workspace_root, out_relative)
    out_dir.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["HERMES_WIKI_AUTO_PUBLISH"] = "0"
    command = [
        "python3",
        "hermes-learning-sidecar/sidecar.py",
        "--run-dir",
        str(run_dir),
        "--out",
        str(out_dir),
    ]
    completed = subprocess.run(
        command,
        cwd=workspace_root,
        env=env,
        text=True,
        capture_output=True,
        timeout=int(os.environ.get("HERMES_WORKER_TIMEOUT_SECONDS", "900")),
        check=False,
    )
    result = {
        "schemaVersion": RESULT_SCHEMA_VERSION,
        "jobId": job["jobId"],
        "status": "completed" if completed.returncode == 0 else "blocked",
        "exitCode": completed.returncode,
        "outRelative": str(out_dir.relative_to(workspace_root)),
        "stdoutTail": completed.stdout[-1200:],
        "stderrTail": completed.stderr[-1200:],
        "autoPublish": False,
        "completedAt": now_iso(),
        "rawSecretsReturned": False,
        "rawMediaExternalUpload": False,
    }
    write_json(out_dir / "hermes-worker-result.json", result)
    return result


def publish_result(redis: RedisClient, job: dict[str, Any], result: dict[str, Any]) -> None:
    result_key = job.get("resultKey")
    if not result_key:
        return
    redis.command("RPUSH", str(result_key), json.dumps(result, ensure_ascii=False), timeout=10)
    redis.command("EXPIRE", str(result_key), os.environ.get("HERMES_RESULT_TTL_SECONDS", "3600"), timeout=10)


def run_loop(args: argparse.Namespace) -> int:
    redis = RedisClient(
        os.environ.get("HERMES_QUEUE_HOST", "runtime-queue"),
        int(os.environ.get("HERMES_QUEUE_PORT", "6379")),
        timeout=35,
    )
    queue_name = os.environ.get("HERMES_QUEUE_NAME", "pi:hermes-worker:jobs")
    workspace_root = Path(os.environ.get("LOCAL_DOCKER_WORKSPACE_ROOT", os.getcwd())).resolve()
    handled = 0
    while True:
        response = redis.command("BLPOP", queue_name, "30", timeout=35)
        if not response:
            if args.once:
                return handled
            continue
        job = json.loads(response[1])
        try:
            result = process_job(job, workspace_root)
        except Exception as error:  # noqa: BLE001 - fail-closed result for queue consumer
            result = {
                "schemaVersion": RESULT_SCHEMA_VERSION,
                "jobId": job.get("jobId"),
                "status": "blocked",
                "reason": str(error),
                "completedAt": now_iso(),
                "autoPublish": False,
                "rawSecretsReturned": False,
                "rawMediaExternalUpload": False,
            }
        publish_result(redis, job, result)
        handled += 1
        if args.once:
            return handled


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--job-file", type=Path)
    args = parser.parse_args()
    workspace_root = Path(os.environ.get("LOCAL_DOCKER_WORKSPACE_ROOT", os.getcwd())).resolve()
    if args.job_file:
        job = json.loads(args.job_file.read_text(encoding="utf-8"))
        result = process_job(job, workspace_root)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["status"] == "completed" else 2
    return 0 if run_loop(args) >= 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
