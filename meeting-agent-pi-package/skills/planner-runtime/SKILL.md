---
name: planner-runtime
description: Build and reconcile the authoritative Adaptive Execution Ledger before enabling optional Agentic Office Runtime capabilities.
---

# Adaptive Execution Ledger Skill

Use this skill before a non-trivial office task selects integrations, workers, or publish paths.

## Rules

- Start with `planner_envelope_plan(...)` and persist the returned `adaptive-execution-ledger-v1` before executing complex work.
- Treat the ledger as the only task-control truth. Channel state, checkpoints and Todo are projections.
- Use `execution_ledger_reconcile(...)` with `expectedRevision` after observations, results or user choices.
- Use `execution_ledger_todo(...)` to expose progress, clarification questions and next-step choices.
- Do not start steps whose dependencies are incomplete, and do not complete acceptance-bearing steps without result references or explicit acceptance evidence.
- Keep `fixedWorkflow=false`: the planner chooses a scenario playbook, not a global meeting-only path.
- Planner is one of the six runtime decision layers, alongside Model Router,
  Prompt Registry, Document Worker, QA Gate, and Policy Gate. Capability
  Registry provides catalog/readiness metadata; adapters, handlers, runners,
  publishers, File Context, ASR, Observability, Meeting Memory, and `runtime_tool_cli`
  do not make Planner decisions.
- Short private drafting tasks should recommend only the minimal core plus `doc-writer`; do not automatically enable Feishu bot, Rokid, ASR, WebAccess/MCP, or worker pools.
- Long meeting or multi-document tasks may recommend `meeting-minutes`, `local-asr`, `context-offload`, `agent-team-runtime`, `model-fallback`, and `qa-safety-review` when the task evidence calls for them.
- Feishu inbound task, attachment, publish, or bot reply issues should recommend `feishu-agent-bridge`; `feishu-bot-gateway` is the optional SDK long-connection entrypoint. MCP is not a prerequisite for basic bot reply or publish.
- SDK/MCP/API/current-documentation questions may recommend `web-access`, but only with source records and policy gate approval.
- The planner envelope must not contain secrets, tokens, cookies, CLI sessions,
  or App Secret values. Meeting-content references and bounded evidence are
  allowed when they improve planning.

## Output

Write `planner-envelope.json` with `planner_envelope_write(...)` for auditable and resumable runs. Record the same decision in runtime metrics with kind `planner` or `capabilitySelection` when metrics are active.
