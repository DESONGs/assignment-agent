# TypeScript、运行合同与 npm 包可靠性

更新时间：2026-08-18。

## 结论

本仓库存在过“TypeScript 只覆盖部分控制面、JavaScript 运行边界未进入静态检查、跨语言状态靠多份字符串维护”的同类风险，但范围小于另一个 Travel Agent 项目。本轮按现有 Pi 架构渐进收口，没有替换框架或重写产品能力。

当前覆盖事实：

- `extensions/` 的 20 个直接编写 TypeScript 文件全部进入 `strict`、`noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes` 检查。
- `src/` 的 8 个 TypeScript 文件包含公开合同、合同校验器与导出入口，由 `tsc` 生成 ESM、`.d.ts`、declaration map 和 source map。
- `tools/` 的 27 个直接编写 `.mjs`、`tests/` 的 11 个 `.mjs` 和 `scripts/` 的 7 个 `.mjs` 全部进入 strict `allowJs + checkJs`，并启用 `noUncheckedIndexedAccess` 与 `exactOptionalPropertyTypes`。
- `dist/` 是 TypeScript 构建产物；`node_modules/` 是依赖源码，两者不计为直接编写 JavaScript。
- 仓库不再手写 `.d.ts`/`.d.mts`；发布声明只从合同源码生成。
- 直接编写的 TypeScript/JavaScript 已移除显式 `any`、`Type.Any()`、`ts-ignore`，也没有通过缩小 include 绕过检查。动态输入从 `unknown` 进入 runtime parser 或 `asRecord/asArray` 后才使用。

## 单一合同来源

`src/contracts/` 的职责如下：

| 合同源 | 权威范围 |
| --- | --- |
| `task-contracts.ts` | Task、Execution Profile、Adaptive Execution Ledger、Todo 投影与运行状态 |
| `runtime-boundary-contracts.ts` | Provider、Model Route、ASR summary、飞书 event/task/run 与 runtime store |
| `qa-contracts.ts` | QA profile、必检项、评估结果、`evaluationId` 与 `inputHash` |
| `source-context-contracts.ts` | source record/segment、context pack、work unit、manifest 与 Gate |
| `document-runtime-contracts.ts` | document work item、worker result 与 checkpoint v2 |
| `office-artifact-contracts.ts` | retrieval index、document lifecycle 与 Office Object |

构建步骤从同一合同源生成 TypeScript 类型、runtime parser、Tool 输入 schema、JSON Schema 和 `runtime/contract-manifest.json`。旧 artifact 可以作为诊断材料读取，但不能据此恢复执行或发布。

同一 manifest 被以下消费者使用：

- Node/Pi runtime：运行时解析 Provider、ASR summary、飞书 event/task/run，不再只靠类型断言。
- Python runtime store：拒绝未知 schema/status，避免把错误或旧版本结果当成可复用 artifact。
- Swift AgentWorkbench：把未知 task/profile/run/step 状态显示为 contract warning，不静默归为正常状态。
- JSON schema / workspace validator：校验 Execution Profile、飞书状态和 Provider protocol 集合一致。

## P0 可靠性修复与业务结果

| 已修复问题 | 原业务故障 | 当前结果 |
| --- | --- | --- |
| 空 QA、缺 profile/必检项或未知结构可被当作通过 | 残缺转录、错误文档或 Source Pack 可能进入客户交付 | QA 一律 fail-closed；写入时重新校验 `schemaVersion/evaluationId/inputHash`，伪造 pass 无法落盘 |
| Source Context 信任调用方自报的 `manifest.gate` | 被篡改、跨来源或缺 provenance 的证据可能污染 PRD/纪要 | Gate 重新计算 source/work-unit/segment/artifact/provenance/hash；畸形输入返回字段路径和恢复动作 |
| Worker 把未知状态默认当作完成，`needs_fix` 可继续下传 | 上游失败仍生成下游文档，造成内容污染和错误发布 | 封闭状态联合与穷举聚合；硬依赖只接受 `completed` |
| checkpoint 只看路径/状态，不绑定输入与产物 hash | 长文档重试可能重复章节、复用旧上下文或遗漏最新修改 | checkpoint v2 绑定 input/context/artifact hash 与稳定 idempotency key；原子写入；同 run 单写者锁；v1/损坏/hash 漂移被隔离 |
| task-state/Todo/飞书/Workbench 投影失败被静默吞掉 | 后端已完成但用户看到卡住，或错误状态诱发重复执行 | Ledger 保持唯一真相源；投影失败产生 `projection_write_failed` 和恢复说明，产物保留，可从 Ledger 重建 |
| Runner、HTTP、ASR、模型和测试 fixture 依赖隐式动态结构 | 真实输入第一次出现时才崩溃，测试通过也无法阻止合同漂移 | 全部直接编写 MJS strict；入口任务先 runtime 校验，HTTP/模型/ASR 结果在访问前归一化 |
| Pi 记忆结果遍历把数组当普通对象丢弃 | Memory Curator 明明返回结构化候选，父 Agent 却记录为空 | extractor 显式遍历数组与嵌套 tool details，父级校验链恢复 |

## 技术问题对应的业务问题

| 技术问题 | 用户或业务表现 | 本轮控制 |
| --- | --- | --- |
| Task/Profile/状态自由字符串漂移 | 任务走错 Runner、Todo 一直显示进行中、重复回复或无法继续 | 权威常量、运行时 guard、schema/manifest 集合校验 |
| 飞书 step 的 `details.status` 覆盖正式 step status | 已完成任务在飞书或 Workbench 中显示未知/卡住，运营误判需要重跑 | 修正合并顺序，禁止详情覆盖 `name/status/at`，写入前校验 run state |
| 文档复审路径读取未定义的 `asr` 变量 | 客户文档评论/修订在已有正文读取后直接崩溃，无法交付 revision | 将复审上下文明确标记为未上传媒体，并纳入全量 `.mjs` checkJs |
| Provider registry 通过强制类型断言 | 配置看起来健康，第一次真实生成才失败，造成超时、漏交付或无效模型费用 | registry runtime parser 与 generation result guard |
| ASR `complete` 与 partial/failed chunk 可同时出现 | 残缺转录被生成纪要或 Source Pack，决定、行动项和客户需求可能错误 | complete 必须有 segment、无 failed chunk、非 partial |
| Model Route 成功/失败返回没有共同 reason 合同 | fallback 后 Agent 无法解释为何换模型，故障恢复与费用审计困难 | selected 明确 `reason=null`，blocked 保留可恢复原因 |
| checkpoint、wave 索引和可选参数靠隐含假设 | 长 PRD/架构文档中途卡住、章节重复生成或恢复错误 | checkpoint v2、hash/idempotency、原子写入、strict index/optional 检查与旧版本隔离 |
| Python/Swift 各自维护状态字符串 | 后端已失败但桌面端显示成功，或错误 store 结果被复用 | 共享语言中立 manifest 与真实 consumer smoke |
| 源码 checkout 通过但 npm tarball 不完整 | 开发机可运行，其他 Agent 安装后缺 `.d.ts`、exports 或运行文件 | `publint`、pack dry-run、临时 tgz 安装、NodeNext consumer 编译与 ESM import |

## 迁移顺序完成情况

1. 状态、合同与 Agent Runtime：已完成。Task/Ledger/Todo、Provider/ASR/飞书状态进入权威合同和运行时校验。
2. Provider、HTTP、飞书与持久化：已完成。真实 Provider、云端 ASR、飞书 handler/gateway、Python store 进入边界检查。
3. Workbench 与测试/发布：已完成。Swift 消费共享 manifest；全部直接编写 MJS tool/test/release script 进入 checkJs；npm tarball 使用真实 consumer 验证。

“迁移完成”表示所有直接编写 TS/JS 文件已进入 strict 静态检查和发布门，高风险跨模块结构拥有运行时合同；不表示所有 `.mjs` 都应改名为 `.ts`。后续新增动态输入必须延续 `unknown → parser/guard → 领域结构`，禁止只为提高语言百分比改后缀。

## 故障恢复语义

- QA、Source Context、Document Work Item 或 Office Artifact 合同非法：返回稳定 `reason`，可带 `fieldPath/recovery`，状态为 `blocked`。
- checkpoint v1、截断、hash 不匹配或 artifact 损坏：原文件改名隔离，不直接复用；有效章节可按 v2 规则重建。
- ASR partial、failed chunk、零 segment、章节失败或 provenance 缺失：Source Pack 与文档发布均阻断，不把部分结果包装成完成。
- task-state、Todo、飞书或 Workbench 投影失败：业务产物不删除，Ledger 记录失败事件；修复投影写入后从 Ledger 重建。
- 未知状态：不能归为成功；调用方必须显示阻断原因或 contract warning。

## 发布验证

```bash
cd meeting-agent-pi-package
npm test
npm run typecheck
npm run publint
npm run pack:dry-run
npm run release:local
```

`release:local` 不发布 registry；它在隔离临时目录安装实际 tgz，并执行 NodeNext strict consumer 编译和 ESM import。Pi、sub-agent 与 Dynamic Workflow 继续使用受控 peer range；TypeBox 因被公开 `.d.ts` 和 parser 直接引用，改为锁定的生产依赖，避免消费者必须额外猜测安装。此次没有升级关键依赖版本。

## 剩余风险

- strict 与 runtime parser 能阻止结构漂移，但不能证明 DashScope、飞书、OSS 和模型 Provider 在某一时刻在线；真实外部链路仍需独立 smoke。
- `npm registry` 尚未正式发布；本仓库验证的是 tarball 可发布性、隔离安装和消费者兼容性，不等于 registry 发布成功。
- 当前单写者锁是本地 workspace 文件锁，适用于现有 Host/本地 queue 架构；若未来把同一 `runId` 分发到多个机器或非共享文件系统，必须先升级为跨主机租约，不能直接复用本地锁语义。
