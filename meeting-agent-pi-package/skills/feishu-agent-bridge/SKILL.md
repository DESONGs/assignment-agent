---
name: feishu-agent-bridge
description: Use when Feishu inbound messages or attachments should trigger the local PI Agent runtime path and optionally publish approved results back to Feishu through official lark-cli.
---

# Feishu Agent Bridge Skill

Use this skill for Feishu bidirectional work:

```text
Feishu user/group -> lark-cli event consume -> feishu_event_runner -> feishu_agent_task_handler
-> file-context -> task_execution_runner for audio minutes or PI document runtime for files
-> Planner Envelope -> Capability Registry -> Model Router -> local ASR/document runtime
-> QA Gate -> Policy Gate -> lark-cli publish/reply
```

## Operating Rules

- Use CLI-first event ingestion. MCP is not required for Feishu chat reply or
  document publish.
- Decision layers are limited to Planner, Model Router, Prompt Registry,
  Document Worker, QA Gate, and Policy Gate. This bridge, its handler, runner,
  publisher, File Context, ASR, and `runtime_tool_cli.mjs` only transform,
  execute, record, or publish after gates pass.
- `feishu_event_runner.mjs` only consumes, normalizes, deduplicates, records
  sanitized event evidence, and forwards to the local handler.
- `feishu_agent_task_handler.mjs` owns run artifacts, attachment resolution,
  file-context creation, PI task prompt creation, publish/reply execution,
  and state transitions.
- Use `im-event-v1`, `im-attachment-v1`, `im-reply-v1`, `publish-target-v1`,
  and `office-task-state-v1` as the cross-IM contract so future WeChat adapters
  do not duplicate the Feishu flow. WeChat is skeleton-only this round: schema
  mapping and capability boundaries only, with no live receive, attachment
  download, file send, group publish, or cloud-doc workflow commitment.
- `task_execution_runner.mjs` is only a thin stage executor for audio
  meeting-minutes and future IM scenarios. It is not a decision layer: it
  calls Planner, Model Router, Prompt Registry, Document Worker, QA Gate, and
  Policy Gate tools through `runtime_tool_cli.mjs`; it does not choose tasks,
  models, prompts, sections, QA results, Policy results, or publish strategy.
- PDF/Word/Excel/Markdown/TXT/CSV style text files can be used as context for
  the user prompt. If native provider file input is unavailable, use bounded
  text fallback and progressive disclosure rather than loading the full file
  into every prompt.
- Audio files such as `.wav`, `.mp3`, `.m4a`, `.aac`, `.flac`, and `.ogg`
  are accepted only for local ASR meeting-minutes tasks. If a user replies to
  an audio file with "形成会议纪要", "录音", "音频", "转写", or "minutes", resolve
  the parent/root message or recent attachment cache before starting PI.
- Image and video素材 are not accepted in this bridge. Reply exactly
  `目前暂不支持该功能` instead of trying image/video understanding.
- The PI Agent owns planning and generation. It must use Planner Envelope,
  Capability Registry, `document-prompt-registry`, section-batched document
  workers, QA Gate, and Policy Gate.
- Existing Feishu document edits are `document_revision` tasks when the user
  asks to revise, update, optimize from 修改内容, 批注, 评论, or review notes.
  The runner must build `review-context.json` by trying Feishu's independent
  comment thread APIs first through `lark-cli drive file.comments list`,
  `drive file.comments batch_query`, and `drive file.comment.replys list`;
  SDK is only a fallback to the same OpenAPI. If scope is missing, record
  `comment_api_permission_blocked`; if only exported-body markers are visible,
  record `export_body_detected` and keep the missing independent-comment read
  as `待确认`. Then reuse the normal document pipeline with the base docType
  prompt plus `document-revision-overlay.md`; do not create a second revision
  workflow or hardcode PRD/architecture sections in the handler.
- Review context is source-scoped. Multi-document revision tasks must write
  `sourceDocuments[].comments[]`; each comment keeps its own `sourceId`,
  `matchStatus`, and `matchReason`. Do not merge comments into a global pool
  when rendering prompts or QA inputs.
- Model Router remains the only model entry. Meeting minutes use the
  `meeting_minutes` route and default to `deepseek/deepseek-v4-pro`; ordinary
  short drafts default to `deepseek/deepseek-v4-flash`.
- Marker: section-batched document workers.
- The handler must not hardcode PRD, ops, architecture, checklist, or meeting
  minutes section structures.
- raw audio/video/base64 media stays local. Use local ASR for audio only;
  external model calls may receive text transcript/evidence only when allowed.
- Unsupported file types or unsupported requested actions must reply exactly:
  `目前暂不支持该功能`.
- Live Feishu publish requires QA publishable output. For Feishu inbound tasks,
  an explicit user request to create, write, save, publish, archive, or overwrite
  a non-deletion document is treated as publish/write authorization; destructive
  actions such as delete/remove/clear/destroy remain blocked.
- Feishu audio minutes regression requires inspectable state/metrics markers:
  `task_execution_runner_started`, `local_asr_completed`,
  `model_route_planned`, `meeting_minutes_generated`, `qa_gate_completed`,
  `policy_gate_completed`, plus a final publish/reply status.
- Publish targets are chat/thread scoped. Reuse the local publish target registry
  for the current session folder, optionally under `FEISHU_AGENT_FOLDER_TOKEN`.

## Runtime Commands

Start the local handler:

```bash
FEISHU_AGENT_ASYNC=1 \
node meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs \
  --host 127.0.0.1 \
  --port 8788 \
  --publish-mode dry-run \
  --reply-mode dry-run
```

`FEISHU_AGENT_ASYNC=1` returns `202 accepted + runId` immediately to the SDK
gateway while `handleEvent(...)` continues in the background. Synchronous mode is
still useful for fixture QA and short mock-agent checks.

Consume events through the official CLI:

```bash
FEISHU_EVENT_KEY=<event_key> \
node meeting-agent-pi-package/tools/feishu_event_runner.mjs \
  --event-key "$FEISHU_EVENT_KEY" \
  --handler-url http://127.0.0.1:8788/feishu/events
```

Fixture QA path:

```bash
node meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs \
  --fixture /path/to/event.json \
  --mock-agent \
  --publish-mode dry-run \
  --reply-mode dry-run
```

## Required Artifacts

Each run writes under `runtime-runs/feishu-agent/runs/{runId}/`:

- `event.json`: normalized Feishu event.
- `source-events.ndjson`: sanitized local copy of the source event.
- `task.json`: handler task contract, attachment manifest, and intent.
- `state.json`: step-level run state.
- `agent-task.md`: PI task prompt.
- `agent-output.json`: PI output manifest.
- `artifacts/review-context.json`: bounded existing-document revision context
  for document_revision tasks, including detected comment anchors when available
  and explicit missing-comment-access status when Feishu comment context is not
  available.
- `publish.json`: publish plan or live publish result.
- `reply.json`: reply plan or live reply result.

## Feishu CLI Boundaries

Allowed commands for this bridge:

- `lark-cli event consume <EventKey> --as bot`
- `lark-cli im +messages-reply --as bot`
- `lark-cli im +messages-resources-download --as bot`
- `lark-cli drive +create-folder --as bot`
- `lark-cli markdown +create --as bot`
- `lark-cli markdown +overwrite --as bot`
- `lark-cli drive +upload --as bot`
- `lark-cli drive file.comments list --as user|bot`
- `lark-cli drive file.comments batch_query --as user|bot`
- `lark-cli drive file.comment.replys list --as user|bot`

Do not call delete, trash, remove, purge, or destructive Drive commands from
this bridge.

If `lark-cli auth status --verify` fails because the keychain/profile is not
initialized, mark live smoke as environment blocked and keep fixture/mock QA
running. Do not write CLI sessions, App Secret, tokens, cookies, or
Authorization headers into artifacts or model context.
