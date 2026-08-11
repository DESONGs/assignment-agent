#!/usr/bin/env python3
"""Unified local CI entry for the assignment-agent runtime.

Marker: local-ci-check-v1. Uses Docker.app fallback for docker compose config
and writes runtime-runs/_services/ci/latest.json.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
REPORT_DIR = ROOT / "runtime-runs" / "_services" / "ci"
LATEST_PATH = REPORT_DIR / "latest.json"
PYTHON_CACHE = Path("/tmp") / "assignment-agent-pycache"
DOCKER_FALLBACK = Path("/Applications/Docker.app/Contents/Resources/bin/docker")

PYTHON_COMPILE_TARGETS = [
    "meeting-agent-pi-package/tools/local_asr_http_service.py",
    "meeting-agent-pi-package/tools/local_asr_service_ctl.py",
    "meeting-agent-pi-package/tools/local_runtime_supervisor.py",
    "meeting-agent-pi-package/tools/local_runtime_ctl.py",
    "meeting-agent-pi-package/tools/local_ci_check.py",
    "meeting-agent-pi-package/tools/runtime_store_cli.py",
    "hermes-learning-sidecar/hermes_queue_worker.py",
]

NODE_CHECK_TARGETS = [
    "meeting-agent-pi-package/tools/asr_media_formats.mjs",
    "meeting-agent-pi-package/tools/asr_diarization_helpers.mjs",
    "meeting-agent-pi-package/tools/audio_normalize_helpers.mjs",
    "meeting-agent-pi-package/tools/dashscope_asr_client.mjs",
    "meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs",
    "meeting-agent-pi-package/tools/feishu_bot_event_gateway.mjs",
    "meeting-agent-pi-package/tools/feishu_event_runner.mjs",
    "meeting-agent-pi-package/tools/task_router.mjs",
    "meeting-agent-pi-package/tools/task_execution_runner.mjs",
    "meeting-agent-pi-package/tools/runtime_tool_cli.mjs",
    "meeting-agent-pi-package/tools/local_docker_runtime_queue.mjs",
    "meeting-agent-pi-package/tools/local_docker_document_worker.mjs",
    "meeting-agent-pi-package/tools/feishu_publish_taxonomy.mjs",
    "meeting-agent-pi-package/tools/feishu_publish_organize_cli.mjs",
    "meeting-agent-pi-package/tools/feishu_wiki_publish_helpers.mjs",
]

TS_CHECK_TARGETS = [
    "meeting-agent-pi-package/extensions/media-tools.ts",
    "meeting-agent-pi-package/extensions/rokid-tools.ts",
    "meeting-agent-pi-package/extensions/source-context-runtime.ts",
    "meeting-agent-pi-package/extensions/model-provider.ts",
    "meeting-agent-pi-package/extensions/model-routing.ts",
    "meeting-agent-pi-package/extensions/document-generation.ts",
    "meeting-agent-pi-package/extensions/document-worker-runtime.ts",
    "meeting-agent-pi-package/extensions/qa-gate.ts",
    "meeting-agent-pi-package/extensions/policy-gate.ts",
]


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def redact(value: str) -> str:
    text = str(value)
    for token_name in (
        "FEISHU_APP_SECRET",
        "DEEPSEEK_API_KEY",
        "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
        "LOCAL_ASR_BEARER_TOKEN",
        "ALIYUN_DASHSCOPE_API_KEY",
        "DASHSCOPE_API_KEY",
        "ALIBABA_CLOUD_ACCESS_KEY_ID",
        "ALIBABA_CLOUD_ACCESS_KEY_SECRET",
        "ALIBABA_CLOUD_SECURITY_TOKEN",
    ):
        token = os.environ.get(token_name)
        if token:
            text = text.replace(token, "[redacted]")
    return text[-6000:]


def run_command(label: str, command: list[str], *, cwd: Path = ROOT, timeout: float = 120.0) -> dict[str, Any]:
    started = time.time()
    try:
        completed = subprocess.run(command, cwd=str(cwd), text=True, capture_output=True, timeout=timeout)
        status = "passed" if completed.returncode == 0 else "failed"
        reason = None
        if label == "swift-test-agent-workbench" and completed.returncode != 0:
            combined = f"{completed.stdout}\n{completed.stderr}"
            if "SDK is not supported by the compiler" in combined or "Please select a toolchain which matches the SDK" in combined:
                status = "blocked"
                reason = "swift_toolchain_sdk_mismatch"
        return {
            "label": label,
            "status": status,
            **({"reason": reason} if reason else {}),
            "exitCode": completed.returncode,
            "durationMs": int((time.time() - started) * 1000),
            "command": command,
            "stdoutTail": redact(completed.stdout),
            "stderrTail": redact(completed.stderr),
        }
    except FileNotFoundError as exc:
        return {
            "label": label,
            "status": "blocked",
            "exitCode": None,
            "durationMs": int((time.time() - started) * 1000),
            "command": command,
            "error": str(exc),
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "label": label,
            "status": "failed",
            "exitCode": None,
            "durationMs": int((time.time() - started) * 1000),
            "command": command,
            "error": f"timeout_after_{timeout}s",
            "stdoutTail": redact(exc.stdout or ""),
            "stderrTail": redact(exc.stderr or ""),
        }


def parse_json_files() -> dict[str, Any]:
    started = time.time()
    failures: list[dict[str, str]] = []
    files = sorted(
        [
            *ROOT.glob("meeting-agent-pi-package/runtime/*.json"),
            *ROOT.glob("meeting-agent-pi-package/runtime/*.schema.json"),
            *ROOT.glob("src/schemas/*.json"),
            *ROOT.glob("runtime-runs/feishu-agent/*.json"),
        ],
    )
    for path in files:
        try:
            json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            failures.append({"path": str(path.relative_to(ROOT)), "error": str(exc)})
    return {
        "label": "json-parse-runtime-and-schemas",
        "status": "failed" if failures else "passed",
        "durationMs": int((time.time() - started) * 1000),
        "fileCount": len(files),
        "failures": failures,
    }


def docker_cli() -> str | None:
    found = shutil.which("docker")
    if found:
        return found
    if DOCKER_FALLBACK.exists():
        return str(DOCKER_FALLBACK)
    return None


def checks() -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    results.append(run_command("validate-workspace", ["python3", "src/validate_workspace.py"], timeout=180.0))
    existing_python_targets = [target for target in PYTHON_COMPILE_TARGETS if (ROOT / target).exists()]
    results.append(
        run_command(
            "python-py-compile-runtime-tools",
            [
                "env",
                f"PYTHONPYCACHEPREFIX={PYTHON_CACHE}",
                "python3",
                "-m",
                "py_compile",
                *existing_python_targets,
            ],
            timeout=180.0,
        ),
    )
    for target in NODE_CHECK_TARGETS:
        results.append(run_command(f"node-check:{target}", ["node", "--check", target], timeout=90.0))
    for target in TS_CHECK_TARGETS:
        results.append(run_command(f"ts-strip-check:{target}", ["node", "--experimental-strip-types", "--check", target], timeout=120.0))
    results.append(run_command("npm-test-meeting-agent", ["npm", "test"], cwd=ROOT / "meeting-agent-pi-package", timeout=180.0))
    results.append(parse_json_files())
    docker = docker_cli()
    if docker:
        results.append(run_command("docker-compose-local-runtime-config", [docker, "compose", "-f", "docker-compose.local-runtime.yml", "config"], timeout=120.0))
    else:
        results.append(
            {
                "label": "docker-compose-local-runtime-config",
                "status": "blocked",
                "reason": "docker_cli_not_found",
                "dockerAppFallback": str(DOCKER_FALLBACK),
            },
        )
    if (ROOT / "AgentWorkbench" / "Package.swift").exists():
        results.append(run_command("swift-test-agent-workbench", ["swift", "test"], cwd=ROOT / "AgentWorkbench", timeout=240.0))
    else:
        results.append({"label": "swift-test-agent-workbench", "status": "skipped", "reason": "AgentWorkbench missing"})
    return results


def write_report(report: dict[str, Any]) -> Path:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
    path = REPORT_DIR / f"local-ci-report-{timestamp}.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    LATEST_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def main() -> int:
    started = time.time()
    check_results = checks()
    failed = [item for item in check_results if item.get("status") == "failed"]
    blocked = [item for item in check_results if item.get("status") == "blocked"]
    status = "failed" if failed else "passed_with_environment_blockers" if blocked else "passed"
    report = {
        "schemaVersion": "local-ci-report-v1",
        "status": status,
        "startedAt": now_iso(),
        "durationMs": int((time.time() - started) * 1000),
        "workspace": str(ROOT),
        "checkCount": len(check_results),
        "failedCount": len(failed),
        "blockedCount": len(blocked),
        "checks": check_results,
        "suggestions": [
            "Use meeting-agent-pi-package/tools/local_runtime_ctl.py doctor for runtime health issues.",
            "Use Docker.app fallback when PATH does not expose docker.",
            "If swift-test-agent-workbench is blocked, run xcode-select/toolchain repair before treating Swift UI smoke as production-gated.",
        ],
        "rawSecretsReturned": False,
        "rawMediaExternalUpload": False,
    }
    path = write_report(report)
    print(
        json.dumps(
            {"status": report["status"], "reportPath": str(path.relative_to(ROOT)), "failedCount": len(failed), "blockedCount": len(blocked)},
            ensure_ascii=False,
            indent=2,
        ),
    )
    return 0 if not failed else 2


if __name__ == "__main__":
    raise SystemExit(main())
