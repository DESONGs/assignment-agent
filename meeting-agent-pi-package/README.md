# Meeting Agent Pi Package

更新时间：2026-08-12。

本目录是 Meeting Agent 的活动执行平面，包含 Pi extensions、skills、prompts、runtime contracts 和真实入口工具。完整产品说明见仓库根 [README](../README.md)，Agent 关系与流程见 [Agent 专项架构](../wiki/02-agent-architecture.md)。

## 运行基线

- Node `>=22.19.0`，仓库 `.nvmrc` 为 `22.23.1`。
- Pi `0.84.1`。
- `pi-subagents@0.46.0`。
- `@quintinshaw/pi-dynamic-workflows@3.5.1`。
- `@larksuiteoapi/node-sdk@1.73.0` 为可选飞书 SDK 入口依赖。

```bash
npm ci
npm test
```

`.pi/settings.json` 位于仓库根，其 package path 相对 `.pi/` 解析，因此必须使用 `../meeting-agent-pi-package`。

## 目录职责

| 目录 | 职责 |
| --- | --- |
| `extensions/` | 注册 Planner、Policy、ASR、Agentic、文档、飞书和可观测工具 |
| `skills/` | 能力触发与操作协议 |
| `prompts/` | 会议纪要、PRD、架构、运营、Checklist 和 revision overlay |
| `runtime/` | capability registry、execution profile、provider、model route、schema、package audit |
| `tools/` | 飞书 handler/runner、ASR clients、Meeting Intelligence、Pi delegation、Docker/store helper |
| `tests/` | Node test 与 Agentic typecheck |

## Agent 运行

父 Agent 先使用 Meeting Intelligence 理解参会人、议题、决定、行动项、风险、开放问题和证据，再选择：

- `direct`：父 Agent 直接处理简单会议。
- `single_subagent`：一个 fresh、只读 specialist 核验单一轴。
- `dynamic_workflow`：多个 specialist 并行核验，执行 completeness/verify/synthesis。

自动入口通过受限非交互 Pi 会话真实调用 `subagent` 或 `workflow`，工具 allowlist 为 `read,subagent,workflow`。只有匹配的 `tool_execution_end` 才算真实执行。父级 reconciliation 会校验所有返回 segment id；跨会议 id 或缺少 `evidenceSegmentIds` 的事实性 findings 被隔离并交给 QA 阻断。

会议短期上下文使用 Pi 原生 Compaction。完整音频会议通过 QA 后，runtime 再按需唤醒一个 fresh、只读的 `meeting-memory-curator`，由它提出长期记忆候选；父 Agent 根据 Meeting Intelligence `sourceClaimIds` 与当前 transcript `evidenceSegmentIds` 做二次校验、去重与冲突隔离，再写入项目级 `.pi/agent-memory/meeting-memory/`。该阶段失败不会阻塞会议文档交付，也不会调用 Dynamic Workflow。

第三方 package 已通过 package audit/install mechanism，记录在 `runtime/package-audits/`。Capability Registry 中的记录是 planner-selectable capability descriptions；Metrics 记录 `plannerDecisions`、`policyDecisions`、`workerDecisions`、`capabilitySelections` 和 `packageAudits`。

## ASR

`MEETING_ASR_PROVIDER=auto|aliyun_dashscope_paraformer|local_qwen3`。

### 云端文件

- OSS + DashScope HTTP asynchronous transcription。
- 默认文件模型 `fun-asr`，robust review 模型 `paraformer-v2`。
- 支持 `.aac/.amr/.avi/.flac/.flv/.m4a/.mkv/.mov/.mp3/.mp4/.mpeg/.ogg/.opus/.wav/.webm/.wma/.wmv`。
- diarization 默认 auto，可传 2–100 人 hint；需要 mono 时生成派生输入，原媒体不变。
- robust 模式记录 omission、text conflict、speaker attribution conflict 与 overlap risk，不静默改写主 transcript。

### 云端实时流

- 使用独立 WebSocket endpoint 和 `paraformer-realtime-v2`。
- 支持 `pcm/wav/mp3/opus/speex/aac/amr`。
- 当前实时端不声明 speaker diarization。

### 本地 fallback

本地 Qwen3-ASR 只接收归一化 WAV path，不定义产品上传格式。服务管理：

```bash
python3 tools/local_asr_service_ctl.py status
python3 tools/local_asr_service_ctl.py start
python3 tools/local_asr_service_ctl.py stop
```

单路混音 diarization 是 speaker turn 聚类，不是声源分离；高重叠同时发言不能保证完整恢复。所有 provider 必须写真实 `rawMediaExternalUpload`、status、model、speaker/quality 和 failure artifact。

## Meeting Intelligence 产物

音频任务在 `artifacts/meeting-intelligence/` 生成：

- `meeting-analysis.json`
- `meeting-profile.json`
- `participant-map.json`
- `topic-map.json`
- `evidence-map.json`
- `agent-plan.json`
- `agentic-orchestration.json`
- `agentic-orchestration-result.json`
- `agentic-orchestration-events.ndjson`

记忆增强在 `artifacts/meeting-memory/` 生成 `curation-plan.json`、`curation-result.json` 与真实工具事件 `curation-events.ndjson`。长期视图为 `.pi/agent-memory/meeting-memory/MEMORY.md`，append-only 审计记录为 `ledger.jsonl`，同 key 冲突写入 `conflicts.jsonl` 待审；整个目录不进入 Git。

默认参会人是 `参会人 A/B/...`。用户可在指令中提供 `参会人 A=张三`；没有姓名不阻塞处理。

## 文档运行

文档正式路径：

```text
document-router
  -> document-prompt-registry.json
  -> document_prompt_render_batch
  -> document_workers_plan
  -> document_workers_run
  -> ordered merge / bounded repair
  -> qa_gate_evaluate
  -> policy_gate_check
```

Prompt Registry 拥有文档结构；worker runtime 不硬编码 PRD 或架构模板。Model Provider 使用 `model-route.json` 记录 route、attempts 与显式 fallback，不保存 key 或 raw request body。

## 飞书入口

先启动 handler（默认 dry run）：

```bash
node tools/feishu_agent_task_handler.mjs \
  --host 127.0.0.1 --port 8788 \
  --publish-mode dry-run --reply-mode dry-run
```

再消费事件：

```bash
node tools/feishu_event_runner.mjs \
  --event-key "$FEISHU_EVENT_KEY" \
  --handler-url http://127.0.0.1:8788/feishu/events
```

长任务设置 `FEISHU_AGENT_ASYNC=1`。SDK long-connection gateway 是可选入口，也转发到同一 handler。MCP 可用于额外 AI tool access，但不是收消息、回复或发布的必要条件。

Handler 写入 `runtime-runs/feishu-agent/runs/{runId}/`，并分别记录 event、task/state、source context、ASR、Meeting Intelligence、model/document、QA/Policy、publish/reply、metrics/manifest。

飞书认证信息只通过 `auth-status-summary` 返回安全摘要，可能含凭证的 CLI 输出使用 `secret-scan`。“目前暂不支持该功能”只用于能力确实不存在，不用于隐藏权限、ASR 或模型故障。

## Local Docker

运行边界是 **Host 原生控制面 + Local Docker 受限执行面**。本地 Docker 不能减少本机总计算消耗。

- `fast_answer/file_summary 不进 Docker`。
- `document_generation/multi_source_synthesis 默认进 Docker worker`，但仅在 `FEISHU_AGENT_DOCUMENT_WORKER_MODE=docker|local-docker|queue` 时入队。
- `raw audio 不进容器`；Docker worker 可读取任务所需 transcript/evidence/context pack。
- Worker 不接收飞书凭证，不调用 `lark-cli`，不 publish，不 reply，不直接写 SQLite。
- 默认 `4 CPU / 8GB / 长文档并发 2`。

```bash
docker compose -f docker-compose.local-runtime.yml up -d runtime-queue pi-document-worker
```

## 内容、凭证与动作

会议内容可以被当前任务选择的 ASR、模型、Agent、文档、QA 和记忆整理能力使用。上下文 bounding 是性能机制，不是内容隐私 gate。

API Key、Token、Cookie、Authorization、App Secret、OSS 签名和登录 session 不得进入 prompt、普通 artifact、metrics 或记忆。删除、通知、日历/任务变更、客户可见发布、权限扩大和 `install_dependency` 由 Policy Gate 判断。

## 验证

```bash
npm test
python3 tools/local_ci_check.py
npm audit --omit=dev
```

Workspace 级验证在仓库根运行 `python3 src/validate_workspace.py`。
