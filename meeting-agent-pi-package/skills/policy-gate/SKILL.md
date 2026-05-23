---
name: policy-gate
description: Decide whether an action intent is allowed, needs user confirmation, or must be blocked.
---

# Policy Gate Skill

Use this skill before actions that cross a boundary: publishing, notifying people, mutating calendar/task state, using external web, installing dependencies, or persisting memory.

## Rules

- Call `policy_gate_check(...)` for the action boundary. The gate only decides boundary status; it does not generate the business workflow.
- `read`, `draft`, and normal `write_private` actions pass unless they include secrets, raw media upload, or raw transcript leakage.
- `publish_customer_visible`, `notify_people`, `mutate_calendar`, `assign_task`, `install_dependency`, and `persist_memory` require explicit user confirmation.
- Feishu inbound is a scoped exception for non-destructive document writes: when
  the triggering user explicitly asks to create, write, save, publish, archive,
  or overwrite a document in the same chat/thread context, `write_private` and
  `publish_customer_visible` may pass after QA. Delete/remove/clear/destroy
  actions remain blocked.
- Block secret leaks, raw media external upload, raw transcript leakage, and external-web use for meeting fact generation.
- External web for official docs, SDK, MCP, API, or model research may pass when source records are required and the payload class is docs research.
- Policy Gate and QA Gate are separate: Policy Gate checks action boundaries; QA Gate checks content publishability.

## Output

Write `policy-gate.json` with `policy_gate_write(...)` for auditable runs. Record the decision in runtime metrics with kind `policy` when metrics are active.
