# Meeting Agent Workspace

This workspace contains a PI-first meeting agent package plus a Hermes-inspired
learning sidecar.

The architecture separates execution from learning:

- PI is the active execution kernel for meeting ingestion, document generation,
  official `lark-cli` Feishu operations, and Rokid tool use.
- Hermes is treated as a read-only learning sidecar that reviews sanitized task
  trajectories and proposes memory, prompt, skill, and eval improvements.
- Human review is the only path from proposals back into production skills or
  prompts.

## Layout

```text
meeting-agent-pi-package/  PI package: skills, prompts, and extensions
hermes-learning-sidecar/   Read-only sidecar for retrospectives and proposals
src/                       Shared schemas and examples
wiki/                      PRD, architecture, prompt, skill, and safety docs
```

## PI package install

From this workspace, install the package locally in PI:

```bash
pi install -l ./meeting-agent-pi-package
```

Or test without installing:

```bash
pi -e ./meeting-agent-pi-package
```

## Runtime Configuration

Use `.env.local` as the only manual runtime configuration entrypoint. Copy the
template and fill the real LLM keys locally:

```bash
cp .env.example .env.local
```

Default DeepSeek runtime/document run:

```bash
set -a
source .env.local
set +a

pi --provider "$PI_PROVIDER" --model "$PI_MODEL"
```

Meeting privacy defaults:

```text
MEETING_TEXT_EVIDENCE_EXTERNAL_LLM_DEFAULT=allow
MEETING_RAW_MEDIA_EXTERNAL_UPLOAD_DEFAULT=deny
```

Transcript/evidence text is the default semantic input for DeepSeek and Xiaomi.
Raw audio/video/base64 media remains local-only unless a future task explicitly
adds an external ASR path.

Runtime engineering is local-artifact first:

- Office Agent decision layers are limited to Planner, Model Router, Prompt
  Registry, Document Worker, QA Gate, and Policy Gate. Capability Registry is a
  catalog/readiness source. `task_router.mjs` only chooses task intent and
  `executionProfile`; adapters, handlers, publishers, File Context, ASR,
  Observability, Hermes, `task_execution_runner`, and `runtime_tool_cli` only
  transform, execute, record, or review.
- `planner-runtime` records a Planner Envelope for non-trivial runs. The
  envelope captures `goal`, `taskType`, `successCriteria`, `capabilitiesNeeded`,
  `toolPlan`, `parallelizableWorkers`, `policyRisks`, `requiredArtifacts`, and
  `stopConditions`; it is an auditable plan for the current goal, not a fixed
  workflow.

## Production Runtime

Use the local runtime supervisor as the production entrypoint for Feishu live
handling. It manages `feishu-handler` and `feishu-gateway`, checks local ASR,
and writes machine-readable health under `runtime-runs/_services/supervisor/`.
Bare `screen` sessions are fallback only.

```bash
python3 meeting-agent-pi-package/tools/local_runtime_ctl.py start
python3 meeting-agent-pi-package/tools/local_runtime_ctl.py status
python3 meeting-agent-pi-package/tools/local_runtime_ctl.py doctor
```

The default supervisor environment matches the live startup scripts:
`FEISHU_AGENT_EXEC_MODE=execute`, `FEISHU_AGENT_ASYNC=1`,
`FEISHU_AGENT_PUBLISH_MODE=live`, `FEISHU_AGENT_REPLY_MODE=live`, and
`FEISHU_AGENT_PUBLISH_AS=user`. ASR stays Host-owned; the supervisor reports and
can recover it, but raw audio is still never sent to Docker or external ASR.

Run the unified local CI before production changes:

```bash
python3 meeting-agent-pi-package/tools/local_ci_check.py
```

The CI report is written to `runtime-runs/_services/ci/latest.json`. It covers
workspace validation, Python compile, Node/TypeScript syntax checks, JSON parse,
Docker compose config with the Docker Desktop CLI fallback, and Swift tests when
`AgentWorkbench/` exists.
- `policy-gate` checks action intent boundaries such as
  `publish_customer_visible`, `notify_people`, `mutate_calendar`,
  `assign_task`, `external_web`, `install_dependency`, `persist_memory`, and raw
  media external upload. It returns `pass`, `needs_confirmation`, or `blocked`
  without prescribing business steps.
- `runtime_metrics_*` writes `runtime-runs/{run_id}/run.metrics.json`.
- `capability_registry_*` keeps the Feishu Agent bridge, Feishu bot, Rokid,
  WebAccess/MCP, Agent Team, and third-party subagent packages lazy until a task
  needs them.
- `model_route_plan` may automatically fall back from DeepSeek to a configured
  candidate, but `model_route_record` must write `model-route.json`; silent
  fallback is not allowed. The default route for ordinary short drafting is
  `deepseek/deepseek-v4-flash`; `meeting_minutes`, deep PRD/architecture/ops
  work, and explicit deep-thinking requests route to
  `deepseek/deepseek-v4-pro`.
- `context_offload_*` stores long transcript/evidence payloads under
  `runtime-runs/{run_id}/offload/` so the main context is pointer-only for raw
  transcript/full evidence: artifact path, hash, size, bounded preview,
  topicMap, evidence map, QA gate, and open questions.
- `agent_team_*` exposes dynamic worker components through Node
  `worker_threads`; it uses a dynamic worker pool and does not preload fixed
  subagent roles.
- `document_prompt_*` uses `document-prompt-registry.json` as the single
  `docType -> promptFile` mapping. It renders `prompts/*.md` with evidence and
  router conclusions before any document worker runs.
- `document_workers_run` executes one rendered prompt per parallel document
  worker through `model_provider_*`; each document worker then runs section
  batches from registry `requiredSections`, merges them, repairs missing
  sections once, records document-shard routes in `model-route.json`, and
  returns per-document Markdown plus QA input.
- `model_provider_*` supports DeepSeek, Xiaomi, and mock smoke runs. DeepSeek
  defaults to `https://api.deepseek.com`; Xiaomi requires `XIAOMI_BASE_URL` and
  must not use a hardcoded endpoint. Non-mock `model_generate_text` calls must
  include the selected `modelRoute` from `model_route_plan`.
- `office-runtime` records document lifecycle metadata, pointer-only retrieval
  indexes, office object references, and memory proposals. It blocks
  destructive document actions, requires explicit targets for overwrites, and
  never persists memory automatically.
- Existing document revision is a lazy document lifecycle capability. Feishu
  doc/docx/wiki links plus "批注/评论/修改内容/重新优化" generate
  `review-context.json`. The runner now reads independent Feishu comment
  threads through `lark-cli drive file.comments list` / `batch_query` and
  `file.comment.replys list` before falling back to exported-body review
  signals; missing `docs:document.comment:read` or equivalent Drive/Docs scopes
  is recorded explicitly as permission-blocked context. Comments are grouped
  under `sourceDocuments[].comments[]` with `matchStatus` and `matchReason`, so
  multi-document revision cannot apply one source's comment to another source.
  The document still uses its base prompt from
  `document-prompt-registry.json` with `document-revision-overlay.md` appended,
  so revision support does not create a second document workflow.
- `im_file_context_helpers.mjs` is the shared file-context helper used by
  Feishu and WeChat adapter paths. `wechat_event_adapter.mjs` is fixture-only in
  this iteration: it maps local WeChat-shaped input into `im-event-v1` and can
  call the same handler/runner in mock dry-run mode.
- `task_router.mjs` is the shared profile router. It emits
  `taskIntent.executionProfile`, `reasoningDepth`, `requiredStages`, and
  `skipStages` for `fast_answer`, `file_summary`, `audio_minutes`,
  `document_generation`, `document_revision`, `multi_source_synthesis`,
  `publish_only`, and `unsupported` while preserving the existing
  `taskType/responseMode/requestedDocuments/requiresLocalAsr/sourcePreparation`
  contract.
- `runtime_tool_cli.mjs` reads `runtime/tool-load-manifest.json` and supports
  `--profile`, so short profiles load only Model Router / Model Provider while
  document profiles load Planner, Prompt Registry, Document Worker, QA, Policy,
  Office, and media extensions as needed.

Capability Registry entries are planner-selectable capability descriptions, not
a module checklist. Each entry must describe its `description`, `toolIntents`,
`policy`, `observability`, `installState`, and `securityReview` so the Planner
can justify capability selection and the Policy Gate can check risky actions.
The package audit/install mechanism keeps third-party capabilities in candidate
state until a security review is recorded; dependency installation requires
`install_dependency` Policy Gate approval and writes a `packageAudits` metrics
entry.

Runtime metrics must expose planner, policy, worker, capability, and package
decisions through `plannerDecisions`, `policyDecisions`, `workerDecisions`,
`capabilitySelections`, and `packageAudits`.

## Local Docker Runtime

本地 Docker 不能减少本机总计算消耗；它的价值是把长任务放进受限常驻执行面，通过进程隔离、资源上限、队列深度和并发控制避免 Feishu 主入口被拖垮。当前采用 **Host 原生控制面 + Local Docker 受限执行面**：

- Host 保留 Feishu live、`lark-cli`、macOS keychain、附件下载/发布/回复、本机 MLX ASR、文档修订评论预取。
- Docker 常驻轻服务包含 `runtime-queue`、`pi-document-worker` 和 `hermes-worker`。
- `fast_answer/file_summary 不进 Docker`，仍走 host 轻路径。
- `document_generation/multi_source_synthesis 默认进 Docker worker`，但只有设置 `FEISHU_AGENT_DOCUMENT_WORKER_MODE=docker|local-docker|queue` 后才启用；未启用时保持 host runner。
- `audio_minutes` 的 normalize + local ASR 留在 Host；后续 transcript/evidence 可作为 bounded artifact 进入文档阶段，但 `raw audio 不进容器`。
- `document_revision` v1 留在 Host，因为 Feishu comment/review-context 预取仍依赖 `lark-cli` 和本机凭证。
- Docker worker 不调用 `lark-cli`，不 publish，不 reply，只产出 `agent-output.json` 和 runtime artifacts；Host 拉回结果后继续 QA/Policy 边界内的 Feishu 发布/回复。

默认资源档位为 `4 CPU / 8GB / 长文档并发 2`，Hermes worker 为 1 CPU / 1GB，Redis queue 为 256MB。启动常驻轻服务：

```bash
docker compose -f docker-compose.local-runtime.yml up -d runtime-queue pi-document-worker hermes-worker
```

启用长文档入队：

```bash
FEISHU_AGENT_DOCUMENT_WORKER_MODE=docker \
node meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs \
  --host 127.0.0.1 \
  --port 8788 \
  --execute
```

Feishu bidirectional Agent work is CLI-first. `lark-cli` remains the active
OpenAPI/Docs/Drive/IM operation path, and the preferred inbound path is
`lark-cli event consume <EventKey> --as bot` feeding the local
`feishu_agent_task_handler`. The handler creates run artifacts, resolves
attachments, invokes the PI planner/document runtime path, and publishes only after
QA Gate and Policy Gate allow it.

Profile-driven tasks use `task_execution_runner` as a thin observable executor
after source resolution. It is not a decision layer: `fast_answer` and
`file_summary` call Model Router / Model Provider directly and reply without
document workers, QA, Policy, Wiki publish, or ASR. Document profiles prepare
current attachments, explicit Feishu file URLs, parent/root resources, and
modality-filtered cache hits into a consolidated `evidence-pack`; audio sources
are normalized to local `16k mono s16 WAV` and transcribed before evidence
merging. The runner then calls Planner/Model Router/Prompt Registry/Document
Worker/QA Gate/Policy Gate tools through `runtime_tool_cli`, writes stage
artifacts, and emits progress replies. It also writes `document-title-plan.json`
and syncs each final Markdown H1 plus Feishu `.md` name to the project/direction
inferred from the user prompt and source map, so PRD/architecture/checklist and
meeting-minutes documents do not fall back to generic docType names.
Feishu audio minutes regression requires `task_execution_runner_started`,
`audio_downloaded`, `audio_normalized`, `local_asr_completed`,
`model_route_planned`, `meeting_minutes_generated`, `qa_gate_completed`,
`policy_gate_completed`, and a final publish/reply state to be inspectable in
local artifacts.

Feishu Wiki is now the default delivery target when `FEISHU_AGENT_PUBLISH_TARGET`
is `auto` or `wiki`. The publisher writes `wiki-publish-plan.json`, creates
Markdown documents, ensures dynamic project/run/category Wiki nodes, moves docs
with `wiki +move`, and records `wiki-publish.json`; Wiki permission failures
fall back to Drive with `wiki_publish_blocked_drive_fallback`. Hermes uses a
separate thinking Wiki target (`HERMES_WIKI_SPACE_ID` or
`HERMES_WIKI_ROOT_NODE_TOKEN`) and writes `hermes-wiki-candidate.json` plus
`hermes-wiki-publish.json`; it never publishes into the user deliverables Wiki.

Feishu file tasks now pass through a `file-context` layer before planning. The
handler supports PDF/Word/Excel/Markdown/TXT/CSV-style text files and explicit
Feishu file URLs/tokens. Current attachments and explicit URLs outrank parent/root
resources and recent cache; cache fallback is filtered by expected modality so
old audio cannot override a document-writing request. Multiple audio/files/URLs
are consolidated by default, with source attribution for conflicts. User-uploaded
text files may be sent to the LLM with the user's prompt; audio/video raw media
still stays local. Unsupported file types or unsupported requested actions reply
with `目前暂不支持该功能`.

Local dry-run setup:

```bash
node meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs \
  --host 127.0.0.1 \
  --port 8788 \
  --publish-mode dry-run \
  --reply-mode dry-run

FEISHU_EVENT_KEY=<event_key> \
node meeting-agent-pi-package/tools/feishu_event_runner.mjs \
  --event-key "$FEISHU_EVENT_KEY" \
  --handler-url http://127.0.0.1:8788/feishu/events
```

Each run writes `event.json`, `task.json`, `state.json`, `agent-task.md`,
`file-context.json`, `agent-output.json`, `publish.json`, `reply.json`,
`run.metrics.json`, `run-manifest.json`, and `sanitized-trajectory.json` under
`runtime-runs/feishu-agent/runs/{runId}/`. `state.json` is the task state
machine, `run.metrics.json` is runtime observability, and
`sanitized-trajectory.json` is the Hermes learning input. Fixture/mock runs do
not need live Feishu auth; live smoke requires `lark-cli auth status --verify`
and the bot's event, reply, resource download, Drive, and Markdown permissions.
The cross-channel contract is captured by `im-event-v1`, `im-attachment-v1`,
`im-reply-v1`, `publish-target-v1`, and `office-task-state-v1`; Feishu is the
first adapter. WeChat is adapter-skeleton only in this round: document schema
mapping and capability boundaries, but no live receive, attachment download,
file send, group publish, or cloud-doc workflow commitment.

The SDK long-connection gateway is optional and can forward to the same handler.
For that setup, enable bot capability, subscribe to `im.message.receive_v1`,
publish the app, then run:

```bash
npm install @larksuiteoapi/node-sdk@^1.24.0

FEISHU_APP_ID=cli_xxx \
FEISHU_APP_SECRET=... \
FEISHU_BOT_HANDLER_URL=http://127.0.0.1:8788/feishu/events \
node meeting-agent-pi-package/tools/feishu_bot_event_gateway.mjs
```

When `FEISHU_BOT_HANDLER_URL` is set to a loopback URL, the gateway defaults to
HTTP handler mode. For real PI runs that may exceed a short bot reply window,
run the handler with `FEISHU_AGENT_ASYNC=1`; the gateway will reply with a
user-facing accepted message without exposing the local `runId`, and avoid
duplicate replies when the handler has already sent a live Feishu reply.

If the bot identity lacks Drive/Markdown scopes, set
`FEISHU_AGENT_PUBLISH_AS=user` for the handler so document creation uses the
verified CLI user identity while message replies still use the bot identity.
Set `PI_CLI_BIN` to a verified PI CLI when the default `pi` wrapper does not
support the configured provider; the handler passes `--provider` and `--model`
explicitly to avoid silent provider drift.

MCP is optional for exposing Feishu APIs as AI tools. It is not required for the
bot to receive and reply to Feishu chat messages or to publish Feishu documents.

Feishu output that enters model context defaults to redaction. Use
`redactionPolicy: "auth-status-summary"` for `lark-cli auth status` and
`redactionPolicy: "secret-scan"` for other CLI output that may contain identity,
tenant, token, cookie, session, or app metadata. Raw auth status output must not
be returned to the model.

Xiaomi MiMo reviewer/fallback run:

```bash
set -a
source .env.local
set +a

pi --provider "$PI_REVIEW_PROVIDER" --model "$PI_REVIEW_MODEL"
```

`.pi/settings.json` only loads `meeting-agent-pi-package`; do not put provider,
model, endpoint, or API key values there. If PI does not recognize the Xiaomi or
DeepSeek provider, update PI instead of adding a custom `~/.pi/agent/models.json`
fallback:

```bash
npm install -g @earendil-works/pi-coding-agent@latest
```

## Local ASR

Audio-to-text is local-only and runs through a local HTTP service. Product
inputs may be WAV/MP3/M4A/AAC/FLAC/OGG; the local runtime first writes
`audio-normalize.json` and normalized `16k mono s16 WAV` files, then PI calls
`meeting_transcribe_local_asr` with those local normalized paths. Raw audio is
never uploaded to DeepSeek or Xiaomi.

The production path starts and monitors ASR through `local_runtime_ctl.py`.
For direct ASR debugging, use the lifecycle helper or the raw service command:

```bash
python3 meeting-agent-pi-package/tools/local_asr_service_ctl.py status
python3 meeting-agent-pi-package/tools/local_asr_service_ctl.py start
```

```bash
.venv-qwen3-asr/bin/python meeting-agent-pi-package/tools/local_asr_http_service.py \
  --host 127.0.0.1 \
  --port 8765 \
  --model-dir models/Qwen3-ASR-1.7B-MLX-4bit \
  --preload
```

The current default is Qwen3-ASR 1.7B via MLX 4-bit weights on Apple Silicon:

```text
models/Qwen3-ASR-1.7B-MLX-4bit
```

The validated QA-RAW run produced 114 transcript segments from 56.62 minutes of
audio with 0 failed chunks, at about 3.15x realtime. Raw audio is not uploaded by
the ASR step. Downstream semantic drafting uses DeepSeek as the primary
drafting/document model and Xiaomi MiMo as reviewer/fallback; both receive
text evidence only. Transcript/evidence text is the default allowed semantic
input; raw audio/video remains the only hard media boundary.
There is no PI script fallback for ASR; if the local ASR service is unavailable,
the tool blocks with `local_asr_service_unavailable`.

Legacy evidence under `qa-runs/` is non-production. Do not rehydrate raw
transcript, raw Feishu output, or model response JSON into the main context; use
the README/marker warnings and regenerate production-style artifacts with local
ASR, context offload, model-route recording, and QA gates.

## Sidecar usage

The sidecar consumes a sanitized trajectory artifact and writes proposals to an
output directory. It does not read Feishu or Rokid credentials.

```bash
python3 hermes-learning-sidecar/sidecar.py \
  --trajectory src/examples/sanitized-trajectory.example.json \
  --out /tmp/meeting-agent-sidecar-output
```

## Security stance

- No Hermes runtime receives Feishu/Rokid tokens.
- Feishu operations use the official `lark-cli` directly through `feishu_cli`;
  do not commit CLI credentials, tokens, cookies, or app secrets.
- Optional confirmation checkpoints can be used when requested, but there is no
  custom Feishu approval store or default dry-run layer.
- Long-term memory stores stable preferences, project facts, and process
  lessons only. Raw meeting content is not long-term memory.
- Known compromised dependency versions, including `mistralai==2.4.6`, are
  explicitly blocked in the dependency policy.
