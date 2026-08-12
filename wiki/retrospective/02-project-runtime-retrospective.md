> 历史快照：本文是阶段复盘，不代表当前架构。当前入口见 `README.md`。

# 项目运行复盘

更新时间：2026-05-22

## 复盘结论

项目运行链路已经从“接收飞书消息后启动一个长 PI 子进程”演进为可观测的 profile-driven runtime。关键收益是：短任务快速返回，长任务有阶段 marker，音频和文档任务能在 artifact 中定位卡点，Hermes 可以基于 `sanitized-trajectory.json` 做复盘。

当前运行复盘的核心原则是：

- 入口可以不同，运行契约必须统一。
- 短任务不进入长链路。
- 长任务必须有阶段状态、metrics、manifest、QA/Policy 结果和最终 reply/publish 结果。
- 失败必须落成明确状态，不能长期停在处理中。

## Feishu 入口链路

Feishu 是当前第一办公入口，主链路是：

```text
lark-cli event consume
  -> feishu_event_runner.mjs
  -> feishu_agent_task_handler.mjs
  -> task_router.mjs
  -> task_execution_runner.mjs
  -> runtime_tool_cli.mjs
  -> PI runtime extensions
  -> publish/reply
```

各层职责已经收敛：

- event runner：消费、标准化、去重、转发事件。
- handler：解析文本、附件、父消息、缓存、文件上下文，写 run artifact，负责发布和回复。
- task router：判断 task intent、executionProfile、requiredStages、skipStages。
- execution runner：按 profile 执行阶段、写 state/metrics/manifest、处理 timeout 和最终输出。
- runtime extensions：提供 Planner、Model Router、Prompt Registry、Document Worker、QA Gate、Policy Gate 等能力。

Feishu MCP 不是收消息、回复或发布的必需路径；正式动作优先使用官方 CLI 能力。

## Execution Profile 复盘

### fast_answer

适用于普通短问答或无需文档化的轻任务。

- 不进入 Document Worker。
- 不运行 QA Gate 和 Policy Gate。
- 不发布飞书文档。
- 不启动本地 ASR。
- 用户侧只看到直接回复。

这个 profile 避免了早期“所有事情都走文档 pipeline”的成本膨胀。

### file_summary

适用于 PDF、Word、Excel、Markdown、TXT、CSV 等文本型文件的一句话总结或分析。

- 使用 file-context 的 bounded preview 或 extracted slices。
- 不默认生成正式文档。
- 父消息/root 消息和最近附件缓存都可以补齐文件来源。
- 显式文件链接优先，不被旧缓存覆盖。

已修复的问题是：纯文本回复“总结文件内容”时，event 可能没有附件，必须回溯父消息或缓存。

### audio_minutes

适用于音频会议纪要。

标准阶段：

```text
attachments_resolved
audio_downloaded
audio_normalized
local_asr_started
local_asr_completed
model_route_planned
meeting_minutes_generated
qa_gate_completed
policy_gate_completed
publish/reply finalized
```

音频任务的关键复盘是：ASR 完成后不能再回到不可观测黑盒。早期 run 出现过 ASR 已完成但用户长期看不到最终结果的问题，后续通过 `task_execution_runner.mjs` 把 ASR 后的会议纪要、QA、Policy、发布和回复拆成可观测阶段。

### document_generation

适用于生成 PRD、技术架构、运营方案、客户需求清单和会议纪要等正式文档。

正式路径：

```text
source context
  -> evidence pack
  -> Planner Envelope
  -> Model Router
  -> Prompt Registry
  -> Document Worker dependency waves
  -> section batches
  -> merge / repair
  -> QA Gate
  -> Policy Gate
  -> publish/reply
```

Document Worker 复盘重点是：并行和分批只解决执行粒度，不自动解决上下文预算。Runtime Context Plane 落地后，worker 应消费 section-scoped context pack。

### document_revision

适用于“根据批注、评论、修改内容重新优化”等任务。

运行要求：

- 识别为文档生命周期修订任务，而不是 direct answer。
- 读取已有正文和评论上下文。
- 写入 `review-context.json`。
- 使用 base docType prompt + `document-revision-overlay.md`。
- 评论 API 不可用时记录明确状态，不声称已经处理独立评论线程。

此 profile 的长期方向是 patch-first workflow：优先重写受影响章节，而不是默认全量重生成多份文档。

### multi_source_synthesis

适用于多音频、多文件、文件链接和历史上下文合成。

运行重点：

- 每个 source 必须保留 sourceId 和 provenance。
- 显式 source 优先于 recent cache。
- 冲突按 source attribution 标注，并进入待确认。
- 不把一个 source 的评论或事实套到另一个 source。

## 模型路由与 provider 运行经验

Model Router 是唯一模型入口。普通短任务走 fast draft，会议纪要和复杂文档走 deep route，QA 可走规则检查和复核 provider。

运行经验：

- Provider fallback 可以自动发生，但必须写入 `model-route.json`。
- Provider 不可用是环境或账号问题，不应被包装成文档生成逻辑错误。
- 长文档任务需要 streaming trace、deadline budget、checkpoint retry，否则外层 timeout 后无法知道卡在哪个 batch。
- `finishReason=length` 不能简单当成完成，后续应触发 continuation 或 needs_fix。

## QA 与 Policy 运行经验

QA Gate 判断内容是否可交付，Policy Gate 判断动作边界。两者不能混用。

已确认规则：

- 会议和文档输出必须区分事实、合理推断和待确认问题。
- 缺章节、unsupported claims、跨 source 污染、遗漏主议题要进入 QA。
- 删除、清空、移除、销毁类动作始终 blocked。
- 用户在 Feishu 中明确要求创建、保存、发布或覆盖修改时，非删除类写入可以在 QA pass 后执行。
- 用户侧回复不得暴露内部 gate 术语、本地 run id 或 provider 栈信息。

## Artifact 与观测

非平凡 run 应稳定写入：

- `event.json`
- `task.json`
- `state.json`
- `run.metrics.json`
- `run-manifest.json`
- `agent-output.json`
- `publish.json`
- `reply.json`
- `sanitized-trajectory.json`

长文档还应写入：

- `model-route.json`
- `planner-envelope.json`
- `runtime-tool-results/`
- stream trace summary
- checkpoint artifacts
- final failure report

这些 artifact 的价值是把“用户说失败了”转成可定位的阶段、provider、source、QA、Policy 和发布状态。

## 已修复事项

- Feishu event 到本地 handler 的闭环补齐。
- 文件任务支持父消息/root 消息回溯和 recent cache。
- 音频格式从 WAV 限制扩展为常见格式本地 normalize。
- 音频 ASR 后阶段进入可观测 execution runner。
- Document Worker 增加 streaming trace、deadline budget、checkpoint retry。
- 显式文件链接不再被旧音频缓存覆盖。
- direct answer 不再被文档发布 policy 误阻塞。
- `sanitized-trajectory.json` 成为 Hermes sidecar 的真实 run 输入。

## 遗留风险

- 真实飞书 live 仍依赖本机 CLI 登录态、Drive/Wiki 权限和 provider 可用性。
- 文档修订仍需继续从全量重写走向 patch-first。
- 长任务恢复后，agent-output、publish、reply 的版本一致性仍需要持续回归。
- Runtime Context Plane 需要更多真实长文档和多源任务验证。

## 后续建议

- 把 audio、document generation、document revision 都纳入固定 fixture 回归。
- 对每类 profile 维护最小 artifact contract，缺失时让验证失败。
- 对 provider 不可用、权限缺失、ASR 服务未启动分别给出用户可理解状态。
- 避免新增“一次性脚本”绕过 runtime extensions；运行经验必须回流到正式工具链。
