> 历史快照：本文记录当时的问题与修复，不代表当前架构。当前状态见本目录 `README.md`。

# Feishu 音频会议纪要 ASR 后 pipeline 卡住

日期：2026-05-20
状态：fix-in-progress
相关模块：feishu-agent-bridge / local-asr / meeting-minutes / runtime-observability / tool

## 摘要

真实飞书测试中，用户回复 `.wav` 录音消息并要求“形成会议纪要”后，机器人先回复“已接受任务，正在处理。”，但长时间没有最终结果。排查确认这次不是附件读取失败：父消息附件已成功解析、音频已下载、本地 ASR 已完成。当前阻塞点在 ASR 完成之后的会议纪要生成、QA、发布和最终回复闭环。

## 触发场景

- 用户任务：在飞书中回复录音文件消息，输入“形成会议纪要”。
- 文件类型：`.wav` 音频文件，约 65.6 MB。
- 运行链路：Feishu event gateway -> task handler -> parent/root attachment resolution -> local download -> file-context -> local ASR -> PI meeting-minutes pipeline。
- 相关 run：
  - `runtime-runs/feishu-agent/runs/feishu_2026-05-20T07-41-39-796Z_om_x100b6fe215d07c88b4c00a85ab3591e`

## 影响范围

- 飞书用户侧会长期停留在“处理中”，无法判断任务是在下载、转写、生成纪要、QA、发布，还是已经失败。
- ASR 已完成但未生成最终纪要，会造成用户重复提交同一音频任务，浪费本地 ASR 和模型资源。
- Hermes 和后续问题复盘只能看到前半段 artifact，缺少 ASR 后生成链路的明确失败状态。
- 当前架构把 ASR 后的 Agent 生成视作一个黑盒长任务，缺少阶段级 timeout、heartbeat 和 partial output。

## 证据

以下证据均来自本地 run artifact 和日志，不包含 raw audio、raw transcript、secret、Authorization 或 CLI session。

- 最新飞书事件已进入 gateway：
  - `eventType=im.message.receive_v1`
  - `msgType=text`
  - `hasRootId=true`
  - `hasParentId=true`
  - 当前消息本身 `attachmentCount=0`，需要通过父消息/root 消息回溯附件。
- `state.json` 显示附件和任务创建均完成，但状态仍停留在 `accepted`：
  - `event_normalized=completed`
  - `attachment_cache_checked=completed`
  - `attachments_resolved=completed`
  - `file_context_built=completed`
  - `task_created=completed`
  - 未出现 `pi_agent_pipeline`、`feishu_publish`、`feishu_reply` 等后续步骤。
- `task.json` 显示附件解析成功：
  - `taskType=meeting_minutes`
  - `requiresLocalAsr=true`
  - `responseMode=document_pipeline`
  - `attachmentResolution.status=resolved`
  - `attachmentResolution.reason=parent_message_resource`
  - `resourceType=audio`
  - `downloadStatus=downloaded`
  - `rawMediaExternalUpload=false`
- `file-context.json` 显示音频上下文正确：
  - `fileType=audio`
  - `extension=.wav`
  - `contextMode=local_asr_only`
  - `externalLlmAllowed=false`
  - `status=ready`
- ASR artifact 已生成：
  - `artifacts/transcripts/record-20260520-123832-39.chunks.json`
  - `partial=false`
  - `failedChunks=[]`
  - `transcriptSegments=46`
  - `model=mlx-community/Qwen3-ASR-1.7B-4bit`
  - `endpoint=local-mlx-metal`
  - `durationSec=2149.568`
- 外层 `run.metrics.json` 仍显示：
  - `status=running`
  - `modelCalls=[]`
  - `policyDecisions=[]`
  - `qaGate.status=not_run`
  - `generatedArtifacts` 只到 `event`、`attachments`、`file-context`、`task`
- 嵌套 PI run 只写入：
  - `planner-envelope.json`
  - `run.metrics.json`
  - 未看到 `agent-output.json`、`publish.json`、`reply.json`。

## 根因判断

当前判断：附件解析和本地 ASR 链路已经可用，阻塞发生在 ASR 后的会议纪要生成与最终状态回写阶段。

更具体地看，当前 handler 的 `runPiAgent()` 将 ASR 后的会议纪要生成、QA、Policy、发布和回复交给一个长时间运行的 PI 子进程。该子进程结束前，handler 不会写出 `agent-output.json`、`stdout/stderr` 摘要、最终 publish/reply artifact，也不会给飞书发送阶段性进度。只要 PI 子进程卡在纪要生成、模型调用、QA 或内部工具链任一步，用户层都会表现为长期“正在处理”。

最新修复方向不是新增 `office_task_pipeline` 编排层，而是新增薄的 `task_execution_runner`：它只负责执行阶段、写观测和进度回复，并通过 `runtime_tool_cli` 调用既有 Planner、Model Router、Prompt Registry、Document Worker、QA Gate 和 Policy Gate。会议纪要模型选择固定经由 Model Router 的 `meeting_minutes` 路由，默认 `deepseek/deepseek-v4-pro`；普通短任务仍默认 `deepseek/deepseek-v4-flash`。

需要继续确认的点：

- PI 子进程是否仍在运行，还是已异常退出但未被 handler 捕获。
- ASR transcript 是否被正确注入 meeting-minutes prompt，而不是只生成了 planner envelope。
- PI 子进程是否卡在模型 provider、prompt registry、document worker、QA gate 或 publish policy。
- `runPiAgent()` 是否应该在子进程运行期间流式记录 stdout/stderr tail 和阶段 heartbeat，而不是等子进程结束后才写入。
- 早前日志出现过一次 `EADDRINUSE 127.0.0.1:8788`，虽然不是本 run 的直接证据，但说明 handler/gateway 重启时存在重复进程或端口占用风险。

## 修复方案

### P0：让用户侧和 artifact 可见真实阶段

- 在 ASR 完成后立即更新 `state.json`，新增 `local_asr_completed` step，并回复飞书：“录音已转写完成，正在生成会议纪要。”
- `runPiAgent()` 运行期间持续写 `pi-status.json` 或 `agent-output.partial.json`，至少包含：
  - 当前阶段
  - 最近更新时间
  - 已生成 artifact
  - 最近错误摘要
  - 是否仍在等待模型或工具
- 给 ASR 后的每个阶段增加独立 timeout：
  - `meeting_minutes_generation`
  - `qa_gate`
  - `policy_gate`
  - `publish`
  - `reply`
- 超时后必须写入明确 `blocked` 或 `needs_fix`，并回复用户“转写已完成，但纪要生成超时/失败，可重试”。

### P1：拆开确定性执行阶段和 Agent 黑盒长任务

- handler 可以直接识别 ASR transcript artifact，构造 meeting-minutes 输入，不应把“转写完成后如何继续”完全藏在 `pi -p @agent-task.md` 的黑盒内。
- 将音频会议纪要链路拆成显式执行阶段，但不把这些阶段变成第二套编排决策：
  - attachment resolution
  - local ASR
  - Planner Envelope
  - Model Router
  - Prompt Registry
  - Document Worker section batches
  - QA gate
  - policy gate
  - publish/reply
- 每个阶段都写 metrics 和 manifest，Hermes 可以独立读取阶段结果。任务拆分、模型选择和文档结构仍由 Planner/Router/Registry/Worker 负责。

### P1：复用 ASR 缓存，避免重复重跑

- 以音频 `sha256` 作为 ASR cache key。
- 如果同一音频已经有 `partial=false` 且 `failedChunks=[]` 的 transcript artifact，重试时直接复用转写结果。
- 飞书重试同一任务时，不应再次消耗本地 ASR 时间。

### P2：优化进度 UX

- 飞书回复从单一“已接受任务，正在处理。”升级为阶段型：
  - “已收到音频，正在转写。”
  - “转写完成，正在生成会议纪要。”
  - “纪要生成完成，正在检查并发布。”
  - “已完成：链接/摘要。”
- 长任务不需要暴露 `runId`，但内部 runId 应继续写入 artifact 方便排查。

## 验证计划

- Fixture 回归：
  - 回复 `.wav` 父消息“形成会议纪要”后，状态必须依次出现 `attachments_resolved`、`local_asr_completed`、`meeting_minutes_generated`、`qa_gate_completed`、`feishu_reply`。
  - ASR 已完成但纪要生成模拟超时时，必须写 `blocked/needs_fix` 并发送用户可读失败回复。
  - 同一音频二次提交应命中 ASR cache，不重新转写。
- Live 回归：
  - 飞书上传 `.wav` 并回复“形成会议纪要”，用户侧至少收到 ASR 完成后的阶段性消息。
  - 最终生成会议纪要并自动发布到当前会话目录。
  - 若模型 provider 或 PI 子进程失败，飞书回复明确失败状态，不长期 pending。
- 安全回归：
  - `run.metrics.json`、`state.json`、`sanitized-trajectory.json` 不包含 raw audio、完整 raw transcript、secret、Authorization、CLI session。
  - raw audio 只保留在本地 run artifact，`rawMediaExternalUpload=false`。

## 后续事项

- owner：runtime / feishu-agent-bridge
- blocked by：需要完成 `task_execution_runner` 静态校验、mock runner 回归和一次 live Feishu 音频 smoke。
- follow-up：
  - 为长任务增加阶段 heartbeat。
  - 将 ASR transcript -> meeting-minutes generation 从单体 `runPiAgent()` 中拆出可观测阶段。
  - 为 ASR transcript 建立 hash cache。
  - 将该问题加入 `wiki/07-test-plan.md` 的 Feishu 音频会议纪要 live 回归项。
