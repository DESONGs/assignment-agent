#!/usr/bin/env python3
"""Command-line control for the local Feishu runtime supervisor.

Marker: local-runtime-ctl-v1 start|stop|restart|status|doctor.
"""

from __future__ import annotations

import argparse
import calendar
import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
TOOL_DIR = ROOT / "meeting-agent-pi-package" / "tools"
SUPERVISOR = TOOL_DIR / "local_runtime_supervisor.py"
ASR_CTL = TOOL_DIR / "local_asr_service_ctl.py"
SERVICE_DIR = ROOT / "runtime-runs" / "_services" / "supervisor"
PID_PATH = SERVICE_DIR / "supervisor.pid"
STATUS_PATH = SERVICE_DIR / "status.json"
LOG_PATH = SERVICE_DIR / "supervisor.log"
EVENTS_PATH = SERVICE_DIR / "events.ndjson"
HANDLER_HEALTH_URL = "http://127.0.0.1:8788/health"
LAUNCHD_LABELS = ("com.assignment-agent.feishu-handler", "com.assignment-agent.feishu-gateway")
MANAGED_PROCESS_MARKERS = (
    "meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs",
    "meeting-agent-pi-package/tools/feishu_bot_event_gateway.mjs",
    "runtime-runs/feishu-agent/start-handler.zsh",
    "runtime-runs/feishu-agent/start-gateway.zsh",
)
DOCKER_FALLBACK = Path("/Applications/Docker.app/Contents/Resources/bin/docker")


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def print_json(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


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


def current_status(stale_after_seconds: int = 20) -> dict[str, Any]:
    status = read_json(STATUS_PATH) or {
        "schemaVersion": "local-runtime-supervisor-v1",
        "status": "unknown",
        "reason": "status_json_missing",
        "rawSecretsReturned": False,
        "rawMediaExternalUpload": False,
    }
    pid = read_pid() or status.get("supervisorPid")
    status["supervisorPidRunning"] = pid_running(pid)
    updated = status.get("updatedAt")
    if updated:
        try:
            updated_epoch = calendar.timegm(time.strptime(updated, "%Y-%m-%dT%H:%M:%SZ"))
            status["stale"] = time.time() - updated_epoch > stale_after_seconds
        except Exception:
            status["stale"] = True
    else:
        status["stale"] = True
    return status


def run_command(command: list[str], timeout: float = 8.0) -> dict[str, Any]:
    try:
        completed = subprocess.run(command, cwd=str(ROOT), text=True, capture_output=True, timeout=timeout)
        return {
            "command": command[:2],
            "exitCode": completed.returncode,
            "stdoutTail": completed.stdout[-2000:],
            "stderrTail": completed.stderr[-2000:],
        }
    except Exception as exc:
        return {"command": command[:2], "exitCode": None, "error": str(exc)}


def bootout_launchd_labels() -> list[dict[str, Any]]:
    uid = os.getuid()
    results = []
    for label in LAUNCHD_LABELS:
        result = run_command(["launchctl", "bootout", f"gui/{uid}/{label}"], timeout=5.0)
        result["label"] = label
        result["action"] = "bootout"
        results.append(result)
    return results


def list_matching_processes() -> list[dict[str, Any]]:
    result = subprocess.run(["ps", "-axo", "pid=,command="], text=True, capture_output=True, timeout=8.0)
    current = os.getpid()
    matches: list[dict[str, Any]] = []
    for line in result.stdout.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        pid_text, _, command = stripped.partition(" ")
        try:
            pid = int(pid_text)
        except ValueError:
            continue
        if pid == current:
            continue
        if any(marker in command for marker in MANAGED_PROCESS_MARKERS):
            matches.append({"pid": pid, "command": command[:500]})
    return matches


def terminate_matching_processes() -> list[dict[str, Any]]:
    matches = list_matching_processes()
    for match in matches:
        try:
            os.kill(int(match["pid"]), signal.SIGTERM)
            match["terminated"] = True
        except Exception as exc:
            match["terminated"] = False
            match["error"] = str(exc)
    deadline = time.time() + 8
    while time.time() < deadline:
        if not any(pid_running(int(match["pid"])) for match in matches):
            break
        time.sleep(0.2)
    for match in matches:
        match["stillRunning"] = pid_running(int(match["pid"]))
    return matches


def start(args: argparse.Namespace) -> dict[str, Any]:
    SERVICE_DIR.mkdir(parents=True, exist_ok=True)
    pid = read_pid()
    if pid_running(pid):
        return {**current_status(), "reason": "already_running"}

    takeover_results: dict[str, Any] = {}
    if args.takeover:
        takeover_results["launchdBootout"] = bootout_launchd_labels() if args.bootout_launchd else []
        takeover_results["terminatedProcesses"] = terminate_matching_processes()

    env = dict(os.environ)
    env["PYTHONUNBUFFERED"] = "1"
    log_handle = LOG_PATH.open("ab")
    command = [
        sys.executable,
        str(SUPERVISOR),
        "run",
        "--interval",
        str(args.interval),
        "--health-timeout",
        str(args.health_timeout),
        "--asr-timeout",
        str(args.asr_timeout),
    ]
    if not args.asr_recover:
        command.append("--no-asr-recover")
    if args.env_file:
        command.extend(["--env-file", args.env_file])
    process = subprocess.Popen(command, cwd=str(ROOT), env=env, stdout=log_handle, stderr=log_handle, start_new_session=True)
    PID_PATH.write_text(f"{process.pid}\n", encoding="utf-8")
    deadline = time.time() + args.startup_wait
    status = current_status()
    while time.time() < deadline:
        status = current_status()
        if status.get("supervisorPidRunning") and status.get("status") in {"ok", "degraded", "blocked"} and not status.get("stale"):
            break
        time.sleep(0.5)
    return {
        "schemaVersion": "local-runtime-ctl-v1",
        "status": "ok" if pid_running(process.pid) else "blocked",
        "reason": "started" if pid_running(process.pid) else "start_failed",
        "supervisorPid": process.pid,
        "statusPath": str(STATUS_PATH.relative_to(ROOT)),
        "eventsPath": str(EVENTS_PATH.relative_to(ROOT)),
        "takeover": takeover_results,
        "current": status,
        "rawSecretsReturned": False,
        "rawMediaExternalUpload": False,
    }


def stop(args: argparse.Namespace) -> dict[str, Any]:
    pid = read_pid()
    status_before = current_status()
    if pid and pid_running(pid):
        os.kill(pid, signal.SIGTERM)
        deadline = time.time() + args.timeout
        while time.time() < deadline and pid_running(pid):
            time.sleep(0.2)
    child_results = []
    if args.kill_children:
        child_results = terminate_matching_processes()
    if args.stop_asr:
        asr_result = run_command([sys.executable, str(ASR_CTL), "stop"], timeout=args.timeout)
    else:
        asr_result = {"status": "skipped", "reason": "asr_is_host_owned_and_not_stopped_by_default"}
    after_running = pid_running(pid)
    if not after_running:
        PID_PATH.unlink(missing_ok=True)
    return {
        "schemaVersion": "local-runtime-ctl-v1",
        "status": "ok" if not after_running else "blocked",
        "reason": "stopped" if not after_running else "supervisor_stop_timeout",
        "supervisorPid": pid,
        "before": status_before,
        "childProcesses": child_results,
        "asr": asr_result,
        "rawSecretsReturned": False,
        "rawMediaExternalUpload": False,
    }


def restart(args: argparse.Namespace) -> dict[str, Any]:
    stopped = stop(args)
    started = start(args)
    return {"schemaVersion": "local-runtime-ctl-v1", "status": started.get("status", "blocked"), "stopped": stopped, "started": started}


def http_probe(url: str, timeout: float) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            text = response.read(1024 * 1024).decode("utf-8", errors="replace")
            body = json.loads(text) if text else {}
            return {"ok": 200 <= response.status < 300, "httpStatus": response.status, "body": body}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def docker_probe() -> dict[str, Any]:
    candidates = ["docker"]
    if DOCKER_FALLBACK.exists():
        candidates.append(str(DOCKER_FALLBACK))
    for candidate in candidates:
        result = run_command([candidate, "compose", "-f", "docker-compose.local-runtime.yml", "config"], timeout=20.0)
        if result.get("exitCode") == 0:
            return {"ok": True, "dockerCli": candidate, "composeConfig": "ok"}
    return {"ok": False, "reason": "docker_compose_config_failed", "candidates": candidates}


def selected_asr_provider() -> dict[str, Any]:
    requested = (os.environ.get("MEETING_ASR_PROVIDER") or "auto").strip().lower()
    key_configured = bool((os.environ.get("ALIYUN_DASHSCOPE_API_KEY") or os.environ.get("DASHSCOPE_API_KEY") or "").strip())
    if requested in ("", "auto"):
        provider = "aliyun_dashscope_paraformer" if key_configured else "local_qwen3"
    elif requested in ("cloud", "aliyun", "dashscope", "paraformer", "aliyun_dashscope_paraformer"):
        provider = "aliyun_dashscope_paraformer"
    else:
        provider = "local_qwen3"
    return {
        "requested": requested or "auto",
        "provider": provider,
        "cloudApiKeyConfigured": key_configured,
        "localAsrRequired": provider == "local_qwen3",
        "rawSecretsReturned": False,
    }


def doctor(args: argparse.Namespace) -> dict[str, Any]:
    status = current_status()
    direct_asr = run_command([sys.executable, str(ASR_CTL), "status", "--timeout", str(args.timeout)], timeout=args.timeout + 4)
    try:
        direct_asr["json"] = json.loads(direct_asr.get("stdoutTail") or "{}")
    except Exception:
        pass
    processes = list_matching_processes()
    handler_health = http_probe(HANDLER_HEALTH_URL, args.timeout)
    docker = docker_probe()
    asr_provider = selected_asr_provider()
    local_asr_ok = (direct_asr.get("json") or {}).get("status") == "ok"
    result = {
        "schemaVersion": "local-runtime-doctor-v1",
        "checkedAt": now_iso(),
        "status": "ok"
        if status.get("status") == "ok" and handler_health.get("ok") and (local_asr_ok or not asr_provider["localAsrRequired"])
        else "blocked",
        "supervisor": status,
        "handlerHealth": handler_health,
        "asrProvider": asr_provider,
        "asrStatus": direct_asr,
        "docker": docker,
        "matchingFeishuProcesses": processes,
        "notes": [
            "feishu-handler and feishu-gateway should be managed by local_runtime_supervisor, not bare screen",
            "ASR provider is configurable: local_qwen3 remains host-owned; aliyun_dashscope_paraformer may upload audio for ASR only",
        ],
        "rawSecretsReturned": False,
        "rawMediaExternalUpload": False,
    }
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Control the local Feishu runtime supervisor")
    sub = parser.add_subparsers(dest="command", required=True)

    start_parser = sub.add_parser("start")
    start_parser.add_argument("--interval", type=float, default=5.0)
    start_parser.add_argument("--health-timeout", type=float, default=3.0)
    start_parser.add_argument("--asr-timeout", type=float, default=3.0)
    start_parser.add_argument("--startup-wait", type=float, default=8.0)
    start_parser.add_argument("--takeover", action=argparse.BooleanOptionalAction, default=True)
    start_parser.add_argument("--bootout-launchd", action=argparse.BooleanOptionalAction, default=True)
    start_parser.add_argument("--asr-recover", action=argparse.BooleanOptionalAction, default=True)
    start_parser.add_argument("--env-file", default=str(ROOT / ".env.local"))

    stop_parser = sub.add_parser("stop")
    stop_parser.add_argument("--timeout", type=float, default=12.0)
    stop_parser.add_argument("--kill-children", action=argparse.BooleanOptionalAction, default=True)
    stop_parser.add_argument("--stop-asr", action=argparse.BooleanOptionalAction, default=False)

    restart_parser = sub.add_parser("restart")
    restart_parser.add_argument("--timeout", type=float, default=12.0)
    restart_parser.add_argument("--kill-children", action=argparse.BooleanOptionalAction, default=True)
    restart_parser.add_argument("--stop-asr", action=argparse.BooleanOptionalAction, default=False)
    restart_parser.add_argument("--interval", type=float, default=5.0)
    restart_parser.add_argument("--health-timeout", type=float, default=3.0)
    restart_parser.add_argument("--asr-timeout", type=float, default=3.0)
    restart_parser.add_argument("--startup-wait", type=float, default=8.0)
    restart_parser.add_argument("--takeover", action=argparse.BooleanOptionalAction, default=True)
    restart_parser.add_argument("--bootout-launchd", action=argparse.BooleanOptionalAction, default=True)
    restart_parser.add_argument("--asr-recover", action=argparse.BooleanOptionalAction, default=True)
    restart_parser.add_argument("--env-file", default=str(ROOT / ".env.local"))

    status_parser = sub.add_parser("status")
    status_parser.add_argument("--stale-after-seconds", type=int, default=20)

    doctor_parser = sub.add_parser("doctor")
    doctor_parser.add_argument("--timeout", type=float, default=3.0)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "start":
        result = start(args)
    elif args.command == "stop":
        result = stop(args)
    elif args.command == "restart":
        result = restart(args)
    elif args.command == "status":
        result = current_status(args.stale_after_seconds)
    elif args.command == "doctor":
        result = doctor(args)
    else:
        raise AssertionError(args.command)
    print_json(result)
    return 0 if result.get("status") in {"ok", "degraded"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
