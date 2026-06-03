#!/usr/bin/env python3
"""Lifecycle helper for the host-owned local Qwen3-ASR HTTP service."""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[2]
SERVICE_DIR = ROOT / "runtime-runs" / "_services" / "local-asr"
PID_PATH = SERVICE_DIR / "local-asr.pid"
LOG_PATH = SERVICE_DIR / "local-asr.log"
DEFAULT_PYTHON = ROOT / ".venv-qwen3-asr" / "bin" / "python"
DEFAULT_SERVICE = ROOT / "meeting-agent-pi-package" / "tools" / "local_asr_http_service.py"
DEFAULT_MODEL_DIR = ROOT / "models" / "Qwen3-ASR-1.7B-MLX-4bit"


def print_json(value: dict) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))


def service_url(args: argparse.Namespace) -> str:
    return args.url or os.environ.get("LOCAL_ASR_SERVICE_URL") or f"http://{args.host}:{args.port}"


def is_loopback(url: str) -> bool:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    return host == "localhost" or host == "::1" or host.startswith("127.")


def pid_running(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def read_pid() -> int | None:
    try:
        return int(PID_PATH.read_text(encoding="utf-8").strip())
    except Exception:
        return None


def health(url: str, timeout: float, bearer_token: str | None) -> dict:
    if not is_loopback(url):
        return {"ok": False, "status": "blocked", "reason": "local_asr_service_url_non_loopback_blocked", "url": url}
    request = urllib.request.Request(
        f"{url.rstrip('/')}/health",
        headers={"authorization": f"Bearer {bearer_token}"} if bearer_token else {},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(1024 * 1024).decode("utf-8", errors="replace")
            body = json.loads(raw) if raw else {}
            return {
                "ok": 200 <= response.status < 300 and body.get("status") == "ok",
                "status": "up" if body.get("status") == "ok" else "unhealthy",
                "httpStatus": response.status,
                "body": body,
                "url": url,
            }
    except urllib.error.HTTPError as exc:
        return {"ok": False, "status": "down", "httpStatus": exc.code, "error": str(exc), "url": url}
    except Exception as exc:
        if tcp_reachable(url, min(timeout, 1.0)):
            return {
                "ok": True,
                "status": "busy",
                "httpStatus": 0,
                "error": str(exc),
                "reason": "health_timeout_while_tcp_reachable",
                "busy": True,
                "url": url,
            }
        return {"ok": False, "status": "down", "httpStatus": 0, "error": str(exc), "url": url}


def tcp_reachable(url: str, timeout: float) -> bool:
    parsed = urlparse(url)
    host = parsed.hostname
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if not host:
        return False
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def status(args: argparse.Namespace) -> dict:
    url = service_url(args)
    pid = read_pid()
    health_result = health(url, args.timeout, args.bearer_token or os.environ.get("LOCAL_ASR_BEARER_TOKEN"))
    return {
        "schemaVersion": "local-asr-service-ctl-v1",
        "status": "ok" if health_result["ok"] else "blocked",
        "serviceStatus": health_result["status"],
        "pid": pid,
        "pidRunning": pid_running(pid),
        "pidPath": str(PID_PATH.relative_to(ROOT)),
        "logPath": str(LOG_PATH.relative_to(ROOT)),
        "health": health_result,
        "rawMediaExternalUpload": False,
    }


def start(args: argparse.Namespace) -> dict:
    current = status(args)
    if current["health"]["ok"]:
        return {**current, "status": "ok", "reason": "already_running"}
    # Keep the venv executable path instead of resolving its symlink target.
    # CPython uses argv[0] near pyvenv.cfg to activate the venv's site-packages.
    python_bin = Path(args.python).expanduser()
    service = Path(args.service).expanduser().resolve()
    model_dir = Path(args.model_dir).expanduser().resolve()
    if not python_bin.exists():
        return {**current, "status": "blocked", "reason": "python_not_found", "python": str(python_bin)}
    if not service.exists():
        return {**current, "status": "blocked", "reason": "service_script_not_found", "service": str(service)}
    if not model_dir.exists():
        return {**current, "status": "blocked", "reason": "model_dir_not_found", "modelDir": str(model_dir)}
    SERVICE_DIR.mkdir(parents=True, exist_ok=True)
    log_handle = LOG_PATH.open("ab")
    command = [
        str(python_bin),
        str(service),
        "--host",
        args.host,
        "--port",
        str(args.port),
        "--model-dir",
        str(model_dir),
        "--input-root",
        str(ROOT),
        "--output-root",
        str(ROOT),
    ]
    if args.preload:
        command.append("--preload")
    if args.bearer_token:
        command.extend(["--bearer-token", args.bearer_token])
    process = subprocess.Popen(command, cwd=str(ROOT), stdout=log_handle, stderr=log_handle, start_new_session=True)
    PID_PATH.write_text(f"{process.pid}\n", encoding="utf-8")
    time.sleep(args.startup_wait)
    after = status(args)
    return {
        **after,
        "startedPid": process.pid,
        "command": command,
        "reason": "started" if after["health"]["ok"] else "started_but_health_not_ready",
    }


def stop(args: argparse.Namespace) -> dict:
    pid = read_pid()
    if not pid:
        return {"schemaVersion": "local-asr-service-ctl-v1", "status": "ok", "reason": "pid_missing", "rawMediaExternalUpload": False}
    if not pid_running(pid):
        PID_PATH.unlink(missing_ok=True)
        return {"schemaVersion": "local-asr-service-ctl-v1", "status": "ok", "pid": pid, "reason": "not_running", "rawMediaExternalUpload": False}
    os.kill(pid, signal.SIGTERM)
    deadline = time.time() + args.timeout
    while time.time() < deadline:
        if not pid_running(pid):
            PID_PATH.unlink(missing_ok=True)
            return {"schemaVersion": "local-asr-service-ctl-v1", "status": "ok", "pid": pid, "reason": "stopped", "rawMediaExternalUpload": False}
        time.sleep(0.2)
    return {"schemaVersion": "local-asr-service-ctl-v1", "status": "blocked", "pid": pid, "reason": "stop_timeout", "rawMediaExternalUpload": False}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage the host-owned local ASR service")
    parser.add_argument("command", choices=["status", "start", "stop"])
    parser.add_argument("--url", default=None)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--timeout", type=float, default=3.0)
    parser.add_argument("--startup-wait", type=float, default=2.0)
    parser.add_argument("--python", default=str(DEFAULT_PYTHON))
    parser.add_argument("--service", default=str(DEFAULT_SERVICE))
    parser.add_argument("--model-dir", default=str(DEFAULT_MODEL_DIR))
    parser.add_argument("--bearer-token", default=os.environ.get("LOCAL_ASR_BEARER_TOKEN"))
    parser.add_argument("--preload", action=argparse.BooleanOptionalAction, default=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "status":
        result = status(args)
        print_json(result)
        return 0
    elif args.command == "start":
        result = start(args)
    else:
        result = stop(args)
    print_json(result)
    return 0 if result.get("status") == "ok" else 2


if __name__ == "__main__":
    raise SystemExit(main())
