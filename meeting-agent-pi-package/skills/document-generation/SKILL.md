---
name: document-generation
description: Select and render document prompt templates from router outputs without hardcoded document scaffolds.
---

# Document Generation Skill

Use this skill after meeting understanding and `document-router` have identified which follow-up documents are needed.

## Tools

- `document_prompt_catalog(includeTemplate?)`
- `document_prompt_select(routerDocuments?, requestedOutputs?, taskDescription?)`
- `document_prompt_render(docType?, promptFile?, input, routerConclusion?, evidenceSummary?, upstreamDocuments?, operation?, reviewContext?, contextEnvelopeRef?, workUnits?)`
- `document_prompt_render_batch(documents, input, routerConclusion?, evidenceSummary?, upstreamDocuments?, operation?, reviewContext?, contextEnvelopeRef?, workUnits?)`

## Rules

- Do not hardcode PRD, operations, architecture, or checklist sections in workers.
- Select prompt files through `meeting-agent-pi-package/runtime/document-prompt-registry.json`; do not maintain a second mapping in worker code.
- Treat registry `dependsOn` and `audience` as document generation metadata. For example, `tech-architecture` depends on `prd`, and `customer-requirement-checklist` targets FDE communication and depends on both `prd` and `tech-architecture`.
- Treat registry `operationOverlays` as small task overlays, not duplicate document prompts. `document_revision` uses `document-revision-overlay.md` on top of the base docType prompt so PRD, operations, architecture, and checklist structures still have one source of truth.
- Render prompt files by replacing `{{input}}` with pointer-only context-plane summary, evidence summary, and router conclusion.
- For document revision tasks, pass only bounded review summary into the renderer; detailed comments belong in `source-context-runtime` context packs.
- When upstream documents already exist, pass bounded dependency summaries/context maps; do not inject full upstream Markdown into downstream workers.
- Parallel document workers should receive `documentWorkItems[].workUnits[].contextPackRef` from `document_prompt_render_batch`; prompt instructions are registry rules only, not a full source payload.
- Unknown `docType` values must return `unmappedDocuments` or blocked errors; do not silently omit requested documents.
- Each prompt file must stay under `prompts/` and include exactly one `{{input}}` placeholder.
- Keep generation evidence-bound: each final document must distinguish evidence facts, inference, and open questions.
- Do not pass secrets, tokens, cookies, CLI sessions, App Secret values, or raw media through prompt rendering.
