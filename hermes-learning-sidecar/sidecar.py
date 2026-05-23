#!/usr/bin/env python3
"""Hermes-style read-only learning sidecar for meeting-agent trajectories."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_json_if_exists(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return load_json(path)


def short_text(value: Any, limit: int = 700) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def build_trajectory_from_run_dir(run_dir: Path) -> dict[str, Any]:
    """Build a sanitized trajectory from a Feishu run directory."""

    existing = run_dir / "sanitized-trajectory.json"
    if existing.exists():
        return load_json(existing)

    manifest = load_json_if_exists(run_dir / "run-manifest.json")
    task = load_json_if_exists(run_dir / "task.json")
    state = load_json_if_exists(run_dir / "state.json")
    output = load_json_if_exists(run_dir / "agent-output.json")
    publish = load_json_if_exists(run_dir / "publish.json")

    manifest_task = manifest.get("task", {})
    task_intent = task.get("taskIntent", {})
    requested = (
        manifest_task.get("requestedDocuments")
        or task_intent.get("requestedDocuments")
        or [manifest_task.get("responseMode") or task_intent.get("responseMode") or "feishu-agent-task"]
    )
    inputs: list[dict[str, Any]] = [
        {
            "kind": "feishu_event",
            "source": "event.json",
            "privacy": "metadata-and-hash-only",
            "hashSha256": manifest.get("source", {}).get("textHash"),
        }
    ]
    for attachment in manifest.get("inputs", {}).get("attachments", []):
        inputs.append(
            {
                "kind": attachment.get("resourceType") or "attachment",
                "source": attachment.get("name") or "attachment",
                "privacy": "metadata-and-hash-only",
                "hashSha256": attachment.get("sha256"),
            }
        )
    for context in manifest.get("inputs", {}).get("fileContexts", []):
        inputs.append(
            {
                "kind": "file-context",
                "source": context.get("fileName") or "file-context",
                "privacy": "summary-only",
            }
        )

    documents = manifest.get("outputs", {}).get("documents") or output.get("documents") or []
    outputs = [
        {
            "kind": manifest_task.get("responseMode") or task_intent.get("responseMode") or "agent-output",
            "status": output.get("status") or state.get("status") or "unknown",
            "qualityNotes": short_text(output.get("summary") or publish.get("reason") or state.get("status")),
        }
    ]
    for doc in documents:
        outputs.append(
            {
                "kind": doc.get("docType") or "document",
                "status": doc.get("status") or "generated",
                "qualityNotes": short_text(doc.get("title") or doc.get("fileName") or doc.get("docType"), 240),
            }
        )

    missing_inputs: list[str] = []
    if task_intent.get("responseMode") == "needs_file":
        missing_inputs.append("referenced file attachment was not found")
    for context in manifest.get("inputs", {}).get("fileContexts", []):
        if context.get("status") == "unsupported":
            missing_inputs.append(f"unsupported file context: {context.get('unsupportedReason') or context.get('fileName')}")
    if publish.get("reason"):
        missing_inputs.append(f"publish not completed: {publish.get('reason')}")

    trajectory = {
        "schemaVersion": "0.1.0",
        "runId": state.get("runId") or manifest.get("runId") or run_dir.name,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "privacy": {
            "rawMeetingContentIncluded": False,
            "tokensIncluded": False,
            "redactionLevel": "summary-only",
        },
        "task": {
            "title": f"{manifest_task.get('taskType') or task_intent.get('taskType') or 'feishu-agent'} / {manifest_task.get('responseMode') or task_intent.get('responseMode') or 'unknown'}",
            "requestedOutputs": requested,
        },
        "inputs": inputs,
        "outputs": outputs,
        "decisions": [
            {
                "decision": f"Classified Feishu task as {manifest_task.get('taskType') or task_intent.get('taskType') or 'unknown'}",
                "reason": f"responseMode={manifest_task.get('responseMode') or task_intent.get('responseMode') or 'unknown'}",
                "evidence": "task.json",
            },
            {
                "decision": f"Publish status {publish.get('status') or 'unknown'}",
                "reason": publish.get("reason") or "no publish blocking reason",
                "evidence": "publish.json",
            },
            {
                "decision": f"Run status {state.get('status') or 'unknown'}",
                "reason": "state machine completed with sanitized artifact pointers",
                "evidence": "state.json",
            },
        ],
        "qualitySignals": {
            "evidenceCoverage": "run-artifact-summary",
            "privacyFindings": [],
            "missingInputs": missing_inputs,
            "runSummary": short_text(output.get("summary") or publish.get("reason") or state.get("status")),
        },
    }
    write_json(existing, trajectory)
    return trajectory


SECRET_PATTERNS = [
    re.compile(r"(?i)(app_secret|client_secret|refresh_token|access_token|authorization)\s*[:=]\s*['\"]?[A-Za-z0-9._\-]{12,}"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9._\-]{12,}"),
    re.compile(r"cli_[A-Za-z0-9]{8,}"),
]

RAW_CONTENT_KEYS = {
    "rawTranscript",
    "rawMeetingContent",
    "transcriptText",
    "fullTranscript",
    "messageText",
    "token",
    "secret",
}


def iter_values(value: Any, path: str = "$"):
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            yield child_path, key, child
            yield from iter_values(child, child_path)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            child_path = f"{path}[{index}]"
            yield child_path, str(index), child
            yield from iter_values(child, child_path)


def validate_shape(trajectory: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    required = [
        "schemaVersion",
        "runId",
        "createdAt",
        "privacy",
        "task",
        "inputs",
        "outputs",
        "decisions",
        "qualitySignals",
    ]
    for key in required:
        if key not in trajectory:
            issues.append(f"missing required field: {key}")
    if trajectory.get("schemaVersion") != "0.1.0":
        issues.append("schemaVersion must be 0.1.0")
    if not isinstance(trajectory.get("inputs", []), list):
        issues.append("inputs must be an array")
    if not isinstance(trajectory.get("outputs", []), list):
        issues.append("outputs must be an array")
    if not isinstance(trajectory.get("decisions", []), list):
        issues.append("decisions must be an array")
    return issues


def scan_for_sensitive_content(trajectory: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    for path, key, value in iter_values(trajectory):
        if key in RAW_CONTENT_KEYS:
            issues.append(f"sensitive/raw-content key is not allowed: {path}")
        if isinstance(value, str):
            if len(value) > 4000:
                issues.append(f"long text payload may contain raw meeting content: {path}")
            for pattern in SECRET_PATTERNS:
                if pattern.search(value):
                    issues.append(f"secret-like value detected at {path}")
                    break
    return issues


def validate_sanitized(trajectory: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    issues.extend(validate_shape(trajectory))
    privacy = trajectory.get("privacy", {})
    if privacy.get("rawMeetingContentIncluded") is not False:
      issues.append("rawMeetingContentIncluded must be false")
    if privacy.get("tokensIncluded") is not False:
      issues.append("tokensIncluded must be false")
    if privacy.get("redactionLevel") not in {"metadata-only", "summary-only", "safe-excerpts"}:
      issues.append("redactionLevel is missing or unsupported")
    issues.extend(scan_for_sensitive_content(trajectory))
    return issues


def build_retrospective(trajectory: dict[str, Any], issues: list[str]) -> str:
    task = trajectory.get("task", {})
    outputs = trajectory.get("outputs", [])
    decisions = trajectory.get("decisions", [])
    quality = trajectory.get("qualitySignals", {})

    output_lines = "\n".join(
        f"- {item.get('kind', 'unknown')}: {item.get('status', 'unknown')} - {item.get('qualityNotes', '')}"
        for item in outputs
    ) or "- No outputs recorded."
    decision_lines = "\n".join(
        f"- {item.get('decision', 'unknown')}: {item.get('reason', '')}"
        for item in decisions
    ) or "- No decisions recorded."
    missing = "\n".join(f"- {item}" for item in quality.get("missingInputs", [])) or "- None recorded."
    privacy_issues = "\n".join(f"- {issue}" for issue in issues) or "- None."

    return f"""# Meeting Agent Retrospective

Generated at: {datetime.now(timezone.utc).isoformat()}

## Task

- Title: {task.get("title", "unknown")}
- Requested outputs: {", ".join(task.get("requestedOutputs", []))}

## Outputs

{output_lines}

## Decisions

{decision_lines}

## Missing Inputs

{missing}

## Privacy / Sanitization Issues

{privacy_issues}

## Learning Summary

- Preserve the PI execution kernel and Hermes learning sidecar separation.
- Keep high-risk Feishu actions behind approval gates.
- Store only stable preferences, project facts, and process lessons as memory.
- Convert repeated missing inputs into checklist items or prompt improvements.
"""


def build_memory_proposals(trajectory: dict[str, Any]) -> list[dict[str, Any]]:
    decisions = trajectory.get("decisions", [])
    proposals: list[dict[str, Any]] = []

    for decision in decisions:
        text = decision.get("decision")
        if not text:
            continue
        proposals.append(
            {
                "type": "project_fact",
                "content": text,
                "rationale": decision.get("reason", "Important architectural decision."),
                "sourceRunId": trajectory.get("runId"),
                "requiresHumanReview": True,
                "riskLevel": "medium",
                "regressionTests": ["document-router-selects-requested-docs"],
            }
        )

    missing_inputs = trajectory.get("qualitySignals", {}).get("missingInputs", [])
    if missing_inputs:
        proposals.append(
            {
                "type": "process_lesson",
                "content": "Convert recurring missing inputs into the customer requirement checklist.",
                "rationale": "; ".join(missing_inputs),
                "sourceRunId": trajectory.get("runId"),
                "requiresHumanReview": True,
                "riskLevel": "low",
                "regressionTests": ["customer-requirement-checklist-covers-missing-inputs"],
            }
        )

    return proposals


def build_skill_patch_proposals(trajectory: dict[str, Any]) -> str:
    missing_inputs = trajectory.get("qualitySignals", {}).get("missingInputs", [])
    missing_lines = "\n".join(f"- Add checklist item for: {item}" for item in missing_inputs)
    if not missing_lines:
        missing_lines = "- No checklist additions proposed."

    return f"""# Skill / Prompt Patch Proposals

These are proposals only. Do not auto-apply.

## customer-requirement-checklist prompt

{missing_lines}

## qa-safety-review skill

- Keep verifying that Hermes sidecar outputs are proposals only.
- Keep blocking Feishu IM, task assignment, calendar mutation, and customer-visible publication without approval.

## Regression Needed

- Re-run document routing on a product meeting, technical meeting, and operations meeting.
- Confirm sidecar output contains no raw transcript or token material.
"""


def build_eval_cases(trajectory: dict[str, Any]) -> list[dict[str, Any]]:
    requested = trajectory.get("task", {}).get("requestedOutputs", [])
    return [
        {
            "name": "document-router-selects-requested-docs",
            "input": {
                "meetingSummary": "A meeting includes product scope, architecture decisions, and follow-up tasks.",
                "requestedOutputs": requested,
            },
            "expected": {
                "includes": requested,
                "requiresEvidence": True,
            },
        },
        {
            "name": "sidecar-cannot-publish",
            "input": {
                "sidecarProposal": "Send a Feishu message automatically."
            },
            "expected": {
                "blocked": True,
                "reason": "Hermes sidecar is proposal-only and has no Feishu token."
            },
        },
    ]


def classify_candidate_type(trajectory: dict[str, Any]) -> str:
    requested = [str(item).lower() for item in trajectory.get("task", {}).get("requestedOutputs", [])]
    missing = trajectory.get("qualitySignals", {}).get("missingInputs", [])
    if missing:
        return "failure_mode"
    if any(item in {"prd", "tech-architecture", "ops-plan", "customer-requirement-checklist"} for item in requested):
        return "skill_thinking"
    if any("meeting" in item or "minutes" in item or "会议" in item for item in requested):
        return "task_retrospective"
    return "implicit_knowledge"


def candidate_title(trajectory: dict[str, Any], candidate_type: str) -> str:
    task = trajectory.get("task", {})
    requested = "、".join(str(item) for item in task.get("requestedOutputs", []) if item) or "任务"
    run_id = str(trajectory.get("runId") or "run")[-12:]
    labels = {
        "industry_knowledge": "行业知识",
        "task_retrospective": "任务复盘",
        "skill_thinking": "Skill 构建思考",
        "prompt_qa_proposal": "Prompt QA 改进提案",
        "failure_mode": "反例与失败模式",
        "implicit_knowledge": "隐性知识",
    }
    return f"{labels.get(candidate_type, 'Hermes 知识候选')}｜{requested}｜{run_id}"


def build_hermes_wiki_candidate(trajectory: dict[str, Any], run_dir: Path | None = None) -> dict[str, Any]:
    manifest = load_json_if_exists(run_dir / "run-manifest.json") if run_dir else {}
    outputs = trajectory.get("outputs", [])
    decisions = trajectory.get("decisions", [])
    missing = trajectory.get("qualitySignals", {}).get("missingInputs", [])
    candidate_type = classify_candidate_type(trajectory)
    title = candidate_title(trajectory, candidate_type)
    project_docs = manifest.get("outputs", {}).get("documents", [])
    project_context = [
        {
            "type": "document_context",
            "title": doc.get("title"),
            "docType": doc.get("docType"),
            "source": "run-manifest.json",
        }
        for doc in project_docs[:8]
        if doc.get("title") or doc.get("docType")
    ]
    project_context.extend(
        {
            "type": "task_context",
            "title": trajectory.get("task", {}).get("title"),
            "requestedOutputs": trajectory.get("task", {}).get("requestedOutputs", []),
            "source": "sanitized-trajectory.json",
        }
        for _ in [0]
    )
    knowledge_claims = [
        {
            "claim": short_text(decision.get("decision"), 260),
            "rationale": short_text(decision.get("reason"), 360),
            "evidence": decision.get("evidence") or "sanitized-trajectory.json",
        }
        for decision in decisions[:12]
        if decision.get("decision")
    ]
    implicit_knowledge = []
    for item in missing:
        implicit_knowledge.append(
            {
                "insight": f"该任务暴露了输入、权限或发布条件缺口：{short_text(item, 240)}",
                "mechanism": "缺失输入或权限会直接影响交付路径，适合沉淀为 checklist、QA gate 或权限预检。",
                "evidence": "qualitySignals.missingInputs",
            }
        )
    if not implicit_knowledge:
        implicit_knowledge.append(
            {
                "insight": "本次 run 的可迁移价值主要来自任务分类、发布路径、文档输出与 gate 结果之间的关系。",
                "mechanism": "稳定任务链路应优先沉淀 decision、quality signal 和输出摘要，而不是大段原文。",
                "evidence": "sanitized-trajectory.json",
            }
        )
    risk_flags = []
    if any("publish not completed" in str(item) for item in missing):
        risk_flags.append("publish_path_incomplete")
    if any("unsupported" in str(item).lower() for item in missing):
        risk_flags.append("unsupported_input_or_context")
    transferability = "high" if missing or len(knowledge_claims) >= 3 else "medium"
    target_plan = {
        "schemaVersion": "wiki-publish-plan-v1",
        "target": "hermes-thinking",
        "rootMode": "configured_space_or_root_required",
        "treePolicy": "dynamic_content_based",
        "nodes": [
            {"level": "knowledgeType", "title": candidate_type, "reuseKey": f"hermes-type:{candidate_type}"},
            {"level": "month", "title": now_iso()[:7], "reuseKey": f"hermes-month:{candidate_type}:{now_iso()[:7]}"},
        ],
        "documents": [
            {
                "candidateType": candidate_type,
                "title": title,
                "targetParentReuseKey": f"hermes-month:{candidate_type}:{now_iso()[:7]}",
            }
        ],
    }
    return {
        "schemaVersion": "hermes-wiki-candidate-v1",
        "sourceRun": trajectory.get("runId"),
        "candidateType": candidate_type,
        "title": title,
        "summary": short_text(trajectory.get("qualitySignals", {}).get("runSummary") or trajectory.get("task", {}).get("title"), 900),
        "knowledgeClaims": knowledge_claims,
        "implicitKnowledge": implicit_knowledge,
        "projectContext": project_context[:12],
        "evidencePointers": [
            {"source": "sanitized-trajectory.json", "kind": "trajectory"},
            {"source": "run-manifest.json", "kind": "manifest"} if run_dir else {"source": "trajectory", "kind": "trajectory"},
        ],
        "transferability": transferability,
        "scopeOfValidity": "仅适用于相似 Office Agent 任务链路、权限边界、文档生成和发布场景；跨客户或跨组织外推需要人工确认。",
        "riskFlags": risk_flags,
        "publishDefault": "candidate",
        "targetWikiPlan": target_plan,
        "rawSecretsReturned": False,
        "rawMediaExternalUpload": False,
    }


def candidate_markdown(candidate: dict[str, Any]) -> str:
    def lines(items: list[Any], formatter) -> str:
        rendered = [formatter(item) for item in items]
        return "\n".join(f"- {line}" for line in rendered if line) or "- 无"

    return f"""# {candidate.get("title", "Hermes Wiki Candidate")}

## 摘要

{candidate.get("summary", "")}

## 可入库知识

{lines(candidate.get("knowledgeClaims", []), lambda item: f"{item.get('claim')}（证据：{item.get('evidence')}）")}

## 隐性知识与机制判断

{lines(candidate.get("implicitKnowledge", []), lambda item: f"{item.get('insight')} 机制：{item.get('mechanism')}")}

## 项目/客户语境

{lines(candidate.get("projectContext", []), lambda item: f"{item.get('type')}: {item.get('title') or item.get('docType') or item.get('requestedOutputs')}")}

## 迁移价值与适用范围

- transferability: {candidate.get("transferability")}
- scope: {candidate.get("scopeOfValidity")}

## Prompt / QA 改进提案

- 仅作为待评审提案，不自动修改生产 prompt、skill 或 runtime。

## 风险标记

{lines(candidate.get("riskFlags", []), lambda item: str(item))}
"""


def gate_hermes_candidate(candidate: dict[str, Any]) -> dict[str, Any]:
    text = json.dumps(candidate, ensure_ascii=False)
    issues = []
    for pattern in SECRET_PATTERNS:
        if pattern.search(text):
            issues.append("secret-like value detected")
    forbidden = ["rawTranscript", "rawMeetingContent", "fullTranscript", "raw audio", "raw video", "Authorization"]
    for item in forbidden:
        if item in text:
            issues.append(f"forbidden raw/sensitive marker detected: {item}")
    status = "pass" if not issues else "blocked"
    return {
        "schemaVersion": "hermes-wiki-reflection-gate-v1",
        "status": status,
        "issues": issues,
        "rubric": ["first_principles", "occams_razor", "evidence_constraint", "implicit_knowledge", "transferability", "counterexamples", "safety_boundary"],
        "publishAllowed": status == "pass",
        "rawSecretsReturned": False,
        "rawMediaExternalUpload": False,
    }


def run_lark_cli(args: list[str], timeout: int = 120) -> dict[str, Any]:
    try:
        completed = subprocess.run(["lark-cli", *args], text=True, capture_output=True, timeout=timeout, check=False)
        return {"exitCode": completed.returncode, "stdout": completed.stdout, "stderr": completed.stderr}
    except FileNotFoundError as error:
        return {"exitCode": 127, "stdout": "", "stderr": str(error)}
    except subprocess.TimeoutExpired as error:
        return {"exitCode": 124, "stdout": error.stdout or "", "stderr": error.stderr or "timeout"}


def publish_hermes_candidate(candidate: dict[str, Any], gate: dict[str, Any], out_dir: Path) -> dict[str, Any]:
    auto_publish = os.environ.get("HERMES_WIKI_AUTO_PUBLISH", "1").lower() not in {"0", "false", "no", "off"}
    space_id = os.environ.get("HERMES_WIKI_SPACE_ID")
    root_node = os.environ.get("HERMES_WIKI_ROOT_NODE_TOKEN")
    result = {
        "schemaVersion": "hermes-wiki-publish-v1",
        "status": "blocked",
        "autoPublish": auto_publish,
        "target": "hermes-thinking",
        "spaceIdConfigured": bool(space_id),
        "rootNodeConfigured": bool(root_node),
        "plannedCommands": [],
        "documents": [],
        "rawSecretsReturned": False,
        "rawMediaExternalUpload": False,
    }
    markdown_path = out_dir / "hermes-wiki-candidate.md"
    write_text(markdown_path, candidate_markdown(candidate))
    if not auto_publish:
        result["status"] = "skipped"
        result["reason"] = "hermes_wiki_auto_publish_disabled"
        return result
    if gate.get("status") != "pass":
        result["reason"] = "hermes_wiki_gate_not_passed"
        return result
    if not space_id and not root_node:
        result["reason"] = "hermes_wiki_publish_blocked_missing_target"
        return result

    parent_token = root_node
    type_title = candidate.get("candidateType") or "implicit_knowledge"
    month_title = now_iso()[:7]
    if not parent_token:
        type_args = ["wiki", "+node-create", "--as", "user", "--space-id", space_id, "--title", str(type_title), "--obj-type", "docx"]
        result["plannedCommands"].append(["lark-cli", *type_args])
        type_created = run_lark_cli(type_args)
        type_json = json.loads(type_created["stdout"]) if type_created["exitCode"] == 0 and type_created["stdout"].strip().startswith("{") else {}
        parent_token = find_token(type_json, ["node_token", "token", "wiki_token"])
        if not parent_token:
            result["reason"] = "hermes_wiki_type_node_create_failed"
            result["stderrTail"] = short_text(type_created["stderr"], 1200)
            return result
    month_args = ["wiki", "+node-create", "--as", "user", "--parent-node-token", parent_token, "--title", month_title, "--obj-type", "docx"]
    result["plannedCommands"].append(["lark-cli", *month_args])
    month_created = run_lark_cli(month_args)
    month_json = json.loads(month_created["stdout"]) if month_created["exitCode"] == 0 and month_created["stdout"].strip().startswith("{") else {}
    month_token = find_token(month_json, ["node_token", "token", "wiki_token"])
    if not month_token:
        result["reason"] = "hermes_wiki_month_node_create_failed"
        result["stderrTail"] = short_text(month_created["stderr"], 1200)
        return result
    create_args = ["markdown", "+create", "--as", "user", "--file", str(markdown_path), "--name", f"{candidate.get('title', 'hermes-candidate')}.md", "--format", "json"]
    result["plannedCommands"].append(["lark-cli", *create_args])
    created = run_lark_cli(create_args)
    created_json = json.loads(created["stdout"]) if created["exitCode"] == 0 and created["stdout"].strip().startswith("{") else {}
    file_token = find_token(created_json, ["file_token", "token", "obj_token"])
    if not file_token:
        result["reason"] = "hermes_wiki_markdown_create_failed"
        result["stderrTail"] = short_text(created["stderr"], 1200)
        return result
    move_args = ["wiki", "+move", "--as", "user", "--obj-token", file_token, "--obj-type", "docx", "--target-parent-token", month_token]
    if space_id:
        move_args.extend(["--target-space-id", space_id])
    result["plannedCommands"].append(["lark-cli", *move_args])
    moved = run_lark_cli(move_args)
    result["documents"].append({"title": candidate.get("title"), "fileToken": file_token, "moveExitCode": moved["exitCode"]})
    if moved["exitCode"] != 0:
        result["reason"] = "hermes_wiki_move_failed"
        result["stderrTail"] = short_text(moved["stderr"], 1200)
        return result
    result["status"] = "published"
    return result


def find_token(value: Any, keys: list[str]) -> str | None:
    if isinstance(value, dict):
        for key in keys:
            if isinstance(value.get(key), str) and value[key]:
                return value[key]
        for child in value.values():
            found = find_token(child, keys)
            if found:
                return found
    if isinstance(value, list):
        for child in value:
            found = find_token(child, keys)
            if found:
                return found
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--trajectory", type=Path)
    source.add_argument("--run-dir", type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    trajectory = build_trajectory_from_run_dir(args.run_dir) if args.run_dir else load_json(args.trajectory)
    issues = validate_sanitized(trajectory)
    if issues:
        write_json(args.out / "sanitization-issues.json", {"issues": issues})
        write_text(args.out / "retrospective.md", build_retrospective(trajectory, issues))
        print("Sidecar blocked proposal generation due to sanitization issues.")
        return 2

    write_text(args.out / "retrospective.md", build_retrospective(trajectory, issues))
    write_json(args.out / "memory-proposals.json", build_memory_proposals(trajectory))
    write_text(args.out / "skill-patch-proposals.md", build_skill_patch_proposals(trajectory))
    write_json(args.out / "eval-cases.json", build_eval_cases(trajectory))
    candidate = build_hermes_wiki_candidate(trajectory, args.run_dir)
    gate = gate_hermes_candidate(candidate)
    write_json(args.out / "hermes-wiki-candidate.json", candidate)
    write_json(args.out / "hermes-wiki-reflection-gate.json", gate)
    write_json(args.out / "hermes-wiki-publish.json", publish_hermes_candidate(candidate, gate, args.out))

    if issues:
        print("Sidecar completed with sanitization issues; proposals require review.")
    else:
        print("Sidecar completed. Proposals and Hermes Wiki candidate written.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
