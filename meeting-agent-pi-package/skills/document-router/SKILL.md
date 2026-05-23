---
name: document-router
description: Decide which follow-up documents a meeting requires, such as minutes, PRD, technical architecture, operations plan, customer requirement checklist, or retrospective. Use after meeting understanding is available.
---

# Document Router Skill

Use this skill after meeting evidence has been indexed and the meeting intent is
understood. DeepSeek produces the primary routing decision; Xiaomi MiMo may
review it for missing evidence or unsupported document choices.

## Routing Policy

Generate only the documents supported by evidence. Meeting minutes are the
primary artifact; every other document is a follow-up artifact unless the user
explicitly asks for a full document package as the primary deliverable:

- `meeting-minutes`: default primary output for any meeting.
- `prd`: follow-up product requirements, users, scenarios, MVP, acceptance criteria.
- `tech-architecture`: follow-up systems, data flow, interfaces, deployment, security.
- `ops-plan`: follow-up operating rhythm, channels, SOP, metrics, staffing, risks.
- `customer-requirement-checklist`: follow-up unresolved customer questions and decisions.
- `retrospective`: follow-up delivery quality, lessons, reusable process improvements.

## Decision Rules

- If the meeting contains user stories, MVP scope, and acceptance criteria,
  route to PRD.
- If it contains components, APIs, deployment, data security, or integration
  constraints, route to technical architecture.
- If it contains growth, content, customer success, community, sales, or
  delivery process actions, route to operations.
- If many requirements are unresolved, route to customer requirement checklist.
- If the meeting is internal process review, route to retrospective.
- Do not route based on reference PDF facts. Reference PDFs can shape structure
  and style only.

## Output Schema

Return:

- `documents`: ordered list of document types.
- `reasoning`: one sentence per selected type.
- `priority`: `primary` for `meeting-minutes`; `follow_up` for routed follow-up
  documents; `optional` only for explicitly low-priority extras.
- `blocks_primary_delivery`: true only for primary artifacts.
- `evidence_ids`: supporting evidence for each selected type.
- `missing_inputs`: unresolved inputs blocking high-quality drafts.
- `approval_required`: publish or collaboration actions that need approval.

## Prompt Loading Flow

After routing, use `document_prompt_select` to map `documents` through
`document-prompt-registry.json`, then use `document_prompt_render_batch` to
replace `{{input}}` with meeting minutes, evidence summary, and router
conclusion. `document_workers_run` may then generate each rendered prompt in
parallel through the provider adapter. Agent-team shard workers may only check
readiness; they must not hardcode PRD, architecture, operations, or checklist
sections.
