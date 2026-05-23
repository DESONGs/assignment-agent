# Document Worker 流式观测与 10 分钟超时诊断

日期：2026-05-22
状态：fixed-observability / fixed-deadline-budget / fixed-replay-env-parity / fixed-checkpoint-retry
相关模块：model-provider / document-worker-runtime / task-execution-runner / runtime-store

## 背景

原始失败 run：

`runtime-runs/feishu-agent/runs/feishu_2026-05-21T18-40-57-263Z_om_x100b6fc1554954a0b3c72845f8bda89`

用户侧现象是文档生成等待约 10 分钟后失败，最终回复为“上下文已准备完成，但文档生成失败，可重试。”原始 `agent-output.json` 只留下 `document_workers_run`、`exitCode=128`、`timedOut=true`、`stdoutTail=""`。当时无法查看 LLM 流式内容，因为 provider 调用不是 streaming，runtime tool 也只在工具完整返回后才写结果文件。

## 已实施修复

本轮按“同一套本地数据管理架构”接入，不新增独立日志系统：

- `model-provider.ts` 支持 OpenAI-compatible streaming：写 `stream_started`、`delta`、`stream_parse_error`、`stream_completed`，同时生成 `.summary.json`。
- 早期 blocked 也写 trace：包括 provider 未配置、模型不允许、prompt 安全阻断、空响应等，避免只有外层 attempt 外壳。
- `document-worker-runtime.ts` 为每个 document task、section batch、candidate provider 写 `attempts.ndjson`，并把 stream trace path 写回 `sectionAttempts`。
- 已完成的 section batch 会写 partial Markdown 和 summary，避免外层 timeout 时丢失已完成批次。
- `task_execution_runner.mjs` 和 `feishu_agent_task_handler.mjs` 默认启用 `captureModelStream`，但 `modelTimeoutMs` 只在显式配置时传入，保持原有 provider 单次默认 120 秒语义。
- `runtime_store_cli.py` 新增 `model_stream_trace` artifact kind，30 天 TTL，privacy class 为 `derived_content`，进入 CAS/retention 管理。

2026-05-22 追加完成 deadline-aware fix，避免再次只靠外层 600 秒 kill：

- `runtime_tool_cli.mjs` 默认安全加载 workspace `.env.local` 中的 provider/model allowlist env，支持 `FEISHU_AGENT_LOAD_LOCAL_ENV=0`、`FEISHU_AGENT_RUNTIME_ENV_FILE` 和 `--env-file`；只暴露 loaded/missing key names，不输出 secret value。
- `document_workers_run` 新增 `deadlineAt`、`runtimeBudgetMs`、`deadlineReserveMs`。worker 在 wave、batch、candidate、repair 前检查剩余预算，预算不足时主动返回 `document_worker_deadline_exhausted`，并带 `attemptsPath`、`traceRoot`、`completedSections`、`missingSections`。
- `task_execution_runner.mjs` 对 document worker 使用 `FEISHU_AGENT_DOCUMENT_WORKER_TIMEOUT_MS`，默认 30 分钟；外层 runtime tool timeout 为 worker budget 加 30 秒 kill margin，普通 runtime tool 仍保持 600 秒。
- provider trace 增加 `request_started`、`response_headers_received` 和 timeout `stream_blocked` summary，记录 `timeoutMs`、`durationMs`、`firstByteAt`、`chunkCount`。
- fallback 不再无脑串行耗尽预算。主 provider timeout 或剩余预算不足时跳过后续 candidate，并记录 `fallbackSkippedReason=deadline_budget_insufficient_or_primary_timeout`。
- 如果 document worker 子进程仍被 kill，runner 会扫描 `attempts.ndjson`、stream summaries 和 partials，返回 `document_worker_timeout_diagnostic`，不再只有 opaque `runtime_tool_failed`。

2026-05-22 追加完成 checkpoint retry fix，避免“单次失败即结束”：

- `document_workers_run` 默认使用 `workflowStrategy=checkpointed`，在 `artifacts/document-workflow/` 写入 `checkpoint.json`、`retry-ledger.ndjson`、blueprint、section、assembly 和 review 私有 artifacts。
- 每个 section batch、full document、repair 都是可恢复 unit；重跑同一 run 时默认 `resumeFromCheckpoint=true`，已完成 unit 不重复生成，只继续 pending/failed unit。
- 默认 retry policy 为 `maxAttemptsPerUnit=3`、`maxRetryUnits=12`；provider timeout、HTTP 5xx、空响应、deadline 到达等按 checkpoint 继续，provider 配置缺失、prompt registry/render 失败、policy blocked 等不做盲目重试。
- `task_execution_runner.mjs` 在长文档稳定模式下使用 `FEISHU_AGENT_LONG_DOCUMENT_JOB_TIMEOUT_MS` 默认 2 小时，stable 模式把 `sectionsPerBatch` 降到 2，降低单次 section 失败的回滚范围。
- 部分文档或部分章节完成时不会发布 partial；只有全部 requested docs 完成且 QA/Policy 通过才发布飞书结果。
- 如果最终无法交付，`agent-output.json.details.finalFailureReport` 会记录 `terminalReason`、`completedDocs`、`pendingDocs`、`failedStage`、`retryCount`、`lastProviderAttempt` 和 `nextAction`，飞书最终回复会说明失败原因和下一步，而不是只输出“可重试”。

关键代码位置：

- `meeting-agent-pi-package/extensions/model-provider.ts`
- `meeting-agent-pi-package/extensions/document-worker-runtime.ts`
- `meeting-agent-pi-package/tools/task_execution_runner.mjs`
- `meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs`
- `meeting-agent-pi-package/tools/runtime_store_cli.py`

## 原始失败证据

原始 run 时间线：

- `review_context_built`：2026-05-21T18:41:00.781Z，读取到 6 条评论。
- `model_route_planned`：2026-05-21T18:41:02.174Z，主路由 DeepSeek `deepseek-v4-pro`。
- `document_workers_planned`：2026-05-21T18:41:03.129Z，2 个文档任务。
- `documents_generated`：2026-05-21T18:51:03.172Z blocked。

这正好跨越约 600 秒，对应外层 runtime tool timeout。

原始 `document_workers_run` 参数：

- `maxWorkers=2`
- `sectionBatching=true`
- `sectionsPerBatch=3`
- `maxRepairAttempts=1`
- `reasoningDepth=deep`
- requested documents：`prd`、`customer-requirement-checklist`

实际 plan：

- `prd`：3 个 section batch，共 9 个章节。
- `customer-requirement-checklist`：4 个 section batch，共 10 个章节。
- checklist 依赖 PRD，因此分成两个 execution waves，先 PRD 后 checklist。
- 每个 batch 有 2 个 candidate：DeepSeek 主路由 + Xiaomi fallback。

因此原始最可能路径是：PRD wave 内多个 batch 的 DeepSeek 请求卡到单次 provider timeout 后，再串行尝试 Xiaomi fallback；多 batch 累积接近 600 秒后被外层 `document_workers_run` 直接 SIGTERM。由于当时没有 per-attempt artifact 和 stream trace，无法恢复卡在第几个 batch 或哪个 provider。

## 诊断重跑结果

最终诊断 run：

`runtime-runs/diagnostics/runs/diagnostic_2026-05-22_document_workers_stream_rerun_final`

执行方式：

- 复用原始 `document_workers_run` 参数。
- 只改 `runId`、`outputRoot`，启用 `captureModelStream=true`。
- 直接调用 `runtime_tool_cli document_workers_run`。
- 不进入 Feishu handler，不 publish，不 reply。

诊断结果：

- `document_workers_run` status：`blocked`
- `attempts.ndjson` 已生成。
- 每个 section batch / provider 都生成了 `.ndjson` 和 `.summary.json`。
- runtime store 已索引 36 个 artifacts，总计约 332 KB，其中 stream trace 被识别为 `model_stream_trace` 并进入 CAS。

本次没有拿到真实 token delta，原因是侧线程诊断进程没有 live handler 的 provider 环境变量：

- DeepSeek 缺少 `DEEPSEEK_API_KEY`
- Xiaomi 缺少 `XIAOMI_TOKEN_PLAN_SGP_API_KEY`、`XIAOMI_BASE_URL`

这说明 streaming 记录链路已经落盘，但本次回放没有进入 provider HTTP 请求阶段。它不能证明原始慢请求的 provider 内部行为，只能证明现在即使 provider preflight 失败，也能留下可追踪的 batch/provider 级记录。

## 新发现的问题

诊断/回放环境与 live handler 环境不一致。原始 live run 能完成 model route 并进入长时间文档 worker，而侧线程直接回放缺少模型 provider 环境，导致 fast blocked。

这会影响后续问题定位：如果 replay 工具不加载与 live handler 相同的 env/keychain/启动脚本，就无法复现 provider 真实延迟，也无法捕获真实 stream delta。

## Live retry 补充根因：上下文管理与编排缺陷

后续 live retry 证明，deadline-aware、stream trace、checkpoint retry 只是解决了“超时后看得见、能恢复、能向用户解释”的问题，并没有解决“为什么任务会持续接近或触发 provider timeout”。更深层的核心问题是：当前 document worker 的 section batching 只切分了输出，没有切分输入上下文；`document_revision` 仍被当作全量多文档重生成；retry 也没有根据失败形态自适应缩小上下文或续写 partial。

参考 live retry run：

`runtime-runs/feishu-agent/runs/feishu_2026-05-21T18-40-57-263Z_om_x100b6fc1554954a0b3c72845f8bda89_retry_liveqa_2026-05-22`

关键证据：

- PRD rendered prompt 约 `53,766` chars。
- `customer-requirement-checklist` rendered prompt 约 `53,998` chars。
- PRD 被拆成 5 个 section batch，checklist 被拆成 5 个 section batch，后续还有 repair unit。
- 每个 section batch 都重新携带完整 `renderedPrompt`。实现位置：`meeting-agent-pi-package/extensions/document-worker-runtime.ts` 的 `buildSectionPrompt()`，其中仍要求根据“完整 renderedPrompt”写作。
- 本次 live artifacts 中记录到 23 次 provider completed attempt，其中 10 次是 `model_provider_request_timeout`，大量成功 attempt 也接近 `106s-119s`。
- 多个成功 attempt 的 `finishReason` 是 `length`，但 worker 仍按 completed 处理，后续再由 missing section/repair 才暴露截断或缺失。
- timeout 前 provider 已经产生大量 stream chunk，例如 checklist batch-2 timeout 前已有 2000+ chunks，repair timeout 前也已有 2000+ chunks，但 timeout catch 只返回 blocked，没有把已流出的 partial 内容纳入 checkpoint continuation。

具体架构问题：

1. **输出分片不等于上下文分片**

   `task_execution_runner.mjs` 会根据质量模式把文档拆成 `sectionsPerBatch=2/3`，但传给 worker 的每个 batch 仍包含完整 `renderedPrompt`。这让 2 个章节的小任务反复消化 5 万字符级全量上下文，成本随 batch 数和 retry 数线性放大。

2. **`document_revision` 与 `document_generation` 路径混用**

   本任务语义是“根据飞书批注优化已有文档”，但实际 profile 仍进入完整链路：

   `file_context -> review_context -> evidence_pack -> planner_envelope -> prompt_registry -> document_workers -> qa_gate -> policy_gate -> publish -> reply`

   这对从零生成 PRD/checklist 合理，但对批注修订过重。修订任务应该优先走 patch workflow：批注解析、批注到章节映射、变更计划、受影响章节重写、merge、QA，而不是默认全量重写两个文档。

3. **Prompt 包装层重复且边界不清**

   `document_prompt_render_batch` 已把 `routerConclusion`、`evidenceSummary`、`reviewContext`、`sourceInput` 组装进 `renderedPrompt`；`document-worker-runtime` 又在每个 batch 外再包一层目标章节、已完成章节、缺失章节和完整 renderedPrompt。结果是同一批全局规则、证据和 source input 被重复送入 provider，同时内层“只输出目标章节”和外层完整文档 prompt 的意图容易互相干扰。

4. **依赖注入进一步放大上下文**

   checklist 依赖 PRD 和 `tech-architecture`。当前 worker 会把已完成上游文档注入下游 prompt；但本次只请求 PRD + checklist，缺失的 `tech-architecture` 又成为 checklist 的待确认/缺失压力。对于 revision 任务，下游不应吞入整份上游文档，而应只接收结构化事实、差异摘要和待确认项。

5. **Retry 只是重复失败路径**

   checkpoint retry 当前能跳过已完成 unit，但失败 unit 重试时基本仍使用同一 prompt、同一 provider、同一 timeout、同一 max token 策略。checklist batch-2 连续 3 次 timeout 就是典型例子。有效 retry 应该根据失败原因调整执行形态：timeout 后降为单章节、更小 context、continuation；`finishReason=length` 后进入续写；fallback 不可用时提前剔除候选 provider。

6. **Partial stream 没有进入恢复链路**

   streaming trace 已经能看到 timeout 前模型正在输出，但 `model-provider.ts` 的 timeout catch 仍只返回 blocked summary。这样会丢失已经生成的 partial 内容，下一次 retry 只能从头再生成。正确做法是把 timeout 前已收集的 content 保存为 partial checkpoint，并让下一次以 continuation/repair 继续。

7. **`finishReason=length` 被误判为完成**

   对长文档生成来说，`finishReason=length` 往往意味着输出被 max token 截断。当前 provider 返回 completed，worker 随后把 batch 标记 completed。这会造成“看似完成、实际截断”的伪完成，最终在 missing section 或 QA 阶段才暴露。应把 `length` 作为 continuation_required 或 needs_fix 信号。

8. **run state 与 checkpoint 的版本一致性不足**

   live retry 中 checkpoint 继续推进后，`agent-output.json`、`publish.json`、`reply.json` 仍可能保留早先 blocked 快照。后续需要为 checkpoint generation、agent-output、publish/reply 绑定 attempt version，避免 resume 后多个状态文件表达不同时间点的结论。

因此，当前问题不能再归因于“简单串行”或“外层 timeout 太短”。更准确的表述是：

> timeout 是表层症状；核心缺陷是 document worker 缺少 context budget、revision patch plan、partial continuation 和 adaptive retry。当前 checkpoint/deadline/streaming 是必要基础设施，但它们只是让失败可见，不会自动让长文档任务变短、变稳或变高质量。

后续修复优先级：

- P0：为 `document_revision` 增加 patch-first workflow，只重写受批注影响的章节。
- P0：将 `renderedPrompt` 拆成 context pack：全局规则、文档 schema、source summary、review comments、section evidence 分开存储和按需注入。
- P0：section worker 只接收目标章节相关 context，不再接收完整 renderedPrompt。
- P0：timeout 时保留 stream partial，下一次以 continuation 继续。
- P1：`finishReason=length` 不再算 completed，必须触发 continuation 或 needs_fix。
- P1：retry policy 根据失败原因自适应调整：单章节、缩小 context、切换 provider、延长/缩短 max token，而不是重复同一调用。
- P1：provider fallback 在 run 前预检，不可用 provider 不进入热路径。
- P1：checkpoint、agent-output、publish/reply 增加 generation version，保证 resume 后状态一致。

## 同类风险审查

高风险：

- `document_workers_run`：原问题核心。修复后有 attempt trace、stream trace、partial artifact，但仍需要 provider env parity 才能做真实 replay。
- Local Docker document worker：如果复用同一套 runner，外层 600 秒 timeout 仍可能杀掉 worker。stream trace 会改善可观测性，但不能替代 worker heartbeat 和结果增量回收。

中风险：

- `model_generate_text` / fast answer：同样由 provider 支撑，但通常是单次短调用；风险低于文档 worker。
- `audio_normalize`：长 ffmpeg/afconvert 操作仍缺少细粒度进度 artifact。
- Feishu `lark-cli` 下载、发布、回复：主要依赖子进程 timeout 和 stdout/stderr tail，长时间卡住时可观测性有限。

相对较好：

- Local ASR：chunk 级产物会持续写入，失败后仍能看到已完成 chunk 与耗时。

## 结论

原始失败的深层工程原因不是单纯串行，而是缺少 deadline-aware runtime budget contract：文档 worker 内部存在 section batch、dependency wave、provider fallback 和 repair 的组合执行路径，但外层 runtime tool 只有 600 秒整体验收窗口；内层不知道 deadline，不能按剩余预算决定是否继续 batch/fallback，也不能在 kill 前主动收敛输出。旧实现同时不 streaming、不增量写 attempt/partial，所以外层 timeout 后无法恢复中间状态。

本轮修复后，后续长文档生成会把 batch/provider 尝试、stream delta、summary 和 partials 写入 run artifact，并纳入 runtime store/CAS 管理；worker 还会根据 `deadlineAt/runtimeBudgetMs/deadlineReserveMs` 主动停止或跳过不合适的 fallback。若再次出现长文档失败，应能直接定位到具体 batch、provider、首 token时间、chunk 数、输出字符数、timeout 原因和 fallback 是否因预算被跳过。

replay 环境一致性已补：诊断命令默认加载 `.env.local` 的 provider/model allowlist env，和 live handler 使用同一组本地 provider 配置；如需故意验证缺 env 场景，可设置 `FEISHU_AGENT_LOAD_LOCAL_ENV=0`。

## Runtime Context Plane 修复结论

本问题已抽象为通用 issue：`../issues/2026-05-22-runtime-context-plane-contract-gap.md`。根因不再表述为单纯“串行、超时、重试不足”，而是 runtime 缺少一等公民的 context management layer。

职责边界更新如下：

- `file-context` 只做 ingestion metadata 和 extraction。
- `context-offload` 只做 artifact storage/readback。
- `document-generation` 只做 prompt rendering。
- `source-context-runtime` 负责 source records、source segments、deterministic retrieval、context packs、work units、provenance 和 pre-generation gate。

已实施的架构方向：

- 新增 `source-context-runtime.ts`，产出 `source-records.json`、`source-segments.jsonl`、`retrieval-plan.json`、`context-packs/*.json`、`context-manifest.json`。
- runner 不再拼接大段 evidence text，只保留 pointer-only `evidence-pack.json` 兼容视图。
- document prompt renderer 携带 `contextEnvelopeRef/workUnits`。
- document worker 优先消费 bounded context pack，并在 trace/checkpoint 中记录 `contextPackId/sourceSegmentIds/promptBudgetChars/retrievalReasons`。
- `agent.md` 已增加开发约束：任何新功能只要引入文件类输入，必须先设计文件处理、分段、预算、隐私、缓存和失败 UX。
