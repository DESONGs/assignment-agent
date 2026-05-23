---
name: agent-team-runtime
description: Run task-shaped worker components in parallel for long meetings, evidence checks, Feishu readiness, and multi-document drafting without preloading permanent subagent roles.
---

# Agent Team Runtime Skill

Use this skill when the task is too broad for one serial pass, especially long meetings, multi-document output, evidence coverage checks, entity safety checks, or Feishu readiness checks.

## Tools

- `agent_team_components()`
- `agent_team_plan(taskDescription, requestedOutputs?, artifacts?)`
- `agent_team_run(tasks, maxWorkers?, timeoutMs?)`

## Component Pool

The runtime exposes task-shaped components:

- `topic_map_extractor`
- `evidence_coverage_checker`
- `entity_gate_checker`
- `feishu_readiness_checker`
- `document_shard_writer`
- `risk_open_question_extractor`

These are components, not fixed always-on roles. Planner chooses only the components needed by the current task.
The runtime pool is dynamic: plan first, run only selected components, then
return JSON to the main runtime for integration.

## Parallel Rules

- Components do not write files. They return JSON for the main runtime to integrate.
- Parallel workers may extract `topicMap`, evidence coverage, entity hits, Feishu readiness, prompt-driven document shards, and risks/open questions.
- `document_shard_writer` must receive a context-plane `documentWorkItem` with `workUnits[].contextPackRef`; it must not invent PRD, architecture, ops, or checklist section scaffolds.
- Real provider-backed document writing is handled by `document_workers_run`, which runs one rendered prompt per parallel worker and records model route decisions.
- Publishing and final QA remain serial gates.
- Any customer-visible result must still pass `qa_gate_evaluate`.
- Agent Team docs define human-readable ownership and ordering, but runtime
  execution must not preload those docs as permanent subagent role prompts.

## Third-Party Subagents

`pi-subagents` or similar packages may replace or extend the local worker pool only after supply-chain review, README review, and smoke tests. They must remain lazy and must not become default loaded capabilities.
