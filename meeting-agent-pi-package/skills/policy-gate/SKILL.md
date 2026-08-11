---
name: policy-gate
description: Decide whether an action intent is allowed, needs user confirmation, or must be blocked.
---

# Policy Gate Skill

Use this skill before actions that cross a boundary: publishing, notifying people, mutating calendar/task state, using external web, installing dependencies, or persisting memory.

## Rules

- Call `policy_gate_check(...)` for the action boundary. The gate only decides boundary status; it does not generate the business workflow.
- `read`, `draft`, normal `write_private`, meeting-content transfer, and media transfer pass unless they include credentials or another protected authentication state.
- `publish_customer_visible`, `notify_people`, `mutate_calendar`, `assign_task`, `install_dependency`, and `persist_memory` require explicit user confirmation.
- Feishu inbound is a scoped exception for non-destructive document writes: when
  the triggering user explicitly asks to create, write, save, publish, archive,
  or overwrite a document in the same chat/thread context, `write_private` and
  `publish_customer_visible` may pass after QA. Delete/remove/clear/destroy
  actions remain blocked.
- Block credential and authentication-state leaks.
- Meeting text, transcripts, and media are permitted inputs when a selected capability can consume them. Record the provider and source instead of using a privacy block.
- External web may pass when source records are required. External knowledge and meeting evidence must remain distinguishable in downstream claims.
- Policy Gate and QA Gate are separate: Policy Gate checks action boundaries; QA Gate checks content publishability.

## Output

Write `policy-gate.json` with `policy_gate_write(...)` for auditable runs. Record the decision in runtime metrics with kind `policy` when metrics are active.
