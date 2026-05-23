---
name: capability-registry
description: Select and check lazy PI capabilities so the meeting agent keeps a light default context and only enables Feishu Agent bridge, Feishu, Rokid, WebAccess, MCP, or agent-team workers when the task needs them.
---

# Capability Registry Skill

Use this skill before enabling optional integrations or when the user asks why a capability is missing.

## Tools

- `capability_registry_list(taskType?)`
- `capability_registry_plan(taskDescription)`
- `capability_registry_check(capabilityId)`
- `capability_registry_enable(capabilityId, reason)`

## Default Policy

- Always-on: `planner-runtime`, `policy-gate`, `qa-safety-review`, `runtime-observability`, `capability-registry`.
- Lazy: meeting minutes, document writer, Feishu CLI, Feishu Agent bridge, Feishu bot gateway, local ASR, Rokid import, calendar/task actions, agent team runtime, model fallback, WebAccess, MCP adapter.
- Candidate third-party packages stay disabled until audited and smoke-tested.

## Rules

- The registry does not install packages or mutate config.
- It may recommend setup steps, required env vars, permissions, and smoke tests.
- Secret values must never be returned; only boolean presence is allowed.
- WebAccess is only for docs/SDK/MCP/model API questions or explicit user requests, not for filling missing meeting facts.
- Subagent capability means dynamic worker components selected by the task, not a permanent set of preloaded roles.
