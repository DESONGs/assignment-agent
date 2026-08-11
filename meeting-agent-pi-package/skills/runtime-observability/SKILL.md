---
name: runtime-observability
description: Record PI runtime metrics artifacts for enabled capabilities, model routes, tool calls, context budget, generated artifacts, and QA gate status while removing credentials.
---

# Runtime Observability Skill

Use this skill at the start and end of non-trivial runs, and whenever the run enables optional capabilities.

## Tools

- `runtime_metrics_start(taskType, summary?, runId?, outputRoot?)`
- `runtime_metrics_record(runId, kind, payload, outputRoot?)`
- `runtime_metrics_finish(runId, status, qaGate?, outputRoot?)`

## Rules

- Record enabled capabilities, model calls, external calls, generated artifacts, context budget, and final QA gate.
- Do not record Feishu App Secret, model API keys, cookies, bearer tokens, or CLI sessions.
- Meeting content is allowed. Large values may be truncated in metrics for operational size, while complete transcripts remain available through their run artifacts.
- If `model_route_plan` falls back to another provider/model, record the fallback in `model-route.json` and in runtime metrics.

## Output

Runtime artifacts live under `runtime-runs/{run_id}/`:

- `run.metrics.json`
- `model-route.json`
- `qa-gate.json`
- optional `capabilities.json`
- optional `artifacts.json`

The artifact is for debugging and release gates, not for customer-visible publication.
