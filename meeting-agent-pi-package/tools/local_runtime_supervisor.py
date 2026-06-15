#!/usr/bin/env python3
"""Production supervisor for the local Feishu runtime.

Marker: local-runtime-supervisor-v1.

This host-owned control plane manages the Feishu handler and Feishu gateway as
direct child processes, while local-asr remains a host service checked through
local_asr_service_ctl.py. The supervisor writes status.json, events.ndjson, and
health-report.json, and never writes secret values to those artifacts.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
TOOL_DIR = ROOT / "meeting-agent-pi-package" / "tools"
SERVICE_DIR = ROOT / "runtime-runs" / "_services" / "supervisor"
PID_PATH = SERVICE_DIR / "supervisor.pid"
STATUS_PATH = SERVICE_DIR / "status.json"
EVENTS_PATH = SERVICE_DIR / "events.ndjson"
HEALTH_REPORT_PATH = SERVICE_DIR / "health-report.json"
LOG_PATH = SERVICE_DIR / "supervisor.log"

HANDLER_HOST = "127.0.0.1"
HANDLER_PORT = 8788
HANDLER_HEALTH_URL = f"http://{HANDLER_HOST}:{HANDLER_PORT}/health"
ASR_STATUS_TOOL = TOOL_DIR / "local_asr_service_ctl.py"
NODE_FALLBACKS = (
    ROOT / ".node" / "bin" / "node",
    Path("/Users/chenge/.nvm/versions/node/v22.17.0/bin/node"),
    Path("/opt/homebrew/bin/node"),
    Path("/usr/local/bin/node"),
)
PATH_PREFIXES = (
    "/Users/chenge/.nvm/versions/node/v22.17.0/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
)

SECRET_KEY_RE = re.compile(r"(secret|token|cookie|session|authorization|password|app_secret|api_key)", re.I)
SECRET_VALUE_PATTERNS = (
    re.compile(r"(app_secret|client_secret|refresh_token|access_token|authorization|cookie|session)\s*[:=]\s*['\"]?[^'\",\s]+", re.I),
    re.compile(r"bearer\s+[A-Za-z0-9._-]+", re.I),
)
GATEWAY_TIMEOUT_RE = re.compile(r"(ws|websocket|long_connection|stream).{0,40}(timeout|timed out)|timeout.{0,40}(ws|websocket|long_connection|stream)", re.I)

DEFAULT_ENV = {
    "FEISHU_AGENT_EXEC_MODE": "execute",
    "FEISHU_AGENT_ASYNC": "1",
    "FEISHU_AGENT_ASYNC_VISIBLE_ACK": "0",
    "FEISHU_AGENT_PUBLISH_MODE": "live",
    "FEISHU_AGENT_REPLY_MODE": "live",
    "FEISHU_AGENT_PROGRESS_REPLY_MODE": "silent",
    "FEISHU_AGENT_FILE_ACK_REPLY_MODE": "silent",
    "FEISHU_AGENT_PUBLISH_AS": "user",
    "FEISHU_AGENT_PUBLISH_TARGET": "auto",
    "FEISHU_REVIEW_CONTEXT_AS": "auto",
    "FEISHU_AGENT_DOCUMENT_WORKER_MODE": "host",
    "FEISHU_AGENT_DOCUMENT_WORKER_TIMEOUT_MS": "1800000",
    "FEISHU_AGENT_LONG_DOCUMENT_JOB_TIMEOUT_MS": "7200000",
    "FEISHU_AGENT_DOCUMENT_WORKER_DEADLINE_RESERVE_MS": "30000",
    "FEISHU_AGENT_DOCUMENT_QUALITY_MODE": "stable",
    "FEISHU_AGENT_PIPELINE_MOCK_MODEL": "0",
    "FEISHU_BOT_HANDLER_URL": "http://127.0.0.1:8788/feishu/events",
    "FEISHU_BOT_REPLY_MODE": "http",
    "LOCAL_ASR_SERVICE_URL": "http://127.0.0.1:8765",
    "NO_PROXY": "127.0.0.1,localhost,::1",
    "no_proxy": "127.0.0.1,localhost,::1",
}


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def monotonic_ms() -> int:
    return int(time.monotonic() * 1000)


def redact_string(value: str) -> str:
    text = str(value)
    for pattern in SECRET_VALUE_PATTERNS:
        text = pattern.sub("[redacted]", text)
    return text


def sanitize(value: Any, key: str = "") -> Any:
    if isinstance(value, str):
        if SECRET_KEY_RE.search(key):
            return "[redacted]"
        return redact_string(value)
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    if isinstance(value, dict):
        return {entry_key: sanitize(entry_value, entry_key) for entry_key, entry_value in value.items()}
    return value


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(sanitize(value), ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def append_event(value: dict[str, Any]) -> None:
    SERVICE_DIR.mkdir(parents=True, exist_ok=True)
    record = {"ts": now_iso(), **value, "rawSecretsReturned": False, "rawMediaExternalUpload": False}
    with EVENTS_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(sanitize(record), ensure_ascii=False, sort_keys=True) + "\n")


def parse_env_value(raw: str) -> str:
    text = raw.strip()
    if not text:
        return ""
    try:
        parsed = shlex.split(text, comments=False, posix=True)
        if parsed:
            return parsed[0]
    except ValueError:
        pass
    if (text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'")):
        return text[1:-1]
    return text


def load_env_file(env: dict[str, str], path: Path) -> list[str]:
    loaded: list[str] = []
    if not path.exists():
        return loaded
    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, raw_value = line.split("=", 1)
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        if key in env and env[key]:
            continue
        env[key] = parse_env_value(raw_value)
        loaded.append(key)
    return loaded


def node_bin(path_value: str | None = None) -> str:
    path = os.environ.get("NODE_BIN")
    if path and Path(path).exists():
        return path
    for prefix in (path_value or os.environ.get("PATH", "")).split(os.pathsep):
        candidate = Path(prefix) / "node"
        if candidate.exists():
            return str(candidate)
    for candidate in NODE_FALLBACKS:
        if candidate.exists():
            return str(candidate)
    return "node"


def base_env(env_file: Path | None) -> tuple[dict[str, str], list[str]]:
    env = dict(os.environ)
    current_path = env.get("PATH", "")
    env["PATH"] = os.pathsep.join([*PATH_PREFIXES, current_path]) if current_path else os.pathsep.join(PATH_PREFIXES)
    loaded_keys: list[str] = []
    if env_file:
        loaded_keys = load_env_file(env, env_file)
    for key, value in DEFAULT_ENV.items():
        env.setdefault(key, value)
    env.setdefault(
        "PI_CLI_BIN",
        "/Users/chenge/.nvm/versions/node/v22.17.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    )
    return env, loaded_keys


def http_health(url: str, timeout: float) -> dict[str, Any]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            body = response.read(1024 * 1024).decode("utf-8", errors="replace")
            parsed = json.loads(body) if body else {}
            ok = 200 <= response.status < 300 and parsed.get("status") == "ok"
            return {"ok": ok, "status": "up" if ok else "unhealthy", "httpStatus": response.status, "body": parsed}
    except urllib.error.HTTPError as exc:
        return {"ok": False, "status": "down", "httpStatus": exc.code, "error": redact_string(str(exc))}
    except Exception as exc:
        return {"ok": False, "status": "down", "httpStatus": 0, "error": redact_string(str(exc))}


def process_running(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def tcp_port_open(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def tail_from(path: Path, offset: int, max_bytes: int = 64_000) -> tuple[str, int]:
    if not path.exists():
        return "", offset
    size = path.stat().st_size
    if offset > size:
        offset = 0
    read_start = max(offset, size - max_bytes)
    with path.open("rb") as handle:
        handle.seek(read_start)
        data = handle.read()
    return data.decode("utf-8", errors="replace"), size


def asr_status(timeout: float) -> dict[str, Any]:
    command = [sys.executable, str(ASR_STATUS_TOOL), "status", "--timeout", str(timeout)]
    try:
        completed = subprocess.run(command, cwd=str(ROOT), text=True, capture_output=True, timeout=max(timeout + 2, 5))
    except Exception as exc:
        return {"ok": False, "status": "blocked", "reason": "local_asr_status_failed", "error": redact_string(str(exc))}
    try:
        parsed = json.loads(completed.stdout)
    except json.JSONDecodeError:
        parsed = {"stdoutTail": completed.stdout[-1000:]}
    ok = completed.returncode == 0 and parsed.get("status") == "ok"
    return {
        "ok": ok,
        "status": "up" if ok else parsed.get("serviceStatus", "blocked"),
        "exitCode": completed.returncode,
        "details": parsed,
        "stderrTail": redact_string(completed.stderr[-1000:]),
    }


def asr_recover(timeout: float) -> dict[str, Any]:
    command = [sys.executable, str(ASR_STATUS_TOOL), "start", "--timeout", str(timeout)]
    try:
        completed = subprocess.run(command, cwd=str(ROOT), text=True, capture_output=True, timeout=max(timeout + 5, 10))
    except Exception as exc:
        return {"status": "blocked", "reason": "local_asr_recover_failed", "error": redact_string(str(exc))}


def selected_asr_provider(runtime_env: dict[str, str]) -> dict[str, Any]:
    requested = (runtime_env.get("MEETING_ASR_PROVIDER") or "auto").strip().lower()
    key_configured = bool((runtime_env.get("ALIYUN_DASHSCOPE_API_KEY") or runtime_env.get("DASHSCOPE_API_KEY") or "").strip())
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
    try:
        parsed = json.loads(completed.stdout)
    except json.JSONDecodeError:
        parsed = {"stdoutTail": completed.stdout[-1000:]}
    return {
        "status": "ok" if completed.returncode == 0 else "blocked",
        "exitCode": completed.returncode,
        "details": parsed,
        "stderrTail": redact_string(completed.stderr[-1000:]),
    }


@dataclass
class ManagedService:
    name: str
    command: list[str]
    env: dict[str, str]
    log_path: Path
    process: subprocess.Popen[bytes] | None = None
    restarts: int = 0
    started_at: str | None = None
    last_exit_code: int | None = None
    log_offset: int = 0
    consecutive_health_failures: int = 0
    gateway_timeout_hits: int = 0
    last_restart_reason: str | None = None
    log_handle: Any = field(default=None, repr=False)

    def pid(self) -> int | None:
        return self.process.pid if self.process and self.process.poll() is None else None

    def running(self) -> bool:
        return self.process is not None and self.process.poll() is None

    def start(self, reason: str) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        if self.log_handle:
            try:
                self.log_handle.close()
            except Exception:
                pass
        self.log_handle = self.log_path.open("ab")
        self.process = subprocess.Popen(
            self.command,
            cwd=str(ROOT),
            env=self.env,
            stdout=self.log_handle,
            stderr=self.log_handle,
            start_new_session=True,
        )
        self.started_at = now_iso()
        self.restarts += 1 if reason != "initial_start" else 0
        self.last_restart_reason = reason
        self.last_exit_code = None
        self.log_offset = self.log_path.stat().st_size if self.log_path.exists() else 0
        append_event({"event": "service_started", "service": self.name, "pid": self.process.pid, "reason": reason})

    def stop(self, timeout: float = 10.0) -> None:
        if not self.process:
            return
        pid = self.process.pid
        if self.process.poll() is None:
            try:
                os.killpg(pid, signal.SIGTERM)
            except Exception:
                try:
                    self.process.terminate()
                except Exception:
                    pass
            deadline = time.time() + timeout
            while time.time() < deadline and self.process.poll() is None:
                time.sleep(0.2)
            if self.process.poll() is None:
                try:
                    os.killpg(pid, signal.SIGKILL)
                except Exception:
                    try:
                        self.process.kill()
                    except Exception:
                        pass
        self.last_exit_code = self.process.poll()
        append_event({"event": "service_stopped", "service": self.name, "pid": pid, "exitCode": self.last_exit_code})
        if self.log_handle:
            try:
                self.log_handle.close()
            except Exception:
                pass
            self.log_handle = None

    def restart(self, reason: str) -> None:
        old_pid = self.pid()
        append_event({"event": "service_restarting", "service": self.name, "oldPid": old_pid, "reason": reason})
        self.stop(timeout=8.0)
        self.start(reason=reason)

    def ensure_running(self) -> None:
        if not self.running():
            exit_code = self.process.poll() if self.process else None
            self.last_exit_code = exit_code
            self.start(reason="process_not_running")


def build_services(args: argparse.Namespace, env: dict[str, str]) -> dict[str, ManagedService]:
    node = node_bin(env.get("PATH"))
    handler_env = dict(env)
    gateway_env = dict(env)
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        gateway_env.pop(key, None)
    return {
        "feishu-handler": ManagedService(
            name="feishu-handler",
            command=[
                node,
                "meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs",
                "--host",
                args.handler_host,
                "--port",
                str(args.handler_port),
            ],
            env=handler_env,
            log_path=SERVICE_DIR / "feishu-handler.log",
        ),
        "feishu-gateway": ManagedService(
            name="feishu-gateway",
            command=[node, "meeting-agent-pi-package/tools/feishu_bot_event_gateway.mjs"],
            env=gateway_env,
            log_path=SERVICE_DIR / "feishu-gateway.log",
        ),
    }


def service_snapshot(service: ManagedService, health: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "pid": service.pid(),
        "processRunning": service.running(),
        "startedAt": service.started_at,
        "restartCount": service.restarts,
        "lastExitCode": service.last_exit_code,
        "lastRestartReason": service.last_restart_reason,
        "logPath": str(service.log_path.relative_to(ROOT)),
        "health": health or {"ok": service.running(), "status": "process_alive" if service.running() else "down"},
    }


def status_document(
    services: dict[str, ManagedService],
    health: dict[str, Any],
    args: argparse.Namespace,
    loaded_env_keys: list[str],
    started_at: str,
    runtime_env: dict[str, str],
) -> dict[str, Any]:
    asr_provider = selected_asr_provider(runtime_env)
    local_asr_required = asr_provider["localAsrRequired"]
    service_states = {
        "feishu-handler": service_snapshot(services["feishu-handler"], health.get("feishu-handler")),
        "feishu-gateway": service_snapshot(services["feishu-gateway"], health.get("feishu-gateway")),
        "asr-provider": asr_provider,
        "local-asr": health.get("local-asr", {"ok": False, "status": "unknown"}),
    }
    ok = all(
        [
            service_states["feishu-handler"]["health"].get("ok") is True,
            service_states["feishu-gateway"]["health"].get("ok") is True,
            (service_states["local-asr"].get("ok") is True or not local_asr_required),
        ],
    )
    blocked = local_asr_required and (service_states["local-asr"].get("ok") is not True or service_states["local-asr"].get("status") == "blocked")
    return {
        "schemaVersion": "local-runtime-supervisor-v1",
        "status": "ok" if ok else "blocked" if blocked else "degraded",
        "updatedAt": now_iso(),
        "startedAt": started_at,
        "supervisorPid": os.getpid(),
        "workspace": str(ROOT),
        "services": service_states,
        "productionDefaults": {
            "publishMode": runtime_env.get("FEISHU_AGENT_PUBLISH_MODE") or DEFAULT_ENV["FEISHU_AGENT_PUBLISH_MODE"],
            "replyMode": runtime_env.get("FEISHU_AGENT_REPLY_MODE") or DEFAULT_ENV["FEISHU_AGENT_REPLY_MODE"],
            "publishAs": runtime_env.get("FEISHU_AGENT_PUBLISH_AS") or DEFAULT_ENV["FEISHU_AGENT_PUBLISH_AS"],
            "asyncVisibleAck": runtime_env.get("FEISHU_AGENT_ASYNC_VISIBLE_ACK") or DEFAULT_ENV["FEISHU_AGENT_ASYNC_VISIBLE_ACK"],
            "fileAckReplyMode": runtime_env.get("FEISHU_AGENT_FILE_ACK_REPLY_MODE") or DEFAULT_ENV["FEISHU_AGENT_FILE_ACK_REPLY_MODE"],
            "asrProvider": asr_provider["provider"],
            "asrProviderRequested": asr_provider["requested"],
        },
        "supervisor": {
            "handlerHealthUrl": HANDLER_HEALTH_URL,
            "gatewayHealthMode": "process_and_ws_timeout_log_watch",
            "asrHealthMode": "provider_aware_local_asr_service_ctl_status",
            "asrRecoverEnabled": bool(args.asr_recover),
            "loadedEnvKeyNames": sorted(loaded_env_keys),
            "rawSecretValuesReturned": False,
        },
        "artifacts": {
            "statusPath": str(STATUS_PATH.relative_to(ROOT)),
            "eventsPath": str(EVENTS_PATH.relative_to(ROOT)),
            "healthReportPath": str(HEALTH_REPORT_PATH.relative_to(ROOT)),
        },
        "rawSecretsReturned": False,
        "rawMediaExternalUpload": False,
    }


def run(args: argparse.Namespace) -> int:
    SERVICE_DIR.mkdir(parents=True, exist_ok=True)
    PID_PATH.write_text(f"{os.getpid()}\n", encoding="utf-8")
    env_file = Path(args.env_file).expanduser().resolve() if args.env_file else ROOT / ".env.local"
    env, loaded_env_keys = base_env(env_file if args.load_env else None)
    services = build_services(args, env)
    started_at = now_iso()
    stop_requested = False

    def handle_signal(signum: int, _frame: Any) -> None:
        nonlocal stop_requested
        stop_requested = True
        append_event({"event": "supervisor_signal", "signal": signum})

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)
    append_event(
        {
            "event": "supervisor_started",
            "pid": os.getpid(),
            "envFileLoaded": bool(args.load_env and env_file.exists()),
            "loadedEnvKeyNames": sorted(loaded_env_keys),
            "serviceNames": sorted(services),
        },
    )

    for service in services.values():
        service.start(reason="initial_start")

    asr_failure_count = 0
    while not stop_requested:
        health: dict[str, Any] = {}
        for service in services.values():
            service.ensure_running()

        handler_health = http_health(f"http://{args.handler_host}:{args.handler_port}/health", args.health_timeout)
        health["feishu-handler"] = handler_health
        if handler_health.get("ok"):
            services["feishu-handler"].consecutive_health_failures = 0
        else:
            services["feishu-handler"].consecutive_health_failures += 1
            if services["feishu-handler"].consecutive_health_failures >= args.health_failure_threshold:
                services["feishu-handler"].restart(reason="handler_health_failed")
                services["feishu-handler"].consecutive_health_failures = 0

        gateway = services["feishu-gateway"]
        gateway_text, gateway.log_offset = tail_from(gateway.log_path, gateway.log_offset)
        timeout_hits = len(GATEWAY_TIMEOUT_RE.findall(gateway_text))
        gateway.gateway_timeout_hits += timeout_hits
        if gateway.gateway_timeout_hits >= args.gateway_timeout_threshold:
            gateway.restart(reason="gateway_ws_timeout_threshold")
            gateway.gateway_timeout_hits = 0
        gateway_running = gateway.running()
        health["feishu-gateway"] = {
            "ok": gateway_running,
            "status": "process_alive" if gateway_running else "down",
            "timeoutHitsSinceStart": gateway.gateway_timeout_hits,
            "handlerUrl": "http://127.0.0.1:8788/feishu/events",
            "tcp443Open": tcp_port_open("open.feishu.cn", 443, 1.0),
        }

        asr_provider = selected_asr_provider(env)
        asr = asr_status(args.asr_timeout)
        if asr.get("ok") or not asr_provider["localAsrRequired"]:
            asr_failure_count = 0
        else:
            asr_failure_count += 1
            if args.asr_recover and asr_failure_count >= args.asr_failure_threshold:
                recovery = asr_recover(args.asr_timeout)
                append_event({"event": "local_asr_recover_attempted", "result": recovery})
                asr = asr_status(args.asr_timeout)
                asr_failure_count = 0 if asr.get("ok") else asr_failure_count
        health["local-asr"] = asr

        status = status_document(services, health, args, loaded_env_keys, started_at, env)
        write_json(STATUS_PATH, status)
        write_json(HEALTH_REPORT_PATH, {"schemaVersion": "local-runtime-health-report-v1", **status})
        time.sleep(args.interval)

    append_event({"event": "supervisor_stopping", "pid": os.getpid()})
    for service in services.values():
        service.stop(timeout=8.0)
    final_status = {
        "schemaVersion": "local-runtime-supervisor-v1",
        "status": "stopped",
        "updatedAt": now_iso(),
        "supervisorPid": os.getpid(),
        "rawSecretsReturned": False,
        "rawMediaExternalUpload": False,
    }
    write_json(STATUS_PATH, final_status)
    PID_PATH.unlink(missing_ok=True)
    append_event({"event": "supervisor_stopped", "pid": os.getpid()})
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the local Feishu runtime supervisor")
    sub = parser.add_subparsers(dest="command", required=True)
    run_parser = sub.add_parser("run")
    run_parser.add_argument("--handler-host", default=HANDLER_HOST)
    run_parser.add_argument("--handler-port", type=int, default=HANDLER_PORT)
    run_parser.add_argument("--interval", type=float, default=5.0)
    run_parser.add_argument("--health-timeout", type=float, default=3.0)
    run_parser.add_argument("--asr-timeout", type=float, default=3.0)
    run_parser.add_argument("--health-failure-threshold", type=int, default=2)
    run_parser.add_argument("--gateway-timeout-threshold", type=int, default=3)
    run_parser.add_argument("--asr-failure-threshold", type=int, default=2)
    run_parser.add_argument("--asr-recover", action=argparse.BooleanOptionalAction, default=True)
    run_parser.add_argument("--load-env", action=argparse.BooleanOptionalAction, default=True)
    run_parser.add_argument("--env-file", default=str(ROOT / ".env.local"))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "run":
        return run(args)
    raise AssertionError(args.command)


if __name__ == "__main__":
    raise SystemExit(main())
