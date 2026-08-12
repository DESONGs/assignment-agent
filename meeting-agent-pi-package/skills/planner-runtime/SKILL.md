---
name: planner-runtime
description: Build an auditable planner envelope before enabling optional Agentic Office Runtime capabilities.
---

# Planner Runtime Skill

Use this skill before a non-trivial office task selects integrations, workers, or publish paths.

## Rules

- Start with `planner_envelope_plan(...)` and record the returned envelope before loading optional capabilities.
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

Write `planner-envelope.json` with `planner_envelope_write(...)` for auditable runs. Record the same decision in runtime metrics with kind `planner` or `capabilitySelection` when metrics are active.
