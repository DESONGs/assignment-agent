# Meeting Agent PI Package

This package implements the active execution plane for the meeting agent.

## Design

- Skills describe procedures and safety rules.
- Prompts provide reusable document-generation entrypoints.
- Extensions register callable tools, including direct official `lark-cli`
  passthrough through `feishu_cli`, Feishu bot readiness checks, and the
  Feishu Agent bridge runner/handler tools under `tools/`.
- Runtime extensions provide metrics, lazy capability planning, model routing,
  QA gate artifacts, context offload, and dynamic Agent Team workers.
- Feishu and Rokid remain tools/skills, not permanent adapter layers.
- Hermes-style learning happens outside this package through sanitized
  trajectory artifacts and human-reviewed proposals.

## Runtime boundaries

PI is allowed to call high-permission tools only through explicit extension
tools. Feishu operations are personal-use direct calls to official `lark-cli`
under the user's current login state and scopes. Optional confirmation
checkpoints are available, but there is no custom Feishu approval store or
default dry-run layer.

Feishu output defaults to redaction before model exposure. `lark-cli auth
status` must use `redactionPolicy: "auth-status-summary"` and general CLI output
that may enter context should use `redactionPolicy: "secret-scan"`. Raw auth
status stdout/stderr, identity metadata, tenant/app/user ids, sessions, tokens,
cookies, and app secrets must not be returned to the model or written into run
summaries.

Feishu bidirectional Agent work uses a CLI-first bridge. `lark-cli` is now both
the active OpenAPI/Docs/Drive/IM operation path and the recommended inbound
event source through `lark-cli event consume`; the SDK long-connection gateway
remains optional and can forward to the same local handler.

Office Agent decision layers are limited to Planner, Model Router, Prompt
Registry, Document Worker, QA Gate, and Policy Gate. Capability Registry is a
catalog/readiness source. `task_router.mjs` only chooses task intent and
`executionProfile`; runners, adapters, handlers, publishers, File Context, ASR,
Observability, Hermes, and `runtime_tool_cli.mjs` only transform, execute,
record, or review.

Start the local task handler for fixture or live events:

```bash
node meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs \
  --host 127.0.0.1 \
  --port 8788 \
  --publish-mode dry-run \
  --reply-mode dry-run
```

Consume Feishu events through the official CLI:

```bash
FEISHU_EVENT_KEY=<event_key> \
node meeting-agent-pi-package/tools/feishu_event_runner.mjs \
  --event-key "$FEISHU_EVENT_KEY" \
  --handler-url http://127.0.0.1:8788/feishu/events
```

The bridge writes `event.json`, `task.json`, `state.json`,
`file-context.json`, `agent-task.md`, `agent-output.json`, `publish.json`, and
`reply.json` under
`runtime-runs/feishu-agent/runs/{runId}/`. Runner, handler, PI generation, and
publisher responsibilities stay separate: the runner only normalizes/forwards
events; the handler owns run artifacts and channel state; PI owns planning,
model routing, prompt registry, section-batched document workers, QA Gate, and
Policy Gate; publisher uses `lark-cli drive +create-folder`,
`markdown +create`, `drive +upload`, and `im +messages-reply` only after
QA/Policy permit live actions.

`task_router.mjs` is the shared profile router for Feishu and future IM
adapters. It emits `taskIntent.executionProfile`, `reasoningDepth`,
`requiredStages`, and `skipStages` while preserving the existing
`taskType/responseMode/requestedDocuments/requiresLocalAsr/sourcePreparation`
contract.

`task_execution_runner.mjs` is a profile-driven thin stage executor for Feishu
and future IM scenarios. It is not a decision layer: `fast_answer` and
`file_summary` only call Model Router / Model Provider and reply directly;
document-oriented profiles prepare current attachments, explicit Feishu file
URLs, parent/root resources, and modality-filtered cache hits into
`evidence-pack.json`; recorded media uses cloud ASR first. Cloud-supported files
use the OSS-backed asynchronous file endpoint, while realtime stream formats use
the separate WebSocket endpoint. A single mixed recording is uploaded once and
uses `fun-asr` diarization plus an independent `paraformer-v2` consistency
review by default. Conflicting intervals remain explicit review evidence and
are never silently merged into the primary transcript. Because file
diarization is mono-only, stereo recordings get a derived mono upload while the
original remains untouched. Local `16k mono s16 WAV`
normalization remains a fallback preparation path. The runner then calls the existing Planner/Model Router/Prompt
Registry/Document Worker/QA Gate/Policy Gate tools through
`runtime_tool_cli.mjs` and records progress. Raw media may leave the host only
during the Policy-Gated cloud ASR stage.
`runtime_tool_cli.mjs` reads `runtime/tool-load-manifest.json` and accepts
`--profile`, so short profiles do not load document worker, QA, Policy, publish,
or ASR extensions.
The runner also emits `document-title-plan.json` and applies it to final
Markdown H1 values and Feishu `.md` names. Titles are derived from the concrete
project/direction in the prompt and source map, not from bare docType defaults.
Feishu audio minutes regression requires `task_execution_runner_started`,
`audio_downloaded`, `audio_normalized`, `local_asr_completed`,
`model_route_planned`, `meeting_minutes_generated`, `qa_gate_completed`,
`policy_gate_completed`, and a final publish/reply state in local artifacts.
Publishing defaults to `FEISHU_AGENT_PUBLISH_TARGET=auto`: the handler attempts
Feishu Wiki first by writing `wiki-publish-plan.json`, ensuring dynamic Wiki
nodes, and moving Markdown documents into Wiki; if Wiki permission or node moves
fail, it records `wiki_publish_blocked_drive_fallback` and falls back to Drive.
Hermes writes to a separate thinking Wiki target via `hermes-wiki-candidate.json`
and `hermes-wiki-publish.json`, never to the user deliverables Wiki.
Future WeChat adapters are
skeleton-only this round: they may map unified IM/task schemas and capability
boundaries, but do not promise live receive, attachment download, file send,
group publish, or cloud-doc workflows.

### Local Docker bounded execution

本地 Docker 不能减少本机总计算消耗；本包只把它作为受限常驻执行面使用。运行边界是 **Host 原生控制面 + Local Docker 受限执行面**：

- Host handler 继续拥有 Feishu live、`lark-cli`、macOS keychain、附件下载、发布、回复、本机 MLX ASR，以及 `document_revision` 的 Feishu comment/review-context 预取。
- `fast_answer/file_summary 不进 Docker`，因为现有轻路径更快且不需要队列隔离。
- `document_generation/multi_source_synthesis 默认进 Docker worker`；实际入队需要 `FEISHU_AGENT_DOCUMENT_WORKER_MODE=docker|local-docker|queue`，默认 `host` 保持兼容。
- `audio_minutes` 先在 Host 完成 audio normalize + local ASR；后续 transcript/evidence 可以进入文档阶段，但 `raw audio 不进容器`。
- Docker worker 只消费 bounded `task.json`、`file-context.json`、extracted text/evidence/source metadata，不接收 Feishu token、App Secret、CLI session、cookie 或 raw media。
- Docker worker 不调用 `lark-cli`，不 publish，不 reply，只写 `agent-output.json` 和 runtime artifacts；Host 继续执行 Feishu publish/reply。

常驻服务和默认资源档位：

```bash
docker compose -f docker-compose.local-runtime.yml up -d runtime-queue pi-document-worker hermes-worker
```

`pi-document-worker` 使用 `4 CPU / 8GB / 长文档并发 2`；`hermes-worker` 使用 1 CPU / 1GB 且设置 `HERMES_WIKI_AUTO_PUBLISH=0`；`runtime-queue` 使用 Redis 轻服务，内存上限 256MB。队列超阈值或 worker 超时/OOM 时返回 blocked/retry-later 类结果，不自动退回 Host 长链路。

File messages enter ingestion first, then the runtime context plane before PI planning. The handler
supports PDF/Word/Excel/Markdown/TXT/CSV-style text files and explicit Feishu
file URLs/tokens. Current attachments and explicit URLs outrank parent/root
resources and recent cache; cache fallback is modality-filtered so old audio
cannot override document-writing prompts. Multiple files/audio/URLs are
consolidated into one source context manifest by default. `file-context` only
classifies, downloads, and extracts metadata/text; `source-context-runtime`
creates source records, source segments, deterministic retrieval plans, bounded
context packs, work units, and pre-generation context gates. User-uploaded text
evidence may be sent to the LLM only through selected bounded context packs.
Unsupported file types or unsupported requested actions return `目前暂不支持该功能`.

To use the optional SDK long-connection gateway, enable the bot capability,
subscribe to `im.message.receive_v1`, and run:

```bash
npm install @larksuiteoapi/node-sdk@^1.24.0

FEISHU_APP_ID=cli_xxx \
FEISHU_APP_SECRET=... \
FEISHU_BOT_HANDLER_URL=http://127.0.0.1:8788/feishu/events \
node meeting-agent-pi-package/tools/feishu_bot_event_gateway.mjs
```

With a loopback `FEISHU_BOT_HANDLER_URL`, the gateway defaults to HTTP handler
mode; `FEISHU_BOT_REPLY_MODE=http` is optional. Use `FEISHU_AGENT_ASYNC=1` on
the handler for real PI runs so the HTTP path can return `202 accepted` with a
local artifact `runId` while the runtime continues in the background; the
Feishu user-visible reply must only say that the task was accepted or completed.
Set `PI_CLI_BIN` when the default `pi` wrapper is not the provider-capable PI
CLI; the handler passes `--provider` and `--model` explicitly for each attempt.

For live publishing, the handler defaults to `--as bot` for Drive/Markdown
operations. If the bot app is missing Drive scopes but the local CLI user is
authorized, start the handler with `FEISHU_AGENT_PUBLISH_AS=user`; replies still
use the bot identity.

MCP is optional for AI tool access to Feishu APIs; it is not required for the
bot to receive chat events or publish results. The PI tools
`feishu_bot_gateway_plan` and `feishu_bot_gateway_check` expose setup guidance
and redacted readiness checks without returning secrets.

Audio transcription is cloud-first when a DashScope API key is configured.
Recorded files use `fun-asr` as the primary model through the HTTP asynchronous file endpoint;
the runtime uploads the source to private OSS and supplies a short-lived signed
HTTPS URL. In the default `robust` single-mix mode, the same uploaded object is
also reviewed by `paraformer-v2`; cross-model omissions, text conflicts, speaker
attribution conflicts, and provider timestamp overlaps are written to
`asr/single-mix-analysis.json`. The primary transcript stays authoritative and
affected segments are marked `needs_review`. Recorded-file diarization is
`auto` by default, accepts an optional 2–100 speaker-count hint, and preserves
anonymous `speaker_id`/channel evidence through transcript, evidence, and
document context artifacts. Realtime streams
use `paraformer-realtime-v2` through WebSocket and remain limited to the
provider's mono stream codecs; that realtime path does not claim speaker
diarization. Diarization clusters speaker turns but does not separate
simultaneous same-channel voices. Dual-model review improves detection of
missing or unstable words but is not source separation and cannot guarantee
recovery of every simultaneous speaker, so unresolved intervals are prevented
from becoming certain meeting claims downstream. These endpoints, models,
format matrices, and errors are configured separately. Local Qwen3-ASR remains
an explicit fallback and receives normalized WAV paths only. Downstream
DeepSeek, Xiaomi, Docker workers, and Hermes receive transcript/evidence text,
never raw media or signed OSS URLs.

The Hermes learning sidecar is intentionally excluded from this package because
it should not receive credentials or direct write access.

## Runtime Extensions

- `planner_envelope_plan/write`: create and record the Planner Envelope for the current
  goal, including capability, tool, worker, policy risk, artifact, and stop
  condition fields. The envelope is a scenario playbook for this run, not a
  fixed workflow.
- `policy_gate_check`: evaluate risky action intents and return
  `pass|needs_confirmation|blocked` without generating business steps.
- `runtime_metrics_start/record/finish`: write sanitized run metrics.
- `capability_registry_list/plan/check/enable`: choose lazy capabilities and
  report setup needs without installing packages.
- `document_prompt_catalog/select/render/render_batch`: load prompt templates
  through `document-prompt-registry.json`; document structure lives in
  `prompts/*.md`.
- `source_context_prepare/segment/plan_retrieval/build_pack/gate`: build the
  runtime context plane from files, ASR transcript, review comments, parent
  context, and task intent; write `source-records.json`,
  `source-segments.jsonl`, `retrieval-plan.json`, bounded
  `context-packs/*.json`, and `context-manifest.json`.
- `document_workers_plan/run`: run bounded work units per parallel document
  worker, split each document into registry `requiredSections` section batches,
  merge and repair missing sections, call `model_provider_*`, preserve
  `taskIndex`, and return Markdown plus QA input.
- `model_provider_check/model_generate_text`: redacted provider adapter for DeepSeek,
  Xiaomi, and mock smoke runs. Xiaomi requires `XIAOMI_BASE_URL`; no Xiaomi
  endpoint is hardcoded. Non-mock generation must include the selected
  `modelRoute` from `model_route_plan`.
- `model_route_plan/record`: allow automatic configured fallback while writing
  `model-route.json`. Ordinary short drafts default to
  `deepseek/deepseek-v4-flash`; `meeting_minutes`, PRD, architecture, complex
  ops/checklist, and explicit deep-thinking work default to
  `deepseek/deepseek-v4-pro`.
- `qa_gate_evaluate/write`: produce machine-readable publish gates.
- `context_offload_plan/write/read`: keep long transcript/evidence payloads as
  local artifacts with bounded readback; main context remains pointer-only for
  raw transcript/full evidence.
- `agent_team_components/plan/run`: run task-shaped worker components in
  parallel with Node `worker_threads` from a dynamic worker pool, not fixed
  always-on roles.
- `feishu_event_runner.mjs`: consume `lark-cli event consume` NDJSON, normalize
  and deduplicate events, write sanitized event logs, and forward to the local
  handler.
- `feishu_agent_task_handler.mjs`: receive normalized events, resolve
  attachments, build file-context, generate the PI task prompt, run mock or
  execute mode, and write publish/reply artifacts.
- `im_file_context_helpers.mjs`: shared Feishu/WeChat file-context helper for
  attachment classification, text extraction, progressive disclosure, and
  cloud-ASR-compatible audio/video source readiness.
- `asr_media_formats.mjs`: single provider-aligned source of truth for realtime
  codecs and recorded-file audio/video extensions.
- `asr_diarization_helpers.mjs`: probes recorded media and prepares a derived
  mono input only when file-mode speaker diarization requires it.
- `single_mix_asr_helpers.mjs`: aligns the primary and independent review ASR
  timelines for one mixed recording and emits explicit unresolved evidence
  without silently rewriting the primary transcript.
- `audio_normalize_helpers.mjs`: fallback media-to-audio helper that extracts or
  converts any supported cloud ASR container to `16k mono s16 WAV`.
- `wechat_event_adapter.mjs`: fixture-only WeChat adapter skeleton; maps local
  WeChat-shaped input into unified IM contracts and calls the same handler in
  mock/dry-run mode without duplicating the Agent flow.
- `task_router.mjs`: shared task intent router; outputs profile fields for
  `fast_answer`, `file_summary`, `audio_minutes`, `document_generation`,
  `document_revision`, `multi_source_synthesis`, `publish_only`, and
  `unsupported`.
- `task_execution_runner.mjs`: execute observable stages by
  `executionProfile`; short profiles use bounded direct generation, long
  document profiles reuse Planner/Model Router/Prompt Registry/Document
  Worker/QA/Policy decisions.
- `runtime_tool_cli.mjs`: local bridge used by the runner to invoke PI
  extension tools without reimplementing their logic; extension loading comes
  from `runtime/tool-load-manifest.json` and optional `--profile`.
- `office-runtime.ts`: local tools for document lifecycle metadata, office
  object references, pointer-only retrieval index, and reviewable memory
  proposals. Deletion stays blocked; memory is not auto-persisted.
- `document_revision`: lazy document lifecycle operation for existing Feishu
  docs. The runner writes `review-context.json`; for Feishu cloud documents it
  first tries `lark-cli drive file.comments list`, `drive file.comments
  batch_query`, and `drive file.comment.replys list`, then falls back to the
  same OpenAPI through SDK if the CLI wrapper is unavailable. Missing
  `docs:document.comment:read` or equivalent Drive/Docs scopes is recorded as
  `comment_api_permission_blocked`; exported-body comment traces are treated as
  secondary evidence only. The review context groups comments under
  `sourceDocuments[].comments[]`; each comment keeps `sourceId`, `matchStatus`,
  and `matchReason`, while the top-level `comments` list is compatibility-only.
  Prompt rendering appends
  `document-revision-overlay.md` to the base docType prompt, and document
  workers still use section batching through the normal prompt registry path.

Third-party `pi-subagents`-style packages stay candidate-only until audited.
The default implementation uses local workers so the package does not need an
unreviewed subagent dependency to get real parallel execution.

Capability registry records are planner-selectable capability descriptions.
Every capability record must include `description`, `toolIntents`, `policy`,
`observability`, `installState`, and `securityReview`. Third-party package
enablement follows a package audit/install mechanism: audit first, keep the
capability candidate/disabled until approved, require a Policy Gate
`install_dependency` decision for installation, and record the result in
`packageAudits`.

Metrics records must include the runtime decision fields `plannerDecisions`,
`policyDecisions`, `workerDecisions`, `capabilitySelections`, and
`packageAudits`, in addition to model/tool/artifact counts and QA status.

## Local ASR Service

Use the host lifecycle helper for day-to-day checks:

```bash
python3 meeting-agent-pi-package/tools/local_asr_service_ctl.py status
python3 meeting-agent-pi-package/tools/local_asr_service_ctl.py start
python3 meeting-agent-pi-package/tools/local_asr_service_ctl.py stop
```

The helper manages pid/log files under `runtime-runs/_services/local-asr/`
and only targets the loopback `LOCAL_ASR_SERVICE_URL`.

The direct service command remains:

```bash
.venv-qwen3-asr/bin/python meeting-agent-pi-package/tools/local_asr_http_service.py \
  --host 127.0.0.1 \
  --port 8765 \
  --model-dir models/Qwen3-ASR-1.7B-MLX-4bit \
  --preload
```

API:

- `GET /health`: service status and loaded model.
- `GET /v1/models`: default and loaded local model directory.
- `POST /v1/transcriptions`: local normalized WAV paths plus meeting metadata; writes
  `sources.json`, `transcript.full.json`, `evidence-index.json`, and
  `summary.json`.
