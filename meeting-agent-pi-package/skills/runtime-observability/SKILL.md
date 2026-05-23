---
name: runtime-observability
description: Record PI runtime metrics artifacts for enabled capabilities, model routes, tool calls, context budget, generated artifacts, and QA gate status without storing secrets or raw transcripts.
---

# Runtime Observability Skill

Use this skill at the start and end of non-trivial runs, and whenever the run enables optional capabilities.

## Tools

- `runtime_metrics_start(taskType, summary?, runId?, outputRoot?)`
- `runtime_metrics_record(runId, kind, payload, outputRoot?)`
- `runtime_metrics_finish(runId, status, qaGate?, outputRoot?)`

## Rules

- Record enabled capabilities, model calls, external calls, generated artifacts, context budget, and final QA gate.
- Do not record Feishu App Secret, model API keys, cookies, bearer tokens, CLI sessions, or raw transcript text.
- Long transcripts must be offloaded as local artifacts. Metrics should store counts, hashes, and artifact paths only.
- If `model_route_plan` falls back to another provider/model, record the fallback in `model-route.json` and in runtime metrics.

## Output

Runtime artifacts live under `runtime-runs/{run_id}/`:

- `run.metrics.json`
- `model-route.json`
- `qa-gate.json`
- optional `capabilities.json`
- optional `artifacts.json`

The artifact is for debugging and release gates, not for customer-visible publication.
