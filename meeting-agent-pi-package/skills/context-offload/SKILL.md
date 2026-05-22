---
name: context-offload
description: Offload long transcript, evidence, and draft payloads into local runtime artifacts so the main context keeps only topic maps, evidence maps, QA gates, open questions, and artifact pointers.
---

# Context Offload Skill

Use this skill for long meetings, multi-document runs, or any run where raw transcript would dominate the main context.

## Tools

- `context_offload_plan(inputSummary, estimatedInputTokens?, segmentCount?, rawTranscriptBytes?)`
- `context_offload_write(runId, artifactName, payload, payloadType?, outputRoot?, maxPreviewChars?)`
- `context_offload_read(artifactPath, maxChars?)`

## Rules

- Raw transcript and full evidence indexes must be local artifacts, not durable conversation context.
- Main context is pointer-only for raw transcript/full evidence. Keep only
  `artifactPath`, `sha256`, `sizeBytes`, bounded `preview`, `topicMap`,
  `internalEvidenceMap`, `qaGate`, `openQuestions`, and artifact pointers.
- Reads must be bounded and purpose-specific; do not rehydrate a full long transcript unless a task explicitly requires it.
- Secret-like values are redacted before writing previews or pointers.
- Offload artifacts are local debugging and evidence assets, not customer-visible output.
- Legacy `qa-runs/` transcript and response JSON files are non-production
  evidence. Do not paste them into main context; regenerate or read bounded
  slices through current offload pointers.
