# Feishu Explicit File URL Routed To Audio Cache

Date: 2026-05-20
Status: fixed

## Problem

A user referenced a Feishu file URL and asked the bot to generate PRD, technical architecture, and customer checklist documents. The handler did not treat the URL as an explicit current source. Because the text contained document-reference words, the recent attachment cache was consulted and returned an older `.wav` file from the same chat. The task then set `requiresLocalAsr=true` and entered the fixed audio meeting-minutes runner.

## Root Cause

- Explicit Feishu file URLs were not converted into source references before parent/cache lookup.
- Recent cache lookup did not filter by expected source modality.
- `requiresLocalAsr` was treated as a routing decision for `meeting_minutes`, instead of a source-preparation flag.
- `task_execution_runner` only supported the audio meeting-minutes path and hardcoded `meeting-minutes`.

## Fix

- Current attachments and explicit Feishu file URLs are converted into `sourceReferences[]` before parent/cache lookup.
- Explicit file URLs disable recent-cache fallback.
- Cache fallback is modality-filtered: text/document tasks use text files; audio cache is used only for explicit audio/recording/transcription cues.
- `sourcePreparation` records `sourceSetMode=consolidated`, `inputModalities`, `sourceReferences`, `requiresLocalAsr`, `requestedDocuments`, and `conflictPolicy=source_attribution`.
- The task runner now handles `document_pipeline` generally: optional ASR, consolidated `evidence-pack.json`, prompt registry rendering, section-batched document workers, QA, Policy, and publish/reply.

## Regression Checks

- Feishu file URL + PRD/architecture/checklist does not use old cached audio.
- Markdown/text file + PRD/architecture/checklist does not emit ASR states.
- Multiple audio sources can be consolidated into one evidence pack for meeting minutes.
- Audio can be used as evidence for PRD/architecture/checklist without forcing meeting-minutes output.
