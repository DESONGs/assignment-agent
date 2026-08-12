> 历史快照：本文记录当时的问题与修复，不代表当前架构。当前状态见本目录 `README.md`。

# Runtime Context Plane Contract Gap

## Status

Fixed in code as a first runtime-context-plane implementation. Keep this issue open until live QA proves document generation, revision, ASR transcript use, and multi-source synthesis all consume bounded context packs instead of monolithic prompts.

## Problem

Feishu document generation, file summary, ASR minutes, and document revision all exposed the same architectural gap: the runtime had ingestion helpers, artifact offload, prompt rendering, document workers, checkpoints, and QA, but no single layer responsible for context ownership.

The visible failures looked different:

- audio tasks previously leaked product file handling into ASR path decisions;
- explicit Feishu file URLs could be routed through stale modality cache;
- file context observability did not show whether parent/root attachments were used;
- document worker live retry kept resending large rendered prompts and timed out;
- document revision treated comments as full-generation context instead of patch-scoped evidence.

The common cause is that source content was flattened too early. `file-context` created previews, `context-offload` wrote artifacts, and `document_prompt_render_batch` generated a `renderedPrompt`, but none of those layers decided which source segments belonged to a given model call.

## Root Cause

The runtime had output sharding but not input sharding. Section workers were asked to write small batches, yet each batch still received a large merged context containing router conclusion, evidence summary, review context, upstream documents, and source input.

This also made retry low quality: checkpoint retry could resume a section, but it reused the same bloated context shape. Provider timeout, `finishReason=length`, and partial stream recovery could diagnose symptoms, but they did not change the context that caused the failure.

## Fix

Introduce `source-context-runtime.ts` as the runtime context plane.

- `file-context` is now ingestion metadata and extraction only.
- `context-offload` remains artifact storage/readback only.
- `source-context-runtime` owns source records, source segments, deterministic retrieval, bounded context packs, work units, and pre-generation context gate.
- `task_execution_runner` calls `source_context_prepare` before prompt rendering and no longer assembles full evidence text into `sourceInput`.
- `document_prompt_render_batch` carries `contextEnvelopeRef` and `workUnits`.
- `document_workers_run` consumes section-scoped context packs and writes `contextPackId`, `sourceSegmentIds`, `promptBudgetChars`, and `retrievalReasons` into trace metadata.

## Acceptance

- Document worker prompts do not include `完整 renderedPrompt`.
- `evidence-pack.json` is pointer-only for source context and keeps `fullRawContentIncluded=false`.
- Each long-document work unit has a `contextPackRef`, `contextPackHash`, and source segment provenance.
- Revision tasks can map comments into source context and block with `needs_review_context`/context-gate diagnostics when evidence is missing.
- Future features introducing file/audio/video/image/document input must design extraction, normalization, segmentation, budget, privacy, cache/store, and failure UX before implementation.

## Related Issues

- `2026-05-20-feishu-audio-format-normalization-gap.md`
- `2026-05-20-feishu-explicit-file-url-routed-to-audio-cache.md`
- `2026-05-20-feishu-file-context-observability-gap.md`
- `2026-05-20-feishu-audio-minutes-post-asr-pipeline-stall.md`
- `2026-05-21-feishu-document-revision-comment-context-routing.md`
- `../problem/2026-05-22-document-worker-stream-timeout-diagnostic.md`
