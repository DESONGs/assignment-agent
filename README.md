# Meeting Document Agent

一个本地优先的会议终结与办公文档 Agent。

它面向高频会议、客户沟通、技术方案讨论和运营复盘：把录音、飞书消息、飞书文档、本地文件和后续补充材料整理成可追溯的会议纪要，并继续生成 PRD、技术架构、运营方案、客户需求确认表、复盘文档等交付物。

当前仓库是一个脱敏后的源码发布版本：代码、prompt、schema、wiki 和复盘文档已保留；本地模型权重、运行产物、缓存、虚拟环境、真实配置和本地文件没有上传。

## 这个项目解决什么问题

会议结束后，信息通常散落在录音、聊天记录、飞书文件、个人记忆和后续补充里。这个 Agent 的目标不是只做摘要，而是把会议材料整理成下一步可以执行、可以复查、可以沉淀到知识库的办公资产。

典型输出包括：

- 会议纪要：主题、背景、结论、分歧、行动项、风险、开放问题。
- PRD：产品目标、用户、范围、功能需求、非功能需求、验收标准。
- 技术架构：系统边界、模块、数据流、模型路由、部署运维、测试计划。
- 运营方案：目标、对象、节奏、SOP、指标、风险预案、复盘机制。
- 客户需求确认表：下一次沟通中需要确认的问题和交付边界。
- 项目复盘：架构、运行、运维、开发问题、数据管理等阶段性总结。

## 当前能力

- Feishu 入口：通过官方 `lark-cli` 接收事件、下载附件、创建 Markdown 文档、发布到 Drive/Wiki、回复消息。
- 本地音频转写：使用本机 Qwen3-ASR HTTP 服务，原始音频不上传外部模型。
- 文档生成：通过 Prompt Registry 和 Document Worker 生成会议纪要、PRD、架构、运营、客户确认表。
- 文档修订：读取飞书文档正文和评论上下文，按批注或修改意见重新优化文档。
- 多源证据：把多个文件、音频、链接和评论上下文统一成可追溯 source context。
- QA / Policy：交付前检查事实、章节、隐私、权限和发布边界。
- Hermes 学习侧车：只读取脱敏 trajectory，输出 memory、prompt、skill、eval proposal，不直接改生产系统。
- 本地数据治理：runtime artifacts、CAS、SQLite metadata、ASR/file cache、retention sweeper。

## 仓库结构

```text
meeting-agent-pi-package/
  PI package：extensions、skills、prompts、runtime schemas、local tools。

hermes-learning-sidecar/
  只读学习侧车：读取 sanitized trajectory，生成复盘与改进 proposal。

assigment agent wiki/
  当前主 wiki：PRD、架构、权限、测试、问题记录、项目复盘。

wiki/
  额外同步的计划与问题文档。

src/
  workspace validation、shared schemas、sanitized trajectory 示例。

models/
  只包含模型安装说明；不包含模型权重。

qa-runs/
  只保留非生产说明 README 和 marker；不包含原始 QA 产物。
```

## 没有上传的内容

以下内容被 `.gitignore` 排除，不应提交到 GitHub：

- `.env.local`、本机加密配置、真实账号或模型配置。
- `models/` 下的本地模型权重。
- `runtime-runs/` 下的真实运行产物、附件、转写、发布结果。
- `qa-runs/` 下的原始 QA JSON、音频、转写、模型响应。
- `.venv*`、`.uv-cache`、`.hf-cache`、`.hf-home`、`node_modules`。
- Obsidian 本地状态、macOS `.DS_Store` 等机器状态文件。

## 快速开始

### 1. 安装 PI package

从仓库根目录运行：

```bash
pi install -l ./meeting-agent-pi-package
```

也可以不安装，直接用本地 package 测试：

```bash
pi -e ./meeting-agent-pi-package
```

### 2. 准备本地配置

复制模板：

```bash
cp .env.example .env.local
```

在 `.env.local` 中填入你自己的模型配置。不要提交 `.env.local`。

默认模型规划：

- 主控与文档生成：DeepSeek。
- 复核与 fallback：Xiaomi MiMo。
- 音频转写：本地 Qwen3-ASR 服务。

### 3. 运行 workspace 校验

```bash
python3 src/validate_workspace.py
```

这个检查会验证关键文档、schema、prompt、runtime contract 和安全边界是否一致。

## 本地 ASR 模型安装

仓库不包含 ASR 模型权重。默认本地模型目录是：

```text
models/Qwen3-ASR-1.7B-MLX-4bit
```

模型来源：

- 推荐 Apple Silicon / MLX 4-bit 模型：<https://huggingface.co/mlx-community/Qwen3-ASR-1.7B-4bit>
- 原始 Qwen 发布：<https://huggingface.co/Qwen/Qwen3-ASR-1.7B>

更完整的安装步骤见 [models/README.md](models/README.md)。

常用安装命令：

```bash
python3 -m venv .venv-qwen3-asr
.venv-qwen3-asr/bin/python -m ensurepip --upgrade
.venv-qwen3-asr/bin/python -m pip install -U pip
.venv-qwen3-asr/bin/python -m pip install mlx-qwen3-asr huggingface_hub

.venv-qwen3-asr/bin/huggingface-cli download \
  mlx-community/Qwen3-ASR-1.7B-4bit \
  --local-dir models/Qwen3-ASR-1.7B-MLX-4bit
```

启动本地 ASR HTTP 服务：

```bash
.venv-qwen3-asr/bin/python meeting-agent-pi-package/tools/local_asr_http_service.py \
  --host 127.0.0.1 \
  --port 8765 \
  --model-dir models/Qwen3-ASR-1.7B-MLX-4bit \
  --preload
```

检查服务状态：

```bash
python3 meeting-agent-pi-package/tools/local_asr_service_ctl.py status
```

音频边界：

- 产品输入可接受 WAV、MP3、M4A、AAC、FLAC、OGG。
- runtime 会先本地归一化为 `16k mono s16 WAV`。
- 原始音频不发送给 DeepSeek、Xiaomi、Hermes 或 Docker worker。
- ASR 服务不可用时任务会阻塞并提示启动本地服务，不会自动走外部 ASR。

## Feishu 运行方式

Feishu 集成只使用官方 `lark-cli`。项目不保存飞书凭证，不维护自定义 Feishu adapter，也不把 CLI 登录态写入仓库。

典型本地 dry-run：

```bash
node meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs \
  --host 127.0.0.1 \
  --port 8788 \
  --publish-mode dry-run \
  --reply-mode dry-run
```

真实事件入口使用 `lark-cli event consume` 把事件转发给本地 handler。真实运行前需要：

- `lark-cli auth status --verify` 通过。
- 飞书应用已开启机器人能力。
- 已订阅 `im.message.receive_v1`。
- 具备消息回复、附件下载、Drive/Markdown/Wiki 所需权限。
- 真实应用凭据只通过本机环境变量或官方 CLI 登录态提供，不写入仓库。

如果需要 SDK 长连接入口，可以使用：

```bash
node meeting-agent-pi-package/tools/feishu_bot_event_gateway.mjs
```

SDK gateway 只是可选入口；收消息、处理任务和发布文档仍复用同一个 handler/runtime。

## Local Docker Runtime

Docker 在这个项目里不是远端算力服务，而是本地受限执行面。它用于隔离长文档生成和 Hermes proposal worker，避免拖垮 Feishu 主入口。

启动本地轻服务：

```bash
docker compose -f docker-compose.local-runtime.yml up -d runtime-queue pi-document-worker hermes-worker
```

边界：

- Host 负责 Feishu、`lark-cli`、macOS keychain、附件下载、发布、回复、本地 MLX ASR。
- Docker worker 只处理 bounded document job。
- Docker worker 不接收原始音频、飞书登录态、本地凭据。
- Docker worker 不发布、不回复，只写 runtime artifacts。

启用长文档入队时，设置 `FEISHU_AGENT_DOCUMENT_WORKER_MODE` 为 `docker`、`local-docker` 或 `queue`。

## 核心架构

当前实现不是固定会议流水线，而是 profile-based office agent runtime。

```text
User / Files / Feishu / Rokid Export / future IM adapter
  -> Channel/File adapters
  -> Shared Task Router
  -> Execution Profile
  -> Thin Execution Runner
  -> Planner / Model Router / Prompt Registry
  -> Document Worker / QA Gate / Policy Gate
  -> Publish / Reply
  -> Sanitized Trajectory
  -> Hermes proposal
```

只有六类组件拥有运行期业务决策权：

- Planner：任务拆分、能力组合、工具意图、worker 计划。
- Model Router：模型 route、provider 候选、fallback。
- Prompt Registry：docType 到正式 prompt 的选择和渲染。
- Document Worker：章节批次、合并、repair、文档级 QA input。
- QA Gate：内容是否可交付。
- Policy Gate：动作边界是否允许。

其他组件只做转换、执行、记录或复盘：adapter、handler、publisher、File Context、ASR、Observability、Hermes、`task_execution_runner`、`runtime_tool_cli` 都不是业务决策层。

## Execution Profiles

`task_router.mjs` 会把用户请求归入不同 profile：

| Profile | 用途 |
| --- | --- |
| `fast_answer` | 普通短问答，不进入文档 worker。 |
| `file_summary` | 文件摘要，只读 bounded preview 或 extracted slices。 |
| `audio_minutes` | 音频会议纪要，先本地 ASR，再生成纪要。 |
| `document_generation` | PRD、架构、运营、客户确认表等正式文档。 |
| `document_revision` | 根据正文和评论上下文修订已有文档。 |
| `multi_source_synthesis` | 多文件、多音频、多链接合成。 |
| `unsupported` | 图片、视频或未接入能力，返回明确 unsupported。 |

长任务会写入 `state.json`、`run.metrics.json`、`run-manifest.json`、`agent-output.json`、`publish.json`、`reply.json` 和 `sanitized-trajectory.json`，方便复盘和排错。

## 数据与隐私边界

默认策略：

- 原始音频、视频、base64 media 不外发。
- ASR 后的 transcript/evidence 文本可用于 DeepSeek/Xiaomi 语义生成和复核。
- 长 transcript/full evidence 不直接塞进主 prompt，先进入 Source Context / offload。
- retrieval 和 memory 只保存 pointer、hash、bounded preview、summary、sourceRun，不保存完整原文。
- Hermes 只读取 sanitized trajectory，不持有飞书、Rokid 或模型服务凭据。

本地数据治理方案见 [assigment agent wiki/14-local-data-storage-cache-backend.md](assigment%20agent%20wiki/14-local-data-storage-cache-backend.md)。

## Hermes Sidecar

Hermes 是只读学习侧车。它读取脱敏 trajectory，输出：

- retrospective
- memory proposals
- prompt/skill patch proposals
- eval cases
- Hermes wiki candidate

运行示例：

```bash
python3 hermes-learning-sidecar/sidecar.py \
  --trajectory src/examples/sanitized-trajectory.example.json \
  --out /tmp/meeting-agent-sidecar-output
```

或者读取一个真实 run 的脱敏产物：

```bash
python3 hermes-learning-sidecar/sidecar.py \
  --run-dir runtime-runs/feishu-agent/runs/<runId> \
  --out /tmp/meeting-agent-sidecar-output
```

Hermes 不直接修改生产 prompt、skill 或 runtime 配置。

## 文档入口

建议先读：

- [项目总计划](assigment%20agent%20wiki/00-plan.md)
- [PRD](assigment%20agent%20wiki/01-prd.md)
- [架构文档](assigment%20agent%20wiki/02-agent-architecture.md)
- [当前项目架构与代码同步状态](assigment%20agent%20wiki/11-current-project-architecture.md)
- [项目复盘索引](assigment%20agent%20wiki/retrospective/README.md)

开发问题记录在：

- [issues](assigment%20agent%20wiki/issues/README.md)
- [开发问题与修复专项复盘](assigment%20agent%20wiki/retrospective/04-development-issue-resolution-retrospective.md)

## 安全原则

- 不提交真实 `.env.local`。
- 不提交 Feishu App Secret、CLI session、cookie、模型 API key。
- 不提交本地模型权重、运行产物、原始音视频、完整转写或模型响应。
- 不把原始会议内容写入长期记忆。
- 不让 Hermes 持有高权限凭据或直接改生产系统。
- 依赖策略显式阻断已知高风险版本，例如 `mistralai==2.4.6`。

## 当前状态

这个仓库适合作为项目源码、架构文档和复盘资料的协作基线。真实运行仍需要在本机补齐：

- `.env.local` 模型配置。
- 本地 ASR 模型和服务。
- 官方 `lark-cli` 登录态。
- 飞书应用事件、附件、Drive、Markdown、Wiki 权限。
- 可选 Docker/Redis 本地 worker。
