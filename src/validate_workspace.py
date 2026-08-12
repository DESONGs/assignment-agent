#!/usr/bin/env python3
"""Validate the meeting-agent workspace structure and direct CLI defaults."""

from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def project_wiki_root() -> Path:
    return ROOT / "wiki"


REQUIRED_SKILLS = [
    "meeting-minutes",
    "meeting-agentic-orchestration",
    "meeting-memory-curation",
    "document-router",
    "document-generation",
    "document-worker-runtime",
    "model-provider",
    "feishu-workflow",
    "feishu-agent-bridge",
    "feishu-bot-gateway",
    "rokid-lingzhu-workflow",
    "qa-safety-review",
    "runtime-observability",
    "capability-registry",
    "planner-runtime",
    "policy-gate",
    "agent-team-runtime",
    "context-offload",
]

REQUIRED_AGENT_ROLES = [
    "meeting-action-reviewer.md",
    "meeting-decision-reviewer.md",
    "meeting-evidence-analyst.md",
    "meeting-evidence-synthesizer.md",
    "meeting-memory-curator.md",
    "office-source-analyst.md",
    "office-deliverable-reviewer.md",
]

REQUIRED_PROMPTS = [
    "meeting-minutes.md",
    "prd.md",
    "tech-architecture.md",
    "ops-plan.md",
    "customer-requirement-checklist.md",
]

REQUIRED_EXTENSIONS = [
    "feishu-bot-gateway.ts",
    "feishu-tools.ts",
    "media-tools.ts",
    "model-routing.ts",
    "model-provider.ts",
    "qa-gate.ts",
    "rokid-tools.ts",
    "runtime-observability.ts",
    "capability-registry.ts",
    "planner-runtime.ts",
    "policy-gate.ts",
    "document-generation.ts",
    "document-worker-runtime.ts",
    "agent-team-runtime.ts",
    "context-offload.ts",
    "source-context-runtime.ts",
    "office-runtime.ts",
    "meeting-agentic-orchestrator.ts",
]

REQUIRED_RUNTIME_FILES = [
    "capability-registry.json",
    "metrics.schema.json",
    "model-routing.json",
    "model-providers.json",
    "model-providers.schema.json",
    "document-prompt-registry.json",
    "document-prompt-registry.schema.json",
    "package-audit.schema.json",
    "planner-envelope.schema.json",
    "policy-gate.schema.json",
    "qa-gate.schema.json",
    "feishu-event.schema.json",
    "feishu-task.schema.json",
    "feishu-run-state.schema.json",
    "file-context.schema.json",
    "im-event.schema.json",
    "im-attachment.schema.json",
    "im-reply.schema.json",
    "publish-target.schema.json",
    "office-task-state.schema.json",
    "office-context.schema.json",
    "office-object.schema.json",
    "document-lifecycle.schema.json",
    "document-review-context.schema.json",
    "retrieval-index.schema.json",
    "source-context.schema.json",
    "wiki-publish-plan.schema.json",
    "feishu-wiki-target-registry.schema.json",
    "execution-profiles.json",
    "execution-profiles.schema.json",
    "asr-providers.json",
    "asr-providers.schema.json",
    "tool-load-manifest.json",
]

REQUIRED_EXECUTION_PROFILES = [
    "fast_answer",
    "file_summary",
    "audio_minutes",
    "document_generation",
    "document_revision",
    "multi_source_synthesis",
    "publish_only",
    "unsupported",
]

LIGHT_PROFILE_SKIPPED_STAGE_ALIASES = {
    "document_workers": ("document_workers", "document_worker", "document worker", "document-worker", "document_workers_run"),
    "qa_gate": ("qa_gate", "qa gate", "qa-gate", "qa_gate_evaluate"),
    "policy_gate": ("policy_gate", "policy gate", "policy-gate", "policy_gate_check"),
    "publish": ("publish", "publisher", "wiki_publish", "feishu_publish", "customer_visible"),
}

PROFILE_REQUIRED_MARKER_ALIASES = {
    "audio_minutes": {
        "audio_normalize": ("audio_normalize", "audio normalize", "audio-normalize", "audio_normalized"),
        "asr_transcribe": ("asr_transcribe", "asr provider", "asr_provider_resolved", "cloud_asr", "local_asr"),
        "local_asr": ("local_asr", "local ASR", "local-asr", "meeting_transcribe_local_asr"),
        "meeting_minutes": ("meeting_minutes", "meeting minutes", "meeting-minutes"),
    },
    "document_generation": {
        "prompt_registry": ("prompt_registry", "prompt registry", "document-prompt-registry", "document_prompt_render_batch"),
        "document_workers": ("document_workers", "document worker", "document-worker", "document_workers_run"),
    },
}

CAPABILITY_TRACE_ALLOWED_PACKAGES = {
    "third-party",
    "third-party-or-mcp",
    "external",
    "external-service",
    "system",
    "system-tool",
    "mcp",
    "lark-cli",
}


def fail(message: str) -> None:
    raise SystemExit(f"ERROR: {message}")


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def normalized_marker(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value).lower())


def normalized_json_text(value: object) -> str:
    return normalized_marker(json.dumps(value, ensure_ascii=False))


def marker_present(value: object, aliases: tuple[str, ...] | list[str] | set[str]) -> bool:
    text = normalized_json_text(value)
    return any(normalized_marker(alias) in text for alias in aliases)


def profile_declares_stage_disabled(node: object, aliases: tuple[str, ...]) -> bool:
    if isinstance(node, dict):
        for key, value in node.items():
            normalized_key = normalized_marker(key)
            if any(normalized_marker(alias) in normalized_key for alias in aliases):
                if value is False:
                    return True
                if isinstance(value, str) and normalized_marker(value) in {"false", "never", "none", "disabled", "skip", "skipped", "off"}:
                    return True
                if isinstance(value, dict) and value.get("const") is False:
                    return True
            if profile_declares_stage_disabled(value, aliases):
                return True
    elif isinstance(node, list):
        return any(profile_declares_stage_disabled(item, aliases) for item in node)
    return False


def profile_declares_stage_enabled(node: object, aliases: tuple[str, ...]) -> bool:
    if isinstance(node, dict):
        for key, value in node.items():
            normalized_key = normalized_marker(key)
            if any(normalized_marker(alias) in normalized_key for alias in aliases):
                if value is True:
                    return True
                if isinstance(value, str) and normalized_marker(value) in {"true", "required", "enabled", "include", "included", "run", "whenrequired"}:
                    return True
            if profile_declares_stage_enabled(value, aliases):
                return True
    elif isinstance(node, list):
        return any(profile_declares_stage_enabled(item, aliases) for item in node)
    return False


def collect_values_for_keys(node: object, key_aliases: tuple[str, ...], excluded_key_aliases: tuple[str, ...] = ()) -> list[object]:
    values = []
    if isinstance(node, dict):
        for key, value in node.items():
            normalized_key = normalized_marker(key)
            matches_key = any(normalized_marker(alias) in normalized_key for alias in key_aliases)
            excluded = any(normalized_marker(alias) in normalized_key for alias in excluded_key_aliases)
            if matches_key and not excluded:
                values.append(value)
            values.extend(collect_values_for_keys(value, key_aliases, excluded_key_aliases))
    elif isinstance(node, list):
        for item in node:
            values.extend(collect_values_for_keys(item, key_aliases, excluded_key_aliases))
    return values


def profile_by_id(profiles_config: dict) -> dict[str, dict]:
    raw_profiles = profiles_config.get("profiles", {})
    profiles: dict[str, dict] = {}
    if isinstance(raw_profiles, list):
        for item in raw_profiles:
            if not isinstance(item, dict):
                continue
            profile_id = item.get("profileId") or item.get("id") or item.get("name") or item.get("executionProfile")
            if isinstance(profile_id, str):
                profiles[profile_id] = item
    elif isinstance(raw_profiles, dict):
        for profile_id, item in raw_profiles.items():
            if isinstance(item, dict):
                profiles[str(profile_id)] = {"profileId": str(profile_id), **item}
            else:
                profiles[str(profile_id)] = {"profileId": str(profile_id), "value": item}
    return profiles


def assert_profile_skips(profile_id: str, profile: dict, stage_aliases: dict[str, tuple[str, ...]]) -> None:
    skip_values = collect_values_for_keys(profile, ("skip", "disabled", "omit", "exclude", "block"))
    skip_blob = {"skip": skip_values}
    for stage, aliases in stage_aliases.items():
        if not marker_present(skip_blob, aliases) and not profile_declares_stage_disabled(profile, aliases):
            fail(f"execution profile {profile_id} must skip {stage}")
        if profile_declares_stage_enabled(profile, aliases):
            fail(f"execution profile {profile_id} must not enable skipped stage {stage}")

    active_values = collect_values_for_keys(
        profile,
        ("required", "optional", "default", "enabled", "include", "run", "stage", "pipeline"),
        ("skip", "disabled", "omit", "exclude", "block"),
    )
    active_blob = {"active": active_values}
    for stage, aliases in stage_aliases.items():
        if marker_present(active_blob, aliases):
            fail(f"execution profile {profile_id} must not enable skipped stage {stage}")


def assert_profile_contains(profile_id: str, profile: dict, required_markers: dict[str, tuple[str, ...]]) -> None:
    for marker_name, aliases in required_markers.items():
        if not marker_present(profile, aliases):
            fail(f"execution profile {profile_id} missing required marker: {marker_name}")


def validate_execution_profile_contract(runtime_root: Path) -> None:
    profiles_config = load_json(runtime_root / "execution-profiles.json")
    schema = load_json(runtime_root / "execution-profiles.schema.json")
    profiles = profile_by_id(profiles_config)
    missing_profiles = set(REQUIRED_EXECUTION_PROFILES) - set(profiles)
    if missing_profiles:
        fail(f"execution-profiles.json missing profiles: {sorted(missing_profiles)}")

    schema_text = normalized_json_text(schema)
    for profile_id in REQUIRED_EXECUTION_PROFILES:
        if normalized_marker(profile_id) not in schema_text:
            fail(f"execution-profiles.schema.json missing profile marker: {profile_id}")

    for profile_id in ("fast_answer", "file_summary"):
        assert_profile_skips(profile_id, profiles[profile_id], LIGHT_PROFILE_SKIPPED_STAGE_ALIASES)

    for profile_id, required_markers in PROFILE_REQUIRED_MARKER_ALIASES.items():
        assert_profile_contains(profile_id, profiles[profile_id], required_markers)

    unsupported = profiles["unsupported"]
    for forbidden, aliases in {
        "model": ("model", "model_route", "model-routing", "model_generate_text"),
        "worker": ("worker", "document_workers", "document-worker"),
        "publish": ("publish", "publisher", "wiki_publish", "feishu_publish"),
    }.items():
        active_values = collect_values_for_keys(
            unsupported,
            ("required", "optional", "default", "enabled", "include", "run", "stage", "pipeline"),
            ("skip", "disabled", "omit", "exclude", "block"),
        )
        if marker_present({"active": active_values}, aliases):
            fail(f"execution profile unsupported must not enable {forbidden} stages")


def validate_tool_load_manifest(runtime_root: Path) -> None:
    manifest = load_json(runtime_root / "tool-load-manifest.json")
    manifest_text = json.dumps(manifest, ensure_ascii=False)
    for marker in ("defaultTools", "profileTools"):
        if marker not in manifest_text:
            fail(f"tool-load-manifest.json missing marker: {marker}")

    extension_root = ROOT / "meeting-agent-pi-package" / "extensions"
    profile_tools = manifest.get("profileTools", {})
    if not isinstance(profile_tools, dict):
        fail("tool-load-manifest.json profileTools must be an object")
    for profile_id in REQUIRED_EXECUTION_PROFILES:
        if profile_id not in profile_tools:
            fail(f"tool-load-manifest.json missing profileTools entry: {profile_id}")
    for section_name in ("defaultTools", "coreTools"):
        tools = manifest.get(section_name, [])
        if tools is not None and not isinstance(tools, list):
            fail(f"tool-load-manifest.json {section_name} must be a list")
    for profile_id, tools in profile_tools.items():
        if not isinstance(tools, list):
            fail(f"tool-load-manifest.json profileTools.{profile_id} must be a list")
        for tool_file in tools:
            if not isinstance(tool_file, str) or not re.match(r"^[A-Za-z0-9_.-]+\.(?:js|mjs|ts)$", tool_file):
                fail(f"tool-load-manifest.json unsafe extension reference for {profile_id}: {tool_file}")
            if not (extension_root / tool_file).exists():
                fail(f"tool-load-manifest.json references missing extension for {profile_id}: {tool_file}")
    for profile_id in ("file_summary", "audio_minutes", "document_generation", "document_revision", "multi_source_synthesis"):
        if "source-context-runtime.ts" not in profile_tools.get(profile_id, []):
            fail(f"tool-load-manifest.json profileTools.{profile_id} must load source-context-runtime.ts")


def explicit_capability_sources(capability: dict) -> list[str]:
    sources = []
    for key, value in capability.items():
        normalized_key = normalized_marker(key)
        if not any(marker in normalized_key for marker in ("source", "extension", "skill", "prompt")):
            continue
        if isinstance(value, str):
            sources.append(value)
        elif isinstance(value, list):
            sources.extend(item for item in value if isinstance(item, str))
        elif isinstance(value, dict):
            sources.extend(item for item in value.values() if isinstance(item, str))
    return sources


def capability_source_exists(source: str) -> bool:
    package_root = ROOT / "meeting-agent-pi-package"
    if not re.match(r"^[A-Za-z0-9_./-]+$", source):
        return False
    path = (package_root / source).resolve()
    allowed_roots = [
        (package_root / "extensions").resolve(),
        (package_root / "skills").resolve(),
        (package_root / "prompts").resolve(),
    ]
    return path.exists() and any(root == path or root in path.parents for root in allowed_roots)


def capability_trace_markers(capability_id: str) -> set[str]:
    markers = {
        capability_id,
        capability_id.replace("-", "_"),
        capability_id.replace("_", "-"),
    }
    parts = [part for part in re.split(r"[-_]+", capability_id) if part]
    if len(parts) > 1:
        markers.add(" ".join(parts))
        markers.add("_".join(parts))
        markers.add("-".join(parts))
    if capability_id.startswith("feishu-"):
        markers.add(capability_id.removeprefix("feishu-"))
    if capability_id.endswith("-runtime"):
        markers.add(capability_id.removesuffix("-runtime"))
    if capability_id.endswith("-service"):
        markers.add(capability_id.removesuffix("-service"))
    if "review-context" in capability_id:
        markers.update({"review-context", "reviewContext", "document_revision"})
    if capability_id == "doc-writer":
        markers.update({"document-generation", "document_prompt", "document-prompt-registry"})
    if capability_id == "file-context-service":
        markers.update({"file-context", "fileContext"})
    if capability_id == "local-asr":
        markers.update({"local_asr", "meeting_transcribe_local_asr", "LOCAL_ASR"})
    if capability_id == "cloud-asr":
        markers.update({"cloud_asr", "meeting_transcribe_cloud_asr", "dashscope_asr_client", "ALIYUN_DASHSCOPE_API_KEY"})
    if capability_id == "model-fallback":
        markers.update({"model_route", "model-routing", "automaticFallback"})
    if capability_id == "calendar-task":
        markers.update({"calendar_task", "calendar", "mutate_calendar"})
    if capability_id == "rokid-import":
        markers.update({"rokid-tools", "Rokid", "Lingzhu"})
    return {normalized_marker(marker) for marker in markers if marker}


def validate_capability_traceability(capabilities: list[dict]) -> None:
    package_root = ROOT / "meeting-agent-pi-package"
    source_paths = [
        *sorted((package_root / "extensions").glob("*.ts")),
        *sorted((package_root / "skills").glob("*/SKILL.md")),
        *sorted((package_root / "prompts").glob("*.md")),
    ]
    source_index = []
    for path in source_paths:
        text = path.read_text(encoding="utf-8")
        source_index.append((path, normalized_marker(path.stem), normalized_marker(path.parent.name), normalized_marker(text)))

    for capability in capabilities:
        capability_id = capability.get("capabilityId")
        if not isinstance(capability_id, str) or not capability_id:
            fail("capability registry entry missing capabilityId")
        package = str(capability.get("toolPackage", "")).lower()
        status = str(capability.get("status", "")).lower()
        allowed_untraced = package in CAPABILITY_TRACE_ALLOWED_PACKAGES or (
            status == "candidate" and any(token in package for token in ("third-party", "external", "mcp", "system"))
        )
        if any(capability_source_exists(source) for source in explicit_capability_sources(capability)):
            continue
        markers = capability_trace_markers(capability_id)
        traced = False
        for _path, stem_marker, parent_marker, text_marker in source_index:
            if normalized_marker(capability_id) in {stem_marker, parent_marker}:
                traced = True
                break
            if any(marker in text_marker for marker in markers):
                traced = True
                break
        if not traced and not allowed_untraced:
            fail(f"capability registry entry {capability_id} is not traced to an extension, skill, prompt, or allowed external/system category")


def iter_schema_fields(node: object, path: str = ""):
    if isinstance(node, dict):
        for key, value in node.items():
            field_path = f"{path}.{key}" if path else key
            yield field_path, key, value
            yield from iter_schema_fields(value, field_path)
    elif isinstance(node, list):
        for index, item in enumerate(node):
            yield from iter_schema_fields(item, f"{path}[{index}]")


def validate_public_contract_schema(schema_name: str, schema: dict) -> None:
    required = set(schema.get("required", []))
    for field in ("sourceRun", "version", "channel", "context"):
        if field not in required:
            fail(f"{schema_name} must require {field}")

    security_flags_seen = set()
    for field_path, key, value in iter_schema_fields(schema):
        normalized_key = re.sub(r"[^a-z0-9]", "", key.lower())
        if "rawsecretsreturned" in normalized_key:
            security_flags_seen.add("rawSecretsReturned")
            if not isinstance(value, dict):
                fail(f"{schema_name} must define {field_path} as a false constant")
            if value.get("const") is not False:
                fail(f"{schema_name} must constrain {field_path} to false")
            if value.get("default") is True:
                fail(f"{schema_name} must not default {field_path} to true")
            enum_values = value.get("enum", [])
            if isinstance(enum_values, list) and True in enum_values:
                fail(f"{schema_name} must not allow true for {field_path}")

    if "rawSecretsReturned" not in security_flags_seen:
        fail(f"{schema_name} must include rawSecretsReturned false marker")


def validate_package() -> None:
    package = load_json(ROOT / "meeting-agent-pi-package" / "package.json")
    if "pi-package" not in package.get("keywords", []):
        fail("meeting-agent-pi-package must include the pi-package keyword")

    project_pi_settings = load_json(ROOT / ".pi" / "settings.json")
    if project_pi_settings.get("packages") != ["../meeting-agent-pi-package"]:
        fail(".pi/settings.json package paths resolve from .pi and must load ../meeting-agent-pi-package")
    compaction = project_pi_settings.get("compaction", {})
    if compaction != {"enabled": True, "reserveTokens": 16384, "keepRecentTokens": 20000}:
        fail(".pi/settings.json must use Pi native compaction with the tested budgets")
    subagents = project_pi_settings.get("subagents", {})
    if subagents.get("projectRootResolution") != "git-root":
        fail(".pi/settings.json must anchor project subagents at git root")

    if package.get("engines", {}).get("node") != ">=22.19.0":
        fail("meeting-agent-pi-package must declare the Pi 0.84-compatible Node baseline")
    dependencies = package.get("dependencies", {})
    if dependencies.get("pi-subagents") != "0.46.0":
        fail("meeting-agent-pi-package must pin audited pi-subagents@0.46.0")
    if dependencies.get("@quintinshaw/pi-dynamic-workflows") != "3.5.1":
        fail("meeting-agent-pi-package must pin audited pi-dynamic-workflows@3.5.1")
    if package.get("devDependencies", {}).get("@earendil-works/pi-coding-agent") != "0.84.1":
        fail("meeting-agent-pi-package must pin the tested Pi 0.84.1 development runtime")
    if (ROOT / ".nvmrc").read_text(encoding="utf-8").strip() != "22.23.1":
        fail(".nvmrc must pin the tested Node 22.23.1 runtime")

    pi = package.get("pi", {})
    for key in ("extensions", "skills", "prompts"):
        if key not in pi:
            fail(f"package.json missing pi.{key}")
    manifest_text = json.dumps(pi, ensure_ascii=False)
    for marker in ("pi-subagents/index.ts", "pi-dynamic-workflows/extensions/workflow.ts"):
        if marker not in manifest_text:
            fail(f"package.json Pi manifest missing audited agentic resource: {marker}")

    lock = load_json(ROOT / "meeting-agent-pi-package" / "package-lock.json")
    locked = lock.get("packages", {})
    expected_locked = {
        "node_modules/pi-subagents": "0.46.0",
        "node_modules/@quintinshaw/pi-dynamic-workflows": "3.5.1",
        "node_modules/@earendil-works/pi-coding-agent": "0.84.1",
        "node_modules/ws": "8.21.3",
        "node_modules/protobufjs": "7.6.5",
    }
    for path, version in expected_locked.items():
        if locked.get(path, {}).get("version") != version:
            fail(f"package-lock.json must pin {path}@{version}")

    for audit_name in ("pi-subagents-0.46.0.json", "pi-dynamic-workflows-3.5.1.json"):
        audit = load_json(ROOT / "meeting-agent-pi-package" / "runtime" / "package-audits" / audit_name)
        if audit.get("decision") != "passed_smoke_lazy_enable":
            fail(f"package audit must record passed smoke decision: {audit_name}")

    meeting_workflow = (ROOT / "meeting-agent-pi-package" / "tools" / "meeting_workflow_helpers.mjs").read_text(
        encoding="utf-8"
    )
    for marker in (
        "workflowScript",
        'runs.run(\"meeting-review\"',
        'context: "fresh"',
        "outputSchema",
        "buildPiSubagentRequest",
        "completenessCheck",
        "verify",
    ):
        if marker not in meeting_workflow:
            fail(f"meeting workflow helper missing current Pi package API marker: {marker}")
    if "request: {\n              agent:" in meeting_workflow:
        fail("meeting workflow helper still uses the removed top-level pi-subagents agent/task launch form")

    pi_orchestration = (ROOT / "meeting-agent-pi-package" / "tools" / "pi_meeting_orchestration_helpers.mjs").read_text(
        encoding="utf-8"
    )
    for marker in (
        "buildPiMeetingOrchestrationInvocation",
        "parsePiMeetingOrchestrationOutput",
        "reconcilePiMeetingOrchestrationResult",
        "shouldRunPiMeetingOrchestration",
        '"read,subagent,workflow"',
        '"--no-session"',
        "product_owner_enabled",
        "invalidSegmentIds",
        "missingEvidencePaths",
    ):
        if marker not in pi_orchestration:
            fail(f"Pi meeting orchestration helper missing execution marker: {marker}")

    memory_agent = (ROOT / ".pi" / "agents" / "meeting-memory-curator.md").read_text(encoding="utf-8")
    for marker in (
        "name: meeting-memory-curator",
        "tools: read",
        "scope: project",
        "path: meeting-memory",
        "defaultContext: fresh",
        "只返回结构化候选",
    ):
        if marker not in memory_agent:
            fail(f"meeting memory curator agent missing marker: {marker}")

    for role_name in REQUIRED_AGENT_ROLES:
        role_path = ROOT / ".pi" / "agents" / role_name
        if not role_path.exists():
            fail(f"missing Pi agent role {role_name}")
        role_text = role_path.read_text(encoding="utf-8")
        if not role_text.startswith("---") or "tools: read" not in role_text:
            fail(f"Pi agent role must be frontmatter-defined and read-only: {role_name}")

    memory_helper = (ROOT / "meeting-agent-pi-package" / "tools" / "meeting_memory_helpers.mjs").read_text(encoding="utf-8")
    for marker in (
        "meeting-memory-candidates-v1",
        "meeting-memory-curation-result-v1",
        "buildMeetingMemoryCuratorPlan",
        'mode: "single_subagent"',
        'tool: "subagent"',
        '"read,subagent"',
        'structuredOutputMode: "parent_validated_json"',
        'acceptance: { level: "none"',
        "reconcileMeetingMemoryCandidates",
        "meetingMemoryPayloadShapeValid",
        "segment_outside_current_meeting",
        "memory_key_conflict_requires_review",
        "memory_content_not_grounded_in_source_claim",
        "persistMeetingMemory",
        "meeting_memory_write_lock_timeout",
        ".pi/agent-memory/meeting-memory",
    ):
        if marker not in memory_helper:
            fail(f"meeting memory helper missing marker: {marker}")


def validate_skills() -> None:
    for name in REQUIRED_SKILLS:
        path = ROOT / "meeting-agent-pi-package" / "skills" / name / "SKILL.md"
        if not path.exists():
            fail(f"missing skill {name}")
        text = path.read_text(encoding="utf-8")
        if not text.startswith("---"):
            fail(f"skill {name} missing YAML frontmatter")
        if f"name: {name}" not in text:
            fail(f"skill {name} frontmatter name mismatch")
        if "description:" not in text:
            fail(f"skill {name} missing description")

    minutes = (ROOT / "meeting-agent-pi-package" / "skills" / "meeting-minutes" / "SKILL.md").read_text(
        encoding="utf-8"
    )
    for marker in ("meetingTitle", "titleBasis", "feishuFileName", "Feishu Markdown/document names", "meetingProfile", "siblingForbiddenTerms"):
        if marker not in minutes:
            fail(f"meeting-minutes skill missing title sync marker: {marker}")

    qa = (ROOT / "meeting-agent-pi-package" / "skills" / "qa-safety-review" / "SKILL.md").read_text(
        encoding="utf-8"
    )
    for marker in ("Title sync", "Text evidence", "participant-map.json", "needs_review", "unsupportedEntities", "crossMeetingTerms", "ambiguousTermExpansions", "omittedMacroTopics"):
        if marker not in qa:
            fail(f"qa-safety-review skill missing relaxed text-evidence marker: {marker}")

    document_generation = (ROOT / "meeting-agent-pi-package" / "skills" / "document-generation" / "SKILL.md").read_text(
        encoding="utf-8"
    )
    for marker in (
        "document_prompt_select",
        "document_prompt_render",
        "document_prompt_render_batch",
        "document-prompt-registry.json",
        "unmappedDocuments",
        "without hardcoded document scaffolds",
        "workUnits",
        "contextEnvelopeRef",
    ):
        if marker not in document_generation:
            fail(f"document-generation skill missing prompt-registry marker: {marker}")

    document_worker = (ROOT / "meeting-agent-pi-package" / "skills" / "document-worker-runtime" / "SKILL.md").read_text(
        encoding="utf-8"
    )
    for marker in (
        "document_workers_plan",
        "document_workers_run",
        "contextPackRef",
        "contextPackId",
        "model-route.json",
        "taskIndex",
        "sectionBatching",
        "sectionsPerBatch",
        "sectionBatches",
        "repairAttempts",
        "missingSections",
    ):
        if marker not in document_worker:
            fail(f"document-worker-runtime skill missing marker: {marker}")

    model_provider = (ROOT / "meeting-agent-pi-package" / "skills" / "model-provider" / "SKILL.md").read_text(
        encoding="utf-8"
    )
    for marker in ("model_provider_check", "model_generate_text", "DEEPSEEK_API_KEY", "XIAOMI_BASE_URL", "model_route_plan"):
        if marker not in model_provider:
            fail(f"model-provider skill missing marker: {marker}")

    feishu_bridge = (ROOT / "meeting-agent-pi-package" / "skills" / "feishu-agent-bridge" / "SKILL.md").read_text(
        encoding="utf-8"
    )
    for marker in (
        "feishu_event_runner",
        "feishu_agent_task_handler",
        "lark-cli event consume",
        "document-prompt-registry",
        "section-batched document workers",
        "QA Gate",
        "Policy Gate",
        "Meeting media and transcript content may be used by selected capabilities",
        "file-context",
        "task_execution_runner",
        "office-task-state",
        "im-event-v1",
        "目前暂不支持该功能",
    ):
        if marker not in feishu_bridge:
            fail(f"feishu-agent-bridge skill missing marker: {marker}")


def validate_docs_ignore_legacy_warning() -> None:
    gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
    for marker in (
        ".env.local",
        "__pycache__/",
        "*.pyc",
        "runtime-runs/",
        "models/",
        "qa-runs/**/*.json",
        "qa-runs/**/*.jsonl",
        "!qa-runs/**/README.md",
        "!qa-runs/**/.non-production",
    ):
        if marker not in gitignore:
            fail(f".gitignore missing generated-artifact marker: {marker}")

    qa_root = ROOT / "qa-runs"
    if not (qa_root / "README.md").exists():
        fail("qa-runs/README.md non-production warning is required")
    qa_warning = (qa_root / "README.md").read_text(encoding="utf-8")
    for marker in ("legacy, non-production evidence", "pointer", "production-style artifacts"):
        if marker not in qa_warning:
            fail(f"qa-runs/README.md missing warning marker: {marker}")

    for run_dir in sorted(path for path in qa_root.iterdir() if path.is_dir()):
        readme = run_dir / "README.md"
        marker = run_dir / ".non-production"
        if not readme.exists():
            fail(f"{run_dir.relative_to(ROOT)} missing README.md non-production warning")
        if not marker.exists():
            fail(f"{run_dir.relative_to(ROOT)} missing .non-production marker")
        text = readme.read_text(encoding="utf-8")
        for required in ("Non-Production Legacy QA Run", "production"):
            if required not in text:
                fail(f"{readme.relative_to(ROOT)} missing legacy warning marker: {required}")


def validate_required_behavior_docs() -> None:
    wiki_root = project_wiki_root()
    docs = {
        "README.md": ROOT / "README.md",
        "agent.md": ROOT / "agent.md",
        "meeting-agent-pi-package/README.md": ROOT / "meeting-agent-pi-package" / "README.md",
        "AgentWorkbench/README.md": ROOT / "AgentWorkbench" / "README.md",
        "wiki/README.md": wiki_root / "README.md",
        "wiki/00-plan.md": wiki_root / "00-plan.md",
        "wiki/01-prd.md": wiki_root / "01-prd.md",
        "wiki/02-agent-architecture.md": wiki_root / "02-agent-architecture.md",
        "wiki/03-system-prompts.md": wiki_root / "03-system-prompts.md",
        "wiki/04-skill-design.md": wiki_root / "04-skill-design.md",
        "wiki/05-feishu-rokid-permissions.md": wiki_root / "05-feishu-rokid-permissions.md",
        "wiki/06-agent-team-index.md": wiki_root / "06-agent-team-index.md",
        "wiki/07-test-plan.md": wiki_root / "07-test-plan.md",
        "wiki/11-current-project-architecture.md": wiki_root / "11-current-project-architecture.md",
        "wiki/12-feishu-agent-bidirectional-integration-plan.md": wiki_root / "12-feishu-agent-bidirectional-integration-plan.md",
        "wiki/13-office-agent-product-technical-review.md": wiki_root / "13-office-agent-product-technical-review.md",
        "wiki/14-local-data-storage-cache-backend.md": wiki_root / "14-local-data-storage-cache-backend.md",
        "wiki/issues/README.md": wiki_root / "issues" / "README.md",
    }

    for name, path in docs.items():
        if not path.exists():
            fail(f"missing current documentation file: {name}")

    combined = "\n".join(path.read_text(encoding="utf-8") for path in docs.values())
    for marker in (
        "2026-08-12",
        "auth-status-summary",
        "secret-scan",
        "Meeting Intelligence",
        "pi-subagents@0.46.0",
        "pi-dynamic-workflows@3.5.1",
        "tool_execution_end",
        "evidenceSegmentIds",
        "rawMediaExternalUpload",
        "model-route.json",
        "Agentic Planner",
        "Policy Gate",
        "Capability Registry",
        "Planner Envelope",
        "planner-selectable capability descriptions",
        "policy_gate_check",
        "package audit/install mechanism",
        "plannerDecisions",
        "policyDecisions",
        "workerDecisions",
        "capabilitySelections",
        "packageAudits",
        "document-prompt-registry.json",
        "document_prompt_render_batch",
        "document_workers_run",
        "feishu_event_runner.mjs",
        "feishu_agent_task_handler.mjs",
        "目前暂不支持该功能",
        "Host-owned SQLite",
        "Docker worker 不直接写 SQLite",
        "meeting-memory-curator",
        "Pi 原生 Compaction",
    ):
        if marker not in combined:
            fail(f"required behavior docs missing marker: {marker}")

    architecture = docs["wiki/02-agent-architecture.md"].read_text(encoding="utf-8")
    for marker in (
        "系统上下文",
        "Agent 角色关系",
        "运行控制面",
        "会议黄金流程",
        "委派决策",
        "Sub-agent / Workflow 执行时序",
        "证据、状态与产物关系",
        "飞书闭环",
        "失败与降级",
        "flowchart",
        "sequenceDiagram",
        "erDiagram",
    ):
        if marker not in architecture:
            fail(f"agent architecture doc missing marker: {marker}")
    if architecture.count("```mermaid") < 8:
        fail("agent architecture doc must include at least eight Mermaid architecture/relationship/flow diagrams")

    for directory in ("issues", "plan", "problem", "retrospective", "thinking"):
        if not (wiki_root / directory / "README.md").exists():
            fail(f"historical wiki directory missing archive README: wiki/{directory}/README.md")

    if (ROOT / "assigment agent wiki").exists():
        fail("obsolete misspelled wiki directory must not exist")
    if (ROOT / "hermes-learning-sidecar").exists():
        fail("removed Hermes sidecar directory must not exist")

    current_runtime_files = [
        ROOT / "docker-compose.local-runtime.yml",
        ROOT / "meeting-agent-pi-package" / "package.json",
        ROOT / "meeting-agent-pi-package" / "runtime" / "wiki-publish-plan.schema.json",
        ROOT / "meeting-agent-pi-package" / "tools" / "feishu_agent_task_handler.mjs",
        ROOT / "meeting-agent-pi-package" / "tools" / "local_ci_check.py",
    ]
    forbidden_current_markers = (
        "hermes-worker",
        "HERMES_WIKI",
        "pi:hermes-worker:jobs",
        "sanitized-trajectory.json",
        "hermes-thinking",
    )
    for path in current_runtime_files:
        text = path.read_text(encoding="utf-8")
        for marker in forbidden_current_markers:
            if marker in text:
                fail(f"removed Hermes production marker remains in {path.relative_to(ROOT)}: {marker}")

    markdown_paths = [
        ROOT / "README.md",
        ROOT / "agent.md",
        ROOT / "meeting-agent-pi-package" / "README.md",
        ROOT / "AgentWorkbench" / "README.md",
        ROOT / "AgentWorkbench" / "P0_ACCEPTANCE.md",
        *sorted(wiki_root.rglob("*.md")),
    ]
    link_pattern = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")
    for path in markdown_paths:
        text = path.read_text(encoding="utf-8")
        if text.count("```") % 2 != 0:
            fail(f"unbalanced Markdown code fence: {path.relative_to(ROOT)}")
        for target in link_pattern.findall(text):
            target = target.strip().split(" ", 1)[0].strip("<>")
            if not target or target.startswith(("#", "http://", "https://", "mailto:")):
                continue
            local_target = target.split("#", 1)[0].split("?", 1)[0].replace("%20", " ")
            if not local_target:
                continue
            resolved = (path.parent / local_target).resolve()
            if not resolved.exists():
                fail(f"broken Markdown link in {path.relative_to(ROOT)}: {target}")


def validate_prompts() -> None:
    for name in REQUIRED_PROMPTS:
        path = ROOT / "meeting-agent-pi-package" / "prompts" / name
        if not path.exists():
            fail(f"missing prompt {name}")
        text = path.read_text(encoding="utf-8")
        if text.count("{{input}}") != 1:
            fail(f"prompt {name} should include exactly one {{input}} placeholder")
        for marker in ("输入理解规则", "推断", "待确认", "质量自检"):
            if name != "meeting-minutes.md" and marker not in text:
                fail(f"prompt {name} missing deep document prompt marker: {marker}")
        if name != "meeting-minutes.md":
            for marker in ("Document Router Conclusion", "Evidence Summary", "Document Title Plan", "不编造"):
                if marker not in text:
                    fail(f"prompt {name} missing evidence/router boundary marker: {marker}")
        if "{{input}}" not in text:
            fail(f"prompt {name} should include {{input}} placeholder")

    meeting_prompt = (ROOT / "meeting-agent-pi-package" / "prompts" / "meeting-minutes.md").read_text(
        encoding="utf-8"
    )
    for marker in (
        "meetingTitle",
        "titleBasis",
        "feishuFileName",
        "Document Title Plan",
        "Markdown H1 必须等于 `meetingTitle`",
        "Meeting Intelligence",
        "participantResolution",
        "quality=needs_review",
        "已达成共识",
        "meetingProfile",
        "topicMap",
        "evidenceMap",
        "agentPlan",
    ):
        if marker not in meeting_prompt:
            fail(f"meeting-minutes prompt missing title/permission marker: {marker}")


def validate_extensions() -> None:
    for name in REQUIRED_EXTENSIONS:
        path = ROOT / "meeting-agent-pi-package" / "extensions" / name
        if not path.exists():
            fail(f"missing extension {name}")
        text = path.read_text(encoding="utf-8")
        if "export default function" not in text:
            fail(f"extension {name} missing default PI factory")
        if "pi.registerTool({" not in text:
            fail(f"extension {name} should register at least one tool")
        if re.search(r"pi\.registerTool\(\s*\{[\s\S]*?\}\s*,\s*async", text):
            fail(f"extension {name} uses old two-argument registerTool shape")

    feishu = (ROOT / "meeting-agent-pi-package" / "extensions" / "feishu-tools.ts").read_text(encoding="utf-8")
    for marker in ('name: "feishu_cli"', '"lark-cli"', "official-lark-cli-passthrough"):
        if marker not in feishu:
            fail(f"feishu-tools.ts missing official CLI passthrough marker: {marker}")
    for marker in (
        "redactionPolicy",
        "auth-status-summary",
        "secret-scan",
        "isAuthStatusCommand",
        "summarizeAuthStatus",
        "Raw lark-cli auth status output may contain account metadata",
        "rawOutputReturned",
        "identityRedacted",
    ):
        if marker not in feishu:
            fail(f"feishu-tools.ts missing auth status redaction marker: {marker}")
    if 'params.redactionPolicy ?? "secret-scan"' not in feishu:
        fail("feishu_cli must default to secret-scan for non-auth CLI output")
    if re.search(r"isAuthStatusCommand\(params\.args\)[\s\S]{0,240}runLarkCli", feishu):
        fail("auth status guard must run before lark-cli execution")
    for removed_marker in (
        "feishu_prepare_operation",
        "feishu_execute_approved_operation",
        "feishu_record_publish_result",
        "isApproved",
        "messagePreviewHash",
        "FeishuOperationKind",
    ):
        if removed_marker in feishu:
            fail(f"feishu-tools.ts still contains removed custom wrapper marker: {removed_marker}")

    approval = ROOT / "meeting-agent-pi-package" / "extensions" / "approval-gates.ts"
    if approval.exists():
        fail("approval-gates.ts should be removed; Policy Gate owns only credential and high-impact action boundaries")

    approval_store = ROOT / "meeting-agent-pi-package" / "extensions" / "approval-store.ts"
    if approval_store.exists():
        fail("approval-store.ts should not exist in official CLI passthrough mode")

    feishu_skill = (ROOT / "meeting-agent-pi-package" / "skills" / "feishu-workflow" / "SKILL.md").read_text(
        encoding="utf-8"
    )
    for marker in ("auth-status-summary", "Raw `lark-cli auth status` output is L4", "identityRedacted"):
        if marker not in feishu_skill:
            fail(f"feishu-workflow skill missing auth redaction guidance: {marker}")

    bot_gateway = (ROOT / "meeting-agent-pi-package" / "extensions" / "feishu-bot-gateway.ts").read_text(
        encoding="utf-8"
    )
    for marker in (
        "feishu_bot_gateway_plan",
        "feishu_bot_gateway_check",
        "im.message.receive_v1",
        "mcpRequiredForChatReply",
        "localhostOnlyByDefault",
    ):
        if marker not in bot_gateway:
            fail(f"feishu-bot-gateway.ts missing gateway marker: {marker}")

    media_tools = (ROOT / "meeting-agent-pi-package" / "extensions" / "media-tools.ts").read_text(encoding="utf-8")
    for marker in (
        "normalizeLocalAsrServiceUrl",
        "LOCAL_ASR_SERVICE_URL must point to localhost",
        "LOCAL_ASR_BEARER_TOKEN",
        "transcriptSegmentsRetainedInToolOutput: false",
        "rawTranscriptPointerRequired",
    ):
        if marker not in media_tools:
            fail(f"media-tools.ts missing ASR/context boundary marker: {marker}")
    if "transcriptSegments: params.transcriptSegments" in media_tools:
        fail("meeting_build_evidence_index must not return raw transcriptSegments in tool output")

    bot_skill = (ROOT / "meeting-agent-pi-package" / "skills" / "feishu-bot-gateway" / "SKILL.md").read_text(
        encoding="utf-8"
    )
    for marker in ("im.message.receive_v1", "MCP is not required", "FEISHU_APP_SECRET", "FEISHU_AGENT_ASYNC"):
        if marker not in bot_skill:
            fail(f"feishu-bot-gateway skill missing guidance marker: {marker}")

    feishu_event_runner = ROOT / "meeting-agent-pi-package" / "tools" / "feishu_event_runner.mjs"
    feishu_task_handler = ROOT / "meeting-agent-pi-package" / "tools" / "feishu_agent_task_handler.mjs"
    feishu_bot_gateway = ROOT / "meeting-agent-pi-package" / "tools" / "feishu_bot_event_gateway.mjs"
    im_file_context_helpers = ROOT / "meeting-agent-pi-package" / "tools" / "im_file_context_helpers.mjs"
    asr_media_formats = ROOT / "meeting-agent-pi-package" / "tools" / "asr_media_formats.mjs"
    asr_diarization_helpers = ROOT / "meeting-agent-pi-package" / "tools" / "asr_diarization_helpers.mjs"
    audio_normalize_helpers = ROOT / "meeting-agent-pi-package" / "tools" / "audio_normalize_helpers.mjs"
    wechat_event_adapter = ROOT / "meeting-agent-pi-package" / "tools" / "wechat_event_adapter.mjs"
    task_execution_runner = ROOT / "meeting-agent-pi-package" / "tools" / "task_execution_runner.mjs"
    task_router = ROOT / "meeting-agent-pi-package" / "tools" / "task_router.mjs"
    runtime_tool_cli = ROOT / "meeting-agent-pi-package" / "tools" / "runtime_tool_cli.mjs"
    local_asr_service_ctl = ROOT / "meeting-agent-pi-package" / "tools" / "local_asr_service_ctl.py"
    feishu_wiki_publish = ROOT / "meeting-agent-pi-package" / "tools" / "feishu_wiki_publish_helpers.mjs"
    feishu_publish_taxonomy = ROOT / "meeting-agent-pi-package" / "tools" / "feishu_publish_taxonomy.mjs"
    feishu_publish_organize = ROOT / "meeting-agent-pi-package" / "tools" / "feishu_publish_organize_cli.mjs"
    feishu_document_review_context = ROOT / "meeting-agent-pi-package" / "tools" / "feishu_document_review_context_helpers.mjs"
    local_runtime_supervisor = ROOT / "meeting-agent-pi-package" / "tools" / "local_runtime_supervisor.py"
    local_runtime_ctl = ROOT / "meeting-agent-pi-package" / "tools" / "local_runtime_ctl.py"
    local_ci_check = ROOT / "meeting-agent-pi-package" / "tools" / "local_ci_check.py"
    for path in (feishu_event_runner, feishu_task_handler, feishu_bot_gateway):
        if not path.exists():
            fail(f"missing Feishu bridge tool: {path.relative_to(ROOT)}")
    for path in (im_file_context_helpers, asr_media_formats, asr_diarization_helpers, audio_normalize_helpers, wechat_event_adapter):
        if not path.exists():
            fail(f"missing shared IM/file-context tool: {path.relative_to(ROOT)}")
    for path in (task_execution_runner, runtime_tool_cli):
        if not path.exists():
            fail(f"missing task execution runtime tool: {path.relative_to(ROOT)}")
    if not local_asr_service_ctl.exists():
        fail("missing local ASR lifecycle tool: meeting-agent-pi-package/tools/local_asr_service_ctl.py")
    if not task_router.exists():
        fail("missing task router tool: meeting-agent-pi-package/tools/task_router.mjs")
    if not feishu_wiki_publish.exists():
        fail("missing Feishu Wiki publish helper")
    if not feishu_publish_taxonomy.exists():
        fail("missing Feishu publish taxonomy helper")
    if not feishu_publish_organize.exists():
        fail("missing Feishu publish organization CLI")
    if not feishu_document_review_context.exists():
        fail("missing Feishu document review context helper")
    for path in (local_runtime_supervisor, local_runtime_ctl, local_ci_check):
        if not path.exists():
            fail(f"missing local production runtime tool: {path.relative_to(ROOT)}")
    runner_text = feishu_event_runner.read_text(encoding="utf-8")
    for marker in (
        "lark-cli",
        "event",
        "consume",
        "feishu_event_runner_output_root_outside_workspace_blocked",
        "feishu_agent_handler_remote_blocked",
        "normalizeEvent",
        "duplicate_event",
        "source-events.ndjson",
        "trimmed.startsWith(\"{\")",
        "message?.text",
        "rootId",
    ):
        if marker not in runner_text:
            fail(f"feishu_event_runner.mjs missing marker: {marker}")
    handler_text = feishu_task_handler.read_text(encoding="utf-8")
    file_context_helper_text = im_file_context_helpers.read_text(encoding="utf-8")
    asr_media_formats_text = asr_media_formats.read_text(encoding="utf-8")
    asr_diarization_text = asr_diarization_helpers.read_text(encoding="utf-8")
    for marker in (
        "prepareFileDiarization",
        "DIARIZATION_RECOMMENDED_MAX_DURATION_SECONDS",
        "cloud_asr_speaker_count_invalid",
        "enabled_mono_prepared",
        "best_effort_diarization_not_source_separation",
    ):
        if marker not in asr_diarization_text:
            fail(f"asr_diarization_helpers.mjs missing file diarization marker: {marker}")
    wiki_publish_text = feishu_wiki_publish.read_text(encoding="utf-8")
    publish_taxonomy_text = feishu_publish_taxonomy.read_text(encoding="utf-8")
    publish_organize_text = feishu_publish_organize.read_text(encoding="utf-8")
    review_context_text = feishu_document_review_context.read_text(encoding="utf-8")
    task_router_text = task_router.read_text(encoding="utf-8")
    handler_context_text = f"{handler_text}\n{task_router_text}\n{file_context_helper_text}\n{asr_media_formats_text}\n{wiki_publish_text}\n{publish_taxonomy_text}\n{publish_organize_text}\n{review_context_text}"
    for marker in (
        "feishu_agent_task_handler",
        "feishu-run-state-v1",
        "feishu-task-v1",
        "FEISHU_AGENT_ASYNC",
        "FEISHU_AGENT_ASYNC_VISIBLE_ACK",
        "FEISHU_AGENT_FILE_ACK_REPLY_MODE",
        "suppressGatewayReply",
        "publishStatus",
        "replyStatus",
        "im +messages-resources-download",
        "document-prompt-registry",
        "section-batched document workers",
        "QA Gate",
        "Policy Gate",
        "markdown +create",
        "markdown +overwrite",
        "drive +create-folder",
        "FEISHU_AGENT_PUBLISH_TARGET",
        "wiki-publish-plan.json",
        "wiki-publish.json",
        "feishu-wiki-target-registry.json",
        "wiki_publish_blocked_drive_fallback",
        "im +messages-reply",
        "rawMediaExternalUpload: false",
        "file-context-v1",
        "AUDIO_EXTENSIONS",
        "asr_transcription",
        "feishu-publish-target-registry-v2",
        "publish-taxonomy.json",
        "project_workspace",
        "projectEntries",
        "legacySessionMappings",
        "destructive_action_not_supported",
        "recent_attachment_cache",
        "parent_message_resource",
        "run-manifest.json",
        "meetingMemoryCuration",
        "run.metrics.json",
        "PI_CLI_BIN",
        "direct_answer_no_document_publish",
        "task_execution_runner",
        "progress-replies.ndjson",
        "目前暂不支持该功能",
        "sourcePreparation",
        "sourceReferences",
        "explicitFileReference",
        "explicit_file_reference_present_no_cache_fallback",
        "expectedCacheKindsForText",
        "current attachments and explicit URLs outrank",
        "ack_only",
        "ack_file_cached_silent",
        "runner_live_reply",
        "progress_reply_disabled_for_two_phase_stable_runtime",
        "local_reuse_current_run",
        "local_reuse_cached_attachment",
        "local_reuse_after_cli_failed",
        "local_reuse_store_artifact",
        "local_reuse_historical_run_artifact",
        "FEISHU_AGENT_ATTACHMENT_DOWNLOAD_AS",
        "FEISHU_AGENT_ATTACHMENT_DOWNLOAD_MAX_ATTEMPTS",
        "FEISHU_AGENT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS",
        "downloaded_identity_fallback",
        "downloadAttempts",
        "sourceReady",
        "attachmentCacheTimestampMs",
        "feishu_resource_download_timeout",
        "feishu_resource_permission_denied",
        "lark_cli_unavailable",
        "feishu_resource_not_found",
        "source_acquisition_gate",
        "attachment_download_failed",
        "runtime_store_find_source_failed",
        "attachment_artifact_cache_updated",
        "feishu_attachment_artifact_cache",
        "FEISHU_AGENT_INDEX_FIXTURES",
        "runtime_store_fixture_mock_dry_run_index_skipped",
        "audio_file_too_small",
        "invalid_asr_media_header",
    ):
        if marker not in handler_context_text:
            fail(f"feishu_agent_task_handler.mjs missing marker: {marker}")
    for marker in (
        "im_file_context_helpers",
        "buildFileContexts",
        "attachmentKind",
        "progressiveDisclosureRequired",
        "rawAudioVideoExternalUploadAllowed",
        "image_understanding_not_supported",
        "audio_file_too_small",
        "invalid_asr_media_header",
        "CLOUD_ASR_MEDIA_EXTENSIONS",
        "local_source_file_missing",
    ):
        if marker not in handler_context_text:
            fail(f"shared file-context helper missing marker: {marker}")
    wechat_adapter_text = wechat_event_adapter.read_text(encoding="utf-8")
    for marker in (
        "WeChat adapter skeleton",
        "im-event-v1",
        "office-task-state-v1",
        "wechat-adapter-fixture",
        "invoke-handler",
        "feishu_agent_task_handler.mjs",
        "目前暂不支持该功能",
        "rawMediaExternalUpload: false",
    ):
        if marker not in wechat_adapter_text:
            fail(f"wechat_event_adapter.mjs missing marker: {marker}")
    task_runner_text = task_execution_runner.read_text(encoding="utf-8")
    audio_normalize_text = audio_normalize_helpers.read_text(encoding="utf-8")
    for marker in (
        "audio-normalize-v1",
        "SUPPORTED_AUDIO_EXTENSIONS",
        "CLOUD_ASR_MEDIA_EXTENSIONS",
        "ffmpeg",
        "afconvert",
        "LEI16@16000",
        "pcm_s16le",
        "readWavHeader",
        "audio_transcoder_unavailable",
        "audio_normalize_failed",
        "目前音频格式暂不支持自动转码。",
        "rawMediaExternalUpload: false",
    ):
        if marker not in audio_normalize_text:
            fail(f"audio_normalize_helpers.mjs missing marker: {marker}")
    for marker in (
        "Thin task execution runner",
        "not a second orchestrator",
        "runtime_tool_cli",
        "planner_envelope_plan",
        "model_route_plan",
        "document_prompt_render_batch",
        "document_workers_run",
        "qa_gate_evaluate",
        "policy_gate_check",
        "evidence-pack.json",
        "office-evidence-pack-v2",
        "source_context_prepare",
        "contextPlane",
        "document-title-plan.json",
        "document-title-plan-v1",
        "syncMarkdownTitle",
        "titleBasis",
        "documents_generated",
        "source_attribution",
        "FEISHU_AGENT_DOCUMENT_WORKER_TIMEOUT_MS",
        "FEISHU_AGENT_LONG_DOCUMENT_JOB_TIMEOUT_MS",
        "FEISHU_AGENT_DOCUMENT_WORKER_MAX_ATTEMPTS_PER_UNIT",
        "finalFailureReport",
        "finalFailureSummary",
        "document_worker_timeout_diagnostic",
        "timeoutBudgetMs",
        "lastAttempt",
        "audio_downloaded",
        "audio_normalized",
        "audio-normalize.json",
        "asr_provider_resolved",
        "ensureAsrTranscription",
        "aliyun_dashscope_paraformer",
        "dashscope_asr_client.mjs",
        "ALIYUN_ASR_DIARIZATION_ENABLED",
        "ALIYUN_ASR_SPEAKER_COUNT",
        "ALIYUN_ASR_TIMESTAMP_ALIGNMENT_ENABLED",
        "cloud_asr_completed",
        "MEETING_ASR_PROVIDER",
        "local_asr_preflight",
        "local_asr_service_not_running",
        "FEISHU_AGENT_LOCAL_ASR_HEALTH_TIMEOUT_MS",
        "status-local-asr",
        "local_asr_service_ctl.py",
        "local_asr_completed",
        "meeting_minutes_generated",
        "meeting-memory",
        "runMeetingMemoryCurationSafely",
        "rawMediaExternalUpload: false",
        "task_execution_runner_started",
        "matchApiCommentToBody",
        "matchSummary",
        "exact_unique",
        "exact_multiple",
        "exported_body_detected",
        "sourcesWithUnavailableComments",
    ):
        if marker not in task_runner_text:
            fail(f"task_execution_runner.mjs missing marker: {marker}")
    if 'kind: "meeting-memory-curation"' in task_runner_text or 'kind: "meeting-memory-events"' in task_runner_text:
        fail("meeting memory internal artifacts must not enter the Feishu upload artifact list")
    if 'AUDIO_SUPPORTED_BY_LOCAL_ASR = new Set([".wav"])' in task_runner_text:
        fail("task_execution_runner.mjs must not expose .wav-only ASR input as product limitation")
    if 'task?.taskIntent?.taskType === "meeting_minutes" && task?.taskIntent?.requiresLocalAsr === true' in task_runner_text:
        fail("task_execution_runner.mjs must not restrict document_pipeline execution to audio meeting minutes")
    local_asr_service_ctl_text = local_asr_service_ctl.read_text(encoding="utf-8")
    for marker in (
        "local-asr-service-ctl-v1",
        '"status", "start", "stop"',
        "runtime-runs",
        "_services",
        "local-asr.pid",
        "local-asr.log",
        "local_asr_http_service.py",
        "Qwen3-ASR-1.7B-MLX-4bit",
        "rawMediaExternalUpload",
        "start_new_session=True",
        "local_asr_service_url_non_loopback_blocked",
    ):
        if marker not in local_asr_service_ctl_text:
            fail(f"local_asr_service_ctl.py missing lifecycle marker: {marker}")
    local_runtime_supervisor_text = local_runtime_supervisor.read_text(encoding="utf-8")
    local_runtime_ctl_text = local_runtime_ctl.read_text(encoding="utf-8")
    local_ci_check_text = local_ci_check.read_text(encoding="utf-8")
    for marker in (
        "local-runtime-supervisor-v1",
        "feishu-handler",
        "feishu-gateway",
        "local-asr",
        "status.json",
        "events.ndjson",
        "health-report.json",
        "local_asr_service_ctl.py",
        "gateway_ws_timeout_threshold",
        "handler_health_failed",
        "rawSecretsReturned",
        "rawMediaExternalUpload",
        "provider_aware_local_asr_service_ctl_status",
        "aliyun_dashscope_paraformer",
    ):
        if marker not in local_runtime_supervisor_text:
            fail(f"local_runtime_supervisor.py missing production supervisor marker: {marker}")
    for marker in (
        "local-runtime-ctl-v1",
        "start|stop|restart|status|doctor",
        "bootout",
        "takeover",
        "meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs",
        "meeting-agent-pi-package/tools/feishu_bot_event_gateway.mjs",
        "asr_is_host_owned_and_not_stopped_by_default",
        "local_qwen3 remains host-owned",
        "aliyun_dashscope_paraformer",
    ):
        if marker not in local_runtime_ctl_text:
            fail(f"local_runtime_ctl.py missing production control marker: {marker}")
    for marker in (
        "local-ci-check-v1",
        "Docker.app fallback",
        "runtime-runs/_services/ci/latest.json",
        "validate_workspace.py",
        "docker-compose.local-runtime.yml",
        "swift-test-agent-workbench",
        "rawSecretsReturned",
    ):
        if marker not in local_ci_check_text:
            fail(f"local_ci_check.py missing CI marker: {marker}")
    if re.search(r"if\s*\(\s*requiresAsr\s*\)[\s\S]{0,180}taskType:\s*\"meeting_minutes\"", handler_text):
        fail("Feishu task classification must not route every audio source to meeting_minutes")
    for marker in (
        "wiki-publish-plan-v1",
        "feishu-wiki-target-registry-v1",
        "dynamic_content_based",
        "project_workspace_canonical",
        "rootNodes",
        "taxonomyRef",
        "project:${",
        "\"wiki\", \"+move\"",
        "\"wiki\", \"+node-create\"",
        "\"markdown\", \"+create\"",
        "wiki_publish_blocked_drive_fallback",
        "rawSecretsReturned: false",
    ):
        if marker not in wiki_publish_text:
            fail(f"feishu_wiki_publish_helpers.mjs missing marker: {marker}")
    for marker in (
        "feishu-publish-taxonomy-v1",
        "PI Agent 项目知识库",
        "publish-taxonomy.json",
        "project_workspace_canonical",
        "feishu\\s+file",
        "normalized",
        "sourceThreadKey",
        "legacySessionKey",
        "rawMediaExternalUpload: false",
    ):
        if marker not in publish_taxonomy_text:
            fail(f"feishu_publish_taxonomy.mjs missing marker: {marker}")
    for marker in (
        "feishu-publish-organization-inventory-v1",
        "feishu-publish-organization-plan-v1",
        "feishu-publish-organization-report-v1",
        "publish_organize_apply_requires_no_delete",
        "publish-organization-ledger.jsonl",
        "drive_folder_move",
        "wiki_document_move",
        "rawSecretsReturned: false",
    ):
        if marker not in publish_organize_text:
            fail(f"feishu_publish_organize_cli.mjs missing marker: {marker}")
    for marker in (
        "drive",
        "file.comments",
        "list",
        "file.comment.replys",
        "batch_query",
        "docs:document.comment:read",
        "FEISHU_REVIEW_CONTEXT_AS",
        "FEISHU_REVIEW_CONTEXT_SDK_FALLBACK",
        "comment_api_permission_blocked",
        "export_body_detected",
        "partial_ready",
        "sourceResults",
        "bounded comment anchors only",
        "rawMediaExternalUpload: false",
    ):
        if marker not in review_context_text:
            fail(f"feishu_document_review_context_helpers.mjs missing marker: {marker}")
    for marker in (
        "task-intent-v1",
        "executionProfile",
        "taskType",
        "responseMode",
        "requiredStages",
        "skipStages",
    ):
        if marker not in task_router_text:
            fail(f"task_router.mjs missing task-intent/profile marker: {marker}")
    for profile_id in REQUIRED_EXECUTION_PROFILES:
        if profile_id not in task_router_text:
            fail(f"task_router.mjs missing execution profile mapping: {profile_id}")

    runtime_tool_text = runtime_tool_cli.read_text(encoding="utf-8")
    runtime_tool_manifest_text = (ROOT / "meeting-agent-pi-package" / "runtime" / "tool-load-manifest.json").read_text(
        encoding="utf-8"
    )
    runtime_tool_contract_text = f"{runtime_tool_text}\n{runtime_tool_manifest_text}"
    for marker in (
        "Thin local runner for PI extension tools",
        "Planner/Router/Prompt",
        "tool-load-manifest.json",
        "defaultTools",
        "profileTools",
        "planner-runtime.ts",
        "model-routing.ts",
        "document-generation.ts",
        "document-worker-runtime.ts",
        "qa-gate.ts",
        "policy-gate.ts",
        "office-runtime.ts",
        ".env.local",
        "FEISHU_AGENT_LOAD_LOCAL_ENV",
        "FEISHU_AGENT_RUNTIME_ENV_FILE",
        "env-file",
        "LOCAL_ENV_ALLOWLIST",
        "runtime_env_file_outside_workspace_blocked",
        "FEISHU_AGENT_RUNTIME_ENV_LOADED_KEYS",
    ):
        if marker not in runtime_tool_contract_text:
            fail(f"runtime_tool_cli.mjs missing marker: {marker}")
    if "tool-load-manifest.json" not in runtime_tool_text and re.search(r"const\s+extensionFiles\s*=\s*\[", runtime_tool_text):
        fail("runtime_tool_cli.mjs must load runtime/tool-load-manifest.json instead of only an inline fixed extension list")
    bot_gateway_text = feishu_bot_gateway.read_text(encoding="utf-8")
    for marker in (
        "sdk-long-connection",
        "schemaVersion: \"feishu-event-v1\"",
        "source: \"sdk-long-connection\"",
        "FEISHU_BOT_HANDLER_TIMEOUT_MS",
        "suppressGatewayReply",
        "effectiveReplyMode",
        "message.attachments",
        "rootId",
    ):
        if marker not in bot_gateway_text:
            fail(f"feishu_bot_event_gateway.mjs missing marker: {marker}")

    runtime_obs = (ROOT / "meeting-agent-pi-package" / "extensions" / "runtime-observability.ts").read_text(
        encoding="utf-8"
    )
    for marker in (
        "runtime_metrics_start",
        "runtime_metrics_record",
        "runtime_metrics_finish",
        "meetingContentAllowed",
        "TRUNCATED_FOR_METRICS_BUDGET",
        "plannerDecisions",
        "policyDecisions",
        "workerDecisions",
        "capabilitySelections",
        "packageAudits",
      ):
        if marker not in runtime_obs:
            fail(f"runtime-observability.ts missing marker: {marker}")
    for forbidden_marker in (
        "runtime_metrics_raw_payload_blocked",
        "REDACTED_RAW_MEETING_CONTENT_POINTER_REQUIRED",
        "RAW_CONTENT_KEY_PATTERN",
    ):
        if forbidden_marker in runtime_obs:
            fail(f"runtime-observability.ts still blocks meeting content: {forbidden_marker}")

    registry_ext = (ROOT / "meeting-agent-pi-package" / "extensions" / "capability-registry.ts").read_text(
        encoding="utf-8"
    )
    for marker in (
        "capability_registry_plan",
        "capability_registry_check",
        "capability_registry_enable",
        "needs_security_review",
        "securityReview",
        "installState",
        "rawSecretsReturned",
    ):
        if marker not in registry_ext:
            fail(f"capability-registry.ts missing marker: {marker}")
    if "spawnSync" in registry_ext or '["--help"]' in registry_ext:
        fail("capability registry checks must not execute arbitrary command --help probes")
    if "path_lookup_only" not in registry_ext:
        fail("capability registry must use path_lookup_only command checks")

    document_generation_ext = (ROOT / "meeting-agent-pi-package" / "extensions" / "document-generation.ts").read_text(
        encoding="utf-8"
    )
    for marker in (
        "document_prompt_catalog",
        "document_prompt_select",
        "document_prompt_render",
        "document_prompt_render_batch",
        "document-prompt-registry.json",
        "unmappedDocuments",
        "document_prompt_input_placeholder_count_invalid",
        "hardcodedDocumentScaffoldUsed: false",
    ):
        if marker not in document_generation_ext:
            fail(f"document-generation.ts missing prompt registry marker: {marker}")
    if "const DOC_PROMPTS" in document_generation_ext:
        fail("document-generation.ts must not keep a second hardcoded DOC_PROMPTS registry")

    model_provider = (ROOT / "meeting-agent-pi-package" / "extensions" / "model-provider.ts").read_text(
        encoding="utf-8"
    )
    for marker in (
        "model_provider_check",
        "model_generate_text",
        "DEEPSEEK_API_KEY",
        "XIAOMI_BASE_URL",
        "requestBodyReturned: false",
        "rawSecretsReturned: false",
        "model_prompt_secret_like_input_blocked",
        "supportsFileInput",
        "supportsTextFallback",
        "request_started",
        "response_headers_received",
        "model_provider_request_timeout",
        "durationMs",
        "chunkCount",
        "configuredEnv",
        "loadedProviderEnvNames",
    ):
        if marker not in model_provider:
            fail(f"model-provider.ts missing provider adapter marker: {marker}")

    document_worker_runtime = (ROOT / "meeting-agent-pi-package" / "extensions" / "document-worker-runtime.ts").read_text(
        encoding="utf-8"
    )
    for marker in (
        "document_workers_plan",
        "document_workers_run",
        "context_plane_required",
        "context_pack_missing",
        "document_work_items_required",
        "documentWorkItems",
        "bounded context-pack document work units",
        "contextPackId",
        "sourceSegmentIds",
        "promptBudgetChars",
        "promptInstructionChars",
        "retrievalReasons",
        "generateText",
        "recordRouteArtifact",
        "taskIndex",
        "mockProvider",
        "sectionBatching",
        "sectionsPerBatch",
        "sectionBatches",
        "sectionAttempts",
        "repairAttempts",
        "missingSections",
        "deadlineAt",
        "runtimeBudgetMs",
        "deadlineReserveMs",
        "document_worker_deadline_exhausted",
        "fallbackSkippedReason",
        "deadline_budget_insufficient_or_primary_timeout",
        "document-workflow-checkpoint-v1",
        "retry-ledger.ndjson",
        "workflowStrategy",
        "resumeFromCheckpoint",
        "retryPolicy",
        "maxAttemptsPerUnit",
        "maxRetryUnits",
        "finalFailureReport",
        "publishPartial",
        "attemptsPath",
        "hardcodedDocumentScaffoldUsed: false",
    ):
        if marker not in document_worker_runtime:
            fail(f"document-worker-runtime.ts missing parallel worker marker: {marker}")
    for forbidden in ("renderedPrompt", "renderedPrompts", "hasRenderedPrompt", "compactRenderedInstructions"):
        if forbidden in document_worker_runtime:
            fail(f"document-worker-runtime.ts must not carry old monolithic prompt marker: {forbidden}")

    planner_runtime = (ROOT / "meeting-agent-pi-package" / "extensions" / "planner-runtime.ts").read_text(
        encoding="utf-8"
    )
    for marker in (
        "Planner Envelope",
        "planner_envelope",
        "office_agent_adaptive_control_loop",
        "fixedWorkflow",
        "goal",
        "taskType",
        "successCriteria",
        "capabilitiesNeeded",
        "toolPlan",
        "parallelizableWorkers",
        "policyRisks",
        "requiredArtifacts",
        "stopConditions",
        'meetingContentAccess: "allowed"',
    ):
        if marker not in planner_runtime:
            fail(f"planner-runtime.ts missing Planner Envelope marker: {marker}")

    policy_gate = (ROOT / "meeting-agent-pi-package" / "extensions" / "policy-gate.ts").read_text(
        encoding="utf-8"
    )
    for marker in (
        "policy_gate_check",
        "pass",
        "needs_confirmation",
        "blocked",
        "publish_customer_visible",
        "notify_people",
        "mutate_calendar",
        "assign_task",
        "external_web",
        "install_dependency",
        "delete",
        "rawTranscriptIncluded: Boolean(params.rawTranscriptIncluded)",
    ):
        if marker not in policy_gate:
            fail(f"policy-gate.ts missing Policy Gate marker: {marker}")

    model_routing = (ROOT / "meeting-agent-pi-package" / "extensions" / "model-routing.ts").read_text(
        encoding="utf-8"
    )
    for marker in ("model_route_plan", "model_route_record", "automaticFallback", "silentFallbackAllowed"):
        if marker not in model_routing:
            fail(f"model-routing.ts missing marker: {marker}")
    for marker in ("manual_or_blocked_candidate_selected", "runtime_output_root_outside_workspace_blocked"):
        if marker not in model_routing:
            fail(f"model-routing.ts missing routing/boundary marker: {marker}")

    qa_gate = (ROOT / "meeting-agent-pi-package" / "extensions" / "qa-gate.ts").read_text(encoding="utf-8")
    for marker in (
        "qa_gate_evaluate",
        "qa_gate_write",
        "omittedMacroTopics",
        "publishAllowed",
        "documentOutputs",
        "requiredSections",
        "missingSections",
        "unsupportedClaims",
        "openQuestions",
        "document_router_reason_not_covered",
        "primaryDeliveryStatus",
        "overallStatus",
        "blocksDelivery",
        "follow_up",
    ):
        if marker not in qa_gate:
            fail(f"qa-gate.ts missing marker: {marker}")

    agent_team = (ROOT / "meeting-agent-pi-package" / "extensions" / "agent-team-runtime.ts").read_text(
        encoding="utf-8"
    )
    for marker in ("agent_team_components", "agent_team_plan", "agent_team_run", "node_worker_threads", "dynamic_component_pool"):
        if marker not in agent_team:
            fail(f"agent-team-runtime.ts missing marker: {marker}")
    for marker in ("taskIndex", "MAX_PAYLOAD_BYTES", "too_many_tasks"):
        if marker not in agent_team:
            fail(f"agent-team-runtime.ts missing ordering/cap marker: {marker}")
    for marker in ("context_plane_required", "documentWorkItem", "contextPackRef", "hardcodedDocumentScaffoldUsed: false"):
        if marker not in agent_team:
            fail(f"agent-team-runtime.ts missing context-plane document shard marker: {marker}")
    for forbidden in ("renderedPrompt", "renderedPrompts", "promptPointer", "document_prompt_required"):
        if forbidden in agent_team:
            fail(f"agent-team-runtime.ts must not carry old prompt handoff marker: {forbidden}")
    for forbidden in ("目标、MVP 范围、验收标准", "架构目标、模块边界、数据流", "运营目标、SOP、指标"):
        if forbidden in agent_team:
            fail(f"agent-team-runtime.ts must not hardcode document scaffold marker: {forbidden}")
    if 'import { parentPort, workerData }' in agent_team:
        fail("agent-team-runtime worker eval must not use ESM import syntax")

    context_offload = (ROOT / "meeting-agent-pi-package" / "extensions" / "context-offload.ts").read_text(
        encoding="utf-8"
    )
    for marker in ("context_offload_plan", "context_offload_write", "context_offload_read", "artifactPointers"):
        if marker not in context_offload:
            fail(f"context-offload.ts missing marker: {marker}")
    for marker in ("unsafe_artifact_name_blocked", "MAX_READ_CHARS", "runtime_output_root_outside_workspace_blocked"):
        if marker not in context_offload:
            fail(f"context-offload.ts missing path boundary marker: {marker}")

    source_context = (ROOT / "meeting-agent-pi-package" / "extensions" / "source-context-runtime.ts").read_text(
        encoding="utf-8"
    )
    for marker in (
        "source_context_prepare",
        "source_context_segment",
        "source_context_plan_retrieval",
        "source_context_build_pack",
        "source_context_gate",
        "runtime-context-plane-v1",
        "DocumentIdentity",
        "SourceBlock",
        "source-records.json",
        "source-segments.jsonl",
        "source-structure.json",
        "retrieval-plan.json",
        "context-manifest.json",
        "documentIdentity",
        "sourceStructurePath",
        "outputContract",
        "document-output-contract-v1",
        "contextPackId",
        "sourceSegmentIds",
        "sourceBlockIds",
        "tableBlockCount",
        "promptBudgetChars",
        "retrievalReasons",
        "vectorStoreUsed: false",
        "htmlTableToMarkdown",
        "segmentKind",
        "speakerDiarization",
        "speakerLabel",
        "channelId",
    ):
        if marker not in source_context:
            fail(f"source-context-runtime.ts missing context plane marker: {marker}")
    for marker in (
        "source_context_output_root_outside_workspace_blocked",
        "source_context_path_outside_workspace_blocked",
        "DEFAULT_EVIDENCE_HARD_CAP_CHARS",
        "DEFAULT_SECTION_PROMPT_HARD_CAP_CHARS",
    ):
        if marker not in source_context:
            fail(f"source-context-runtime.ts missing boundary/budget marker: {marker}")

    task_execution_runner = (ROOT / "meeting-agent-pi-package" / "tools" / "task_execution_runner.mjs").read_text(
        encoding="utf-8"
    )
    old_document_path_sources = {
        "document-generation.ts": document_generation_ext,
        "document-worker-runtime.ts": document_worker_runtime,
        "task_execution_runner.mjs": task_execution_runner,
        "source-context-runtime.ts": source_context,
    }
    for source_name, source_text in old_document_path_sources.items():
        for forbidden in ("renderedPrompt", "renderedPrompts", "office-evidence-pack-v1", "hasRenderedPrompt", "compactRenderedInstructions"):
            if forbidden in source_text:
                fail(f"{source_name} must not carry old monolithic document path marker: {forbidden}")
    for source_name, source_text in {
        "task_execution_runner.mjs": task_execution_runner,
        "source-context-runtime.ts": source_context,
    }.items():
        if "sourceInput" in source_text:
            fail(f"{source_name} must not assemble or expose legacy sourceInput")

    for marker in ("looksLikeGenericUploadName", "source_heading", "identityOwner", "document_identity", "normalizeMarkdownTables", "htmlTableToMarkdown"):
        if marker not in task_execution_runner:
            fail(f"task_execution_runner.mjs missing title/table output guard marker: {marker}")
    for marker in ("HTML table/tbody/tr/th/td", "Markdown pipe table"):
        if marker not in document_worker_runtime:
            fail(f"document-worker-runtime.ts missing markdown table output contract marker: {marker}")
    for marker in ("sourceBlockIds", "tableBlockCount", "outputContractVersion", "documentIdentityConfidence"):
        if marker not in document_worker_runtime:
            fail(f"document-worker-runtime.ts missing output contract trace marker: {marker}")
    for marker in ("bad_document_title", "document_identity_missing", "raw_html_table_in_markdown", "table_source_unreadable_in_output"):
        if marker not in qa_gate:
            fail(f"qa-gate.ts missing document output contract marker: {marker}")
    office_agent_sources = (
        qa_gate
        + task_execution_runner
        + source_context
        + (ROOT / ".pi" / "SYSTEM.md").read_text(encoding="utf-8")
        + (ROOT / "meeting-agent-pi-package" / "tools" / "meeting_intelligence_helpers.mjs").read_text(encoding="utf-8")
    )
    for marker in ('severity: "warning"', "explicitPublishRequested", "candidateName", "office-task-state-v2", "context-pack-v2", "hierarchical_control_plane_and_work_unit_data_plane", "repeatedFullTranscriptInjection"):
        if marker not in office_agent_sources:
            fail(f"Office Agent upgrade marker missing: {marker}")

    office_runtime = (ROOT / "meeting-agent-pi-package" / "extensions" / "office-runtime.ts").read_text(
        encoding="utf-8"
    )
    for marker in (
        "document_lifecycle_plan",
        "document_lifecycle_write",
        "office_object_write",
        "retrieval_index_write",
        "retrieval_index_search",
        "destructive_document_action_blocked",
        "retrieval_index_secret_payload_blocked",
        "pointerOnly: true",
        "office_runtime_output_root_outside_workspace_blocked",
    ):
        if marker not in office_runtime:
            fail(f"office-runtime.ts missing office capability marker: {marker}")


def validate_runtime_configs() -> None:
    runtime_root = ROOT / "meeting-agent-pi-package" / "runtime"
    for name in REQUIRED_RUNTIME_FILES:
        path = runtime_root / name
        if not path.exists():
            fail(f"missing runtime config {name}")
        load_json(path)

    validate_execution_profile_contract(runtime_root)
    validate_tool_load_manifest(runtime_root)

    registry = load_json(runtime_root / "capability-registry.json")
    registry_text = json.dumps(registry, ensure_ascii=False)
    for marker in ("runtime-observability", "capability-registry", "agent-team-runtime", "context-offload", "model-fallback"):
        if marker not in registry_text:
            fail(f"capability registry missing marker: {marker}")
    default_always_on = set(registry.get("defaults", {}).get("alwaysOn", []))
    if {"planner-runtime", "policy-gate", "runtime-observability", "capability-registry"} - default_always_on:
        fail("capability registry must keep planner, policy, runtime observability and capability registry always-on")
    if "meeting-minutes" in default_always_on:
        fail("capability registry must not force the meeting pipeline into the always-on kernel")
    capabilities = registry.get("capabilities", [])
    if not isinstance(capabilities, list) or not capabilities:
        fail("capability registry must contain capabilities")
    required_capability_fields = {
        "description",
        "toolIntents",
        "policy",
        "observability",
        "installState",
        "securityReview",
    }
    for capability in capabilities:
        capability_id = capability.get("capabilityId", "<unknown>")
        missing_fields = required_capability_fields - set(capability)
        if missing_fields:
            fail(f"capability registry entry {capability_id} missing fields: {sorted(missing_fields)}")
        if not isinstance(capability.get("description"), str) or not capability["description"].strip():
            fail(f"capability registry entry {capability_id} must include a non-empty description")
        for list_field in ("toolIntents", "observability"):
            if not isinstance(capability.get(list_field), list) or not capability[list_field]:
                fail(f"capability registry entry {capability_id} must include non-empty {list_field}")
        if not isinstance(capability.get("policy"), (list, dict)):
            fail(f"capability registry entry {capability_id} must include policy requirements")
        if not isinstance(capability.get("installState"), (str, dict)):
            fail(f"capability registry entry {capability_id} must include installState")
        if not isinstance(capability.get("securityReview"), (str, dict)):
            fail(f"capability registry entry {capability_id} must include securityReview")
        if capability.get("toolPackage") in {"third-party", "third-party-or-mcp"}:
            if capability.get("defaultLoad") is not False:
                fail(f"third-party capability {capability_id} must be disabled by default")
            security_review = capability.get("securityReview", {})
            if not isinstance(security_review, dict) or security_review.get("auditArtifactRequired") is not True:
                fail(f"third-party capability {capability_id} must require a package-audit artifact")
    validate_capability_traceability(capabilities)
    capability_ids = {capability.get("capabilityId") for capability in capabilities}
    for capability_id in (
        "planner-runtime",
        "policy-gate",
        "doc-writer",
        "model-provider",
        "document-worker-runtime",
        "calendar-task",
        "multi-edit",
        "feishu-agent-bridge",
        "wechat-adapter",
        "file-context-service",
        "office-runtime",
        "meeting-memory-curation",
    ):
        if capability_id not in capability_ids:
            fail(f"capability registry missing required capability: {capability_id}")

    routing = load_json(runtime_root / "model-routing.json")
    policy = routing.get("defaultPolicy", {})
    if policy.get("automaticFallback") is not True:
        fail("model routing must allow automatic fallback")
    if policy.get("silentFallbackAllowed") is not False:
        fail("model routing must forbid silent fallback")
    if policy.get("recordArtifact") != "model-route.json":
        fail("model routing must record model-route.json")
    routes = {item.get("taskType"): item for item in routing.get("routes", [])}
    expected_route_models = {
        "fast_draft": "deepseek-v4-flash",
        "main_draft": "deepseek-v4-flash",
        "meeting_minutes": "deepseek-v4-pro",
        "document_shard_fast": "deepseek-v4-flash",
        "document_shard_deep": "deepseek-v4-pro",
        "deep_draft": "deepseek-v4-pro",
    }
    for task_type, model in expected_route_models.items():
        route = routes.get(task_type)
        if not route:
            fail(f"model routing missing route: {task_type}")
        primary = route.get("primary", {})
        if primary.get("provider") != "deepseek" or primary.get("model") != model:
            fail(f"model routing {task_type} must use deepseek/{model}")

    providers = load_json(runtime_root / "model-providers.json")
    providers_text = json.dumps(providers, ensure_ascii=False)
    for marker in ("deepseek", "xiaomi", "mock", "DEEPSEEK_API_KEY", "XIAOMI_TOKEN_PLAN_SGP_API_KEY", "XIAOMI_BASE_URL", "https://api.deepseek.com", "requestBodyReturned"):
        if marker not in providers_text:
            fail(f"model providers config missing marker: {marker}")
    provider_by_id = {provider.get("provider"): provider for provider in providers.get("providers", [])}
    if provider_by_id.get("xiaomi", {}).get("defaultBaseUrl") is not None:
        fail("xiaomi provider must not hardcode defaultBaseUrl")
    if provider_by_id.get("deepseek", {}).get("defaultBaseUrl") != "https://api.deepseek.com":
        fail("deepseek provider must default to https://api.deepseek.com")

    document_prompt_registry = load_json(runtime_root / "document-prompt-registry.json")
    registry_docs = document_prompt_registry.get("documents", [])
    if not isinstance(registry_docs, list) or not registry_docs:
        fail("document prompt registry must contain documents")
    required_doc_types = {"meeting-minutes", "prd", "ops-plan", "tech-architecture", "customer-requirement-checklist"}
    registry_doc_types = {item.get("docType") for item in registry_docs}
    if required_doc_types - registry_doc_types:
        fail(f"document prompt registry missing docTypes: {sorted(required_doc_types - registry_doc_types)}")
    registry_by_type = {item.get("docType"): item for item in registry_docs}
    if registry_by_type.get("tech-architecture", {}).get("dependsOn") != ["prd"]:
        fail("tech-architecture must depend on prd in document prompt registry")
    checklist_record = registry_by_type.get("customer-requirement-checklist", {})
    if checklist_record.get("dependsOn") != ["prd", "tech-architecture"]:
        fail("customer-requirement-checklist must depend on prd and tech-architecture")
    if checklist_record.get("audience") != "FDE":
        fail("customer-requirement-checklist audience must be FDE")
    prompts_root = ROOT / "meeting-agent-pi-package" / "prompts"
    for item in registry_docs:
        doc_type = item.get("docType", "<unknown>")
        prompt_file = item.get("promptFile", "")
        if not re.match(r"^[A-Za-z0-9_.-]+\.md$", prompt_file):
            fail(f"document prompt registry unsafe promptFile for {doc_type}: {prompt_file}")
        prompt_path = (prompts_root / prompt_file).resolve()
        if prompts_root.resolve() not in prompt_path.parents:
            fail(f"document prompt registry prompt path outside prompts dir: {prompt_file}")
        if not prompt_path.exists():
            fail(f"document prompt registry missing prompt file: {prompt_file}")
        prompt_text = prompt_path.read_text(encoding="utf-8")
        if prompt_text.count("{{input}}") != 1:
            fail(f"document prompt {prompt_file} must contain exactly one {{input}} placeholder")
        if not isinstance(item.get("requiredSections"), list) or not item["requiredSections"]:
            fail(f"document prompt registry {doc_type} missing requiredSections")

    revision_overlay = prompts_root / "document-revision-overlay.md"
    if not revision_overlay.exists():
        fail("missing document-revision-overlay.md")
    overlay_text = revision_overlay.read_text(encoding="utf-8")
    for marker in ("Document Revision Overlay", "Review Context", "base document prompt still owns the document", "Do not publish or overwrite by yourself"):
        if marker not in overlay_text:
            fail(f"document-revision-overlay.md missing marker: {marker}")
    if "{{input}}" in overlay_text:
        fail("document-revision-overlay.md must not contain {{input}}")
    overlay_docs = {
        item.get("docType")
        for item in registry_docs
        if item.get("operationOverlays", {}).get("document_revision") == "document-revision-overlay.md"
    }
    if {"prd", "ops-plan", "tech-architecture", "customer-requirement-checklist"} - overlay_docs:
        fail("document prompt registry missing document_revision operationOverlays")

    document_worker_text = (ROOT / "meeting-agent-pi-package" / "extensions" / "document-worker-runtime.ts").read_text(encoding="utf-8")
    for marker in ("dependencyWaves", "Upstream Dependency Summary", "upstreamDocumentsUsed", "missingUpstreamDocuments", "executionWaves"):
        if marker not in document_worker_text:
            fail(f"document worker runtime missing dependency-wave marker: {marker}")
    tech_prompt_text = (prompts_root / "tech-architecture.md").read_text(encoding="utf-8")
    for marker in ("Generated Upstream Documents", "PRD", "PRD 缺失", "会议证据与 PRD 冲突"):
        if marker not in tech_prompt_text:
            fail(f"tech architecture prompt missing PRD dependency marker: {marker}")
    checklist_prompt_text = (prompts_root / "customer-requirement-checklist.md").read_text(encoding="utf-8")
    for marker in ("FDE", "前端部署工程师", "PRD 待确认项", "技术架构待确认项", "FDE 为什么需要确认"):
        if marker not in checklist_prompt_text:
            fail(f"customer checklist prompt missing FDE dependency marker: {marker}")

    qa_gate = load_json(runtime_root / "qa-gate.schema.json")
    qa_gate_text = json.dumps(qa_gate, ensure_ascii=False)
    for marker in ("omittedMacroTopics", "unsupportedEntities", "crossMeetingTerms", "publishAllowed", "documentOutputs", "requiredSections", "unsupportedClaims", "openQuestions", "primaryDeliveryStatus", "overallStatus", "blocksDelivery", "follow_up"):
        if marker not in qa_gate_text:
            fail(f"qa gate schema missing marker: {marker}")

    feishu_event_schema = load_json(runtime_root / "feishu-event.schema.json")
    feishu_event_text = json.dumps(feishu_event_schema, ensure_ascii=False)
    for marker in ("feishu-event-v1", "sdk-long-connection", "attachments", "rootId", "rawSecretsReturned"):
        if marker not in feishu_event_text:
            fail(f"feishu event schema missing marker: {marker}")

    planner_envelope = load_json(runtime_root / "planner-envelope.schema.json")
    planner_text = json.dumps(planner_envelope, ensure_ascii=False)
    for marker in (
        "goal",
        "taskType",
        "successCriteria",
        "capabilitiesNeeded",
        "toolPlan",
        "parallelizableWorkers",
        "policyRisks",
        "requiredArtifacts",
        "stopConditions",
        "fixedWorkflow",
        "wechat_adapter",
        "document_lifecycle",
        "retrieval",
    ):
        if marker not in planner_text:
            fail(f"planner envelope schema missing marker: {marker}")

    policy_gate = load_json(runtime_root / "policy-gate.schema.json")
    policy_text = json.dumps(policy_gate, ensure_ascii=False)
    for marker in (
        "pass",
        "needs_confirmation",
        "blocked",
        "read",
        "draft",
        "write_private",
        "publish_customer_visible",
        "notify_people",
        "mutate_calendar",
        "assign_task",
        "external_web",
        "install_dependency",
        "channel",
        "modifyExistingDocument",
        "targetSpecified",
    ):
        if marker not in policy_text:
            fail(f"policy gate schema missing marker: {marker}")

    for schema_name, markers in {
        "feishu-event.schema.json": ("feishu-event-v1", "messageId", "attachments", "rawSecretsReturned"),
        "feishu-task.schema.json": ("feishu-task-v1", "executionMode", "executionProfile", "publishMode", "fileContexts", "sourcePreparation", "sourceReferences", "conflictPolicy", "rawMediaExternalUpload"),
        "feishu-run-state.schema.json": ("feishu-run-state-v1", "steps", "replyPath", "rawMediaExternalUpload"),
        "file-context.schema.json": ("file-context-batch-v1", "file-context-v1", "progressiveDisclosureRequired", "rawSecretsReturned"),
        "im-event.schema.json": ("im-event-v1", "feishu", "wechat", "replyTarget", "rawSecretsReturned"),
        "im-attachment.schema.json": ("im-attachment-v1", "audio", "sourcePath", "rawMediaExternalUpload"),
        "im-reply.schema.json": ("im-reply-v1", "reply", "publish", "rawSecretsReturned"),
        "publish-target.schema.json": ("publish-target-v1", "destructiveActionsAllowed", "folderToken", "fileToken"),
        "office-task-state.schema.json": ("office-task-state-v1", "accepted", "processing", "completed", "unsupported"),
        "office-context.schema.json": ("office-context-v1", "version", "channel", "context", "actor", "conversation", "workspace", "sourceRun", "rawSecretsReturned"),
        "office-object.schema.json": ("office-object-v1", "version", "objectType", "channel", "context", "sourceRun", "pointers", "artifactPointer", "rawMediaExternalUpload"),
        "document-lifecycle.schema.json": ("document-lifecycle-v1", "version", "documentId", "channel", "context", "sourceRun", "lifecycleEvents", "diffPointer", "destructiveActionsAllowed", "rawMediaExternalUpload"),
        "retrieval-index.schema.json": ("retrieval-index-v1", "version", "channel", "context", "sourceRun", "pointerOnly", "entries", "artifactPointer", "summaryPointer", "embeddingPointer", "boundedPreview", "rawMediaExternalUpload"),
        "source-context.schema.json": ("source-context-v2/context-manifest", "runtime-context-plane-v1", "sourceRecordsPath", "sourceSegmentsPath", "sourceStructurePath", "taskStatePath", "documentIdentity", "outputContract", "document-output-contract-v1", "retrievalPlanPath", "contextPackId", "sourceSegmentIds", "sourceBlockIds", "tableBlockCount", "promptBudgetChars", "retrievalReasons", "vectorStoreUsed", "contextStrategy", "repeatedFullTranscriptInjection"),
        "asr-providers.schema.json": ("asr-providers-v1", "local_qwen3", "aliyun_dashscope_paraformer", "rawMediaExternalUpload", "languageHints"),
    }.items():
        schema_text = json.dumps(load_json(runtime_root / schema_name), ensure_ascii=False)
        for marker in markers:
            if marker not in schema_text:
                fail(f"{schema_name} missing marker: {marker}")

    public_contract_schemas = {
        schema_name: load_json(runtime_root / schema_name)
        for schema_name in (
            "office-context.schema.json",
            "office-object.schema.json",
            "document-lifecycle.schema.json",
            "retrieval-index.schema.json",
        )
    }
    for schema_name, schema in public_contract_schemas.items():
        validate_public_contract_schema(schema_name, schema)

    retrieval_index = public_contract_schemas["retrieval-index.schema.json"]
    if retrieval_index.get("properties", {}).get("pointerOnly", {}).get("const") is not True:
        fail("retrieval-index.schema.json must require root pointerOnly true")
    retrieval_entry = retrieval_index.get("properties", {}).get("entries", {}).get("items", {})
    if retrieval_entry.get("properties", {}).get("pointerOnly", {}).get("const") is not True:
        fail("retrieval-index.schema.json entries must require pointerOnly true")
    retrieval_pointers = retrieval_entry.get("properties", {}).get("pointers", {})
    pointer_properties = set(retrieval_pointers.get("properties", {}))
    if {"artifactPointer", "summaryPointer", "metadataPointer", "embeddingPointer"} - pointer_properties:
        fail("retrieval-index.schema.json must expose pointer-only retrieval pointer fields")
    if "artifactPointer" not in set(retrieval_pointers.get("required", [])):
        fail("retrieval-index.schema.json entries must require artifactPointer")

    package_audit = load_json(runtime_root / "package-audit.schema.json")
    package_audit_text = json.dumps(package_audit, ensure_ascii=False)
    for marker in (
        "packageName",
        "version",
        "source",
        "readmeSummary",
        "dependencies",
        "envReads",
        "networkAccess",
        "fileWrites",
        "promptInjectionRisk",
        "credentialHandling",
        "disableOrUninstallPath",
        "defaultLoad",
    ):
        if marker not in package_audit_text:
            fail(f"package audit schema missing marker: {marker}")

    metrics = load_json(runtime_root / "metrics.schema.json")
    metrics_text = json.dumps(metrics, ensure_ascii=False)
    for marker in (
        "enabledCapabilities",
        "modelCalls",
        "contextBudget",
        "meetingContentAllowed",
        "contentTruncationChars",
        "plannerDecisions",
        "policyDecisions",
        "workerDecisions",
        "capabilitySelections",
        "packageAudits",
    ):
        if marker not in metrics_text:
            fail(f"metrics schema missing marker: {marker}")


def validate_dependency_policy() -> None:
    package = load_json(ROOT / "meeting-agent-pi-package" / "package.json")
    bundled_pi_peers = {
        "@earendil-works/pi-agent-core",
        "@earendil-works/pi-ai",
        "@earendil-works/pi-coding-agent",
        "@earendil-works/pi-tui",
        "typebox",
    }
    for section in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
        for name, version in package.get(section, {}).items():
            if version == "*" and not (section == "peerDependencies" and name in bundled_pi_peers):
                fail(f"wildcard runtime dependency is not allowed: {section}.{name}")


def validate_local_docker_runtime() -> None:
    queue = ROOT / "meeting-agent-pi-package" / "tools" / "local_docker_runtime_queue.mjs"
    worker = ROOT / "meeting-agent-pi-package" / "tools" / "local_docker_document_worker.mjs"
    handler = ROOT / "meeting-agent-pi-package" / "tools" / "feishu_agent_task_handler.mjs"
    compose = ROOT / "docker-compose.local-runtime.yml"
    dockerfile = ROOT / "docker" / "local-runtime" / "Dockerfile.document-worker"
    for path in (queue, worker, compose, dockerfile):
        if not path.exists():
            fail(f"missing local Docker runtime file: {path.relative_to(ROOT)}")

    handler_text = handler.read_text(encoding="utf-8")
    for marker in (
        "runViaLocalDockerDocumentWorker",
        "FEISHU_AGENT_DOCUMENT_WORKER_MODE",
        "documentWorkerMode",
        "docker-worker-wait-timeout-ms",
        "long-document-job-timeout-ms",
        "document-worker-max-attempts-per-unit",
        "local-docker-document-worker",
    ):
        if marker not in handler_text:
            fail(f"handler missing local Docker dispatch marker: {marker}")

    queue_text = queue.read_text(encoding="utf-8")
    for marker in (
        "LOCAL_DOCKER_ELIGIBLE_PROFILES",
        "document_generation",
        "multi_source_synthesis",
        "requiresLocalAsr === true",
        "document_revision",
        "boundedArtifactsOnly",
        "feishuCredentialsIncluded: false",
        "publishAllowedInWorker: false",
        "local_docker_queue_overloaded",
        "local_docker_worker_unavailable",
        "finalFailureReport",
        "publishPartial: false",
    ):
        if marker not in queue_text:
            fail(f"local Docker queue missing boundary marker: {marker}")

    worker_text = worker.read_text(encoding="utf-8")
    for marker in (
        "runTaskExecutionPipeline",
        "worker_has_no_channel_reply",
        "local_docker_worker_started",
        "local_docker_worker_completed",
        "FEISHU_AGENT_DOCUMENT_WORKER_CONCURRENCY",
        "FEISHU_AGENT_DOCUMENT_WORKER_TIMEOUT_MS",
        "FEISHU_AGENT_LONG_DOCUMENT_JOB_TIMEOUT_MS",
        "FEISHU_AGENT_DOCUMENT_WORKER_MAX_RETRY_UNITS",
        "finalFailureReport",
    ):
        if marker not in worker_text:
            fail(f"local Docker document worker missing marker: {marker}")
    for forbidden in ("lark-cli", "FEISHU_APP_SECRET", "im +messages-reply", "markdown +create", "wiki +move"):
        if forbidden in worker_text:
            fail(f"local Docker document worker must not contain channel/publish marker: {forbidden}")

    compose_text = compose.read_text(encoding="utf-8")
    for marker in (
        "runtime-queue",
        "pi-document-worker",
        "redis:7-alpine",
        'cpus: "4.0"',
        "mem_limit: 8g",
        "FEISHU_AGENT_DOCUMENT_WORKER_CONCURRENCY: \"2\"",
        "FEISHU_AGENT_DOCUMENT_WORKER_TIMEOUT_MS",
        "FEISHU_AGENT_LONG_DOCUMENT_JOB_TIMEOUT_MS",
        "FEISHU_AGENT_DOCUMENT_WORKER_MAX_ATTEMPTS_PER_UNIT",
        "mem_limit: 256m",
    ):
        if marker not in compose_text:
            fail(f"docker-compose.local-runtime.yml missing resource/boundary marker: {marker}")
    for forbidden in ("FEISHU_APP_SECRET", "FEISHU_APP_ID", "FEISHU_TENANT_ACCESS_TOKEN", "LARK_CLI_SESSION"):
        if forbidden in compose_text:
            fail(f"docker compose must not pass Feishu credential marker to workers: {forbidden}")

    dockerfile_text = dockerfile.read_text(encoding="utf-8")
    for marker in ("node:22", "LOCAL_DOCKER_WORKSPACE_ROOT=/workspace", "local_docker_document_worker.mjs"):
        if marker not in dockerfile_text:
            fail(f"Dockerfile.document-worker missing marker: {marker}")

    for forbidden in ("hermes-worker", "HERMES_WIKI", "pi:hermes-worker:jobs"):
        if forbidden in compose_text:
            fail(f"docker compose must not contain removed Hermes production service marker: {forbidden}")

    readme_text = (ROOT / "README.md").read_text(encoding="utf-8")
    package_readme_text = (ROOT / "meeting-agent-pi-package" / "README.md").read_text(encoding="utf-8")
    wiki_root = project_wiki_root()
    arch_text = (wiki_root / "11-current-project-architecture.md").read_text(encoding="utf-8")
    test_plan_text = (wiki_root / "07-test-plan.md").read_text(encoding="utf-8")
    docs_text = "\n".join([readme_text, package_readme_text, arch_text, test_plan_text])
    for marker in (
        "Host 原生控制面 + Local Docker 受限执行面",
        "本地 Docker 不能减少本机总计算消耗",
        "fast_answer/file_summary 不进 Docker",
        "document_generation/multi_source_synthesis 默认进 Docker worker",
        "raw audio 不进容器",
        "4 CPU / 8GB / 长文档并发 2",
        "docker compose -f docker-compose.local-runtime.yml up -d runtime-queue pi-document-worker",
    ):
        if marker not in docs_text:
            fail(f"local Docker runtime docs missing marker: {marker}")


def validate_runtime_store_backend() -> None:
    store_cli = ROOT / "meeting-agent-pi-package" / "tools" / "runtime_store_cli.py"
    handler = ROOT / "meeting-agent-pi-package" / "tools" / "feishu_agent_task_handler.mjs"
    store_doc = project_wiki_root() / "14-local-data-storage-cache-backend.md"
    if not store_cli.exists():
        fail("missing runtime store CLI: meeting-agent-pi-package/tools/runtime_store_cli.py")

    store_text = store_cli.read_text(encoding="utf-8")
    for marker in (
        "runtime-store-v1",
        "Host-owned SQLite metadata",
        "Docker workers do not write DB",
        "PRAGMA journal_mode = WAL;",
        "PRAGMA foreign_keys = ON;",
        "PRAGMA busy_timeout = 5000;",
        "CREATE TABLE IF NOT EXISTS runs",
        "CREATE TABLE IF NOT EXISTS artifacts",
        "CREATE TABLE IF NOT EXISTS source_refs",
        "CREATE TABLE IF NOT EXISTS recent_sources",
        "CREATE TABLE IF NOT EXISTS file_text_cache",
        "CREATE TABLE IF NOT EXISTS asr_cache",
        "CREATE TABLE IF NOT EXISTS worker_jobs",
        "CREATE TABLE IF NOT EXISTS publish_records",
        "CREATE TABLE IF NOT EXISTS retention_policies",
        "CREATE TABLE IF NOT EXISTS retention_actions",
        "objects",
        "sha256",
        "hardlink",
        "symlink",
        "copy",
        "workspace-bound",
        "indexedOnly",
        "pinnedSafe",
        "retention-report",
        "safe_cleanup_path",
        "threeTierLifecycle",
        "lruQuotaCleanup",
        "quota_lru_over_max_bytes",
        "quota_overages",
        "KIND_MAX_BYTES",
        "put-object",
        "find-source",
        "include-fixtures",
        "audit-pollution",
        "quarantine-artifact",
        "raw-audio-signature-validation",
        "fixture_artifact_excluded",
        "source_refs",
        "file_key",
        "index-run",
        "dedupe",
        "cleanup",
        "pin",
        "unpin",
    ):
        if marker not in store_text:
            fail(f"runtime_store_cli.py missing store backend marker: {marker}")
    for forbidden in ("postgres", "minio", "boto3", "redis-py"):
        if forbidden in store_text.lower():
            fail(f"runtime_store_cli.py must stay sqlite/filesystem-only, found marker: {forbidden}")

    handler_text = handler.read_text(encoding="utf-8")
    for marker in (
        "runtime_store_cli.py",
        "runtime_store_index_run",
        "FEISHU_AGENT_RUNTIME_STORE_MODE",
        "FEISHU_AGENT_RUNTIME_STORE_CAS",
        "FEISHU_AGENT_RUNTIME_STORE_TIMEOUT_MS",
        "--cas",
    ):
        if marker not in handler_text:
            fail(f"handler missing runtime store index marker: {marker}")

    doc_text = store_doc.read_text(encoding="utf-8")
    for marker in (
        "Host-owned SQLite",
        "混合 CAS",
        "runtime_store_cli.py",
        "Docker worker 不直接写 SQLite",
        "cleanup --execute",
        "retention_actions",
        "三档生命周期",
        "LRU",
    ):
        if marker not in doc_text:
            fail(f"runtime store wiki doc missing marker: {marker}")


def main() -> int:
    validate_package()
    validate_skills()
    validate_docs_ignore_legacy_warning()
    validate_required_behavior_docs()
    validate_prompts()
    validate_extensions()
    validate_runtime_configs()
    validate_dependency_policy()
    validate_local_docker_runtime()
    validate_runtime_store_backend()
    print("workspace validation passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
