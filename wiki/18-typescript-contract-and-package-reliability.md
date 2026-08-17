# TypeScript、运行合同与 npm 包可靠性

更新时间：2026-08-17。

## 结论

本仓库存在过“TypeScript 只覆盖部分控制面、JavaScript 运行边界未进入静态检查、跨语言状态靠多份字符串维护”的同类风险，但范围小于另一个 Travel Agent 项目。本轮按现有 Pi 架构渐进收口，没有替换框架或重写产品能力。

当前覆盖事实：

- `extensions/` 的 20 个直接编写 TypeScript 文件全部进入 `strict`、`noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes` 检查。
- `src/` 的 3 个公开合同 TypeScript 文件由 `tsc` 生成 ESM、`.d.ts`、declaration map 和 source map。
- `tools/` 的 27 个直接编写 `.mjs`、`tests/` 的 10 个 `.mjs` 和 `scripts/` 的 7 个 `.mjs` 全部进入 `allowJs + checkJs`。这些 JavaScript 仍是非 strict 迁移层，不冒充严格 TypeScript。
- `dist/` 中的 3 个 `.js` 是 TypeScript 构建产物；`node_modules/` 是依赖源码，两者不计为直接编写 JavaScript。
- 仓库不再手写 `.d.ts`/`.d.mts`；发布声明只从合同源码生成。
- 直接编写的 TypeScript Tool schema 已移除 `Type.Any()`，动态输入从 `Type.Unknown()` 进入显式归一化。局部文档/上下文算法仍有 `any` 逃生口，但不再承担 npm 公开合同或跨语言状态字面量的权威职责。

## 单一合同来源

`src/contracts/task-contracts.ts` 负责 Task、Execution Profile、Ledger/Todo 与运行状态；`src/contracts/runtime-boundary-contracts.ts` 负责 Provider、ASR summary、飞书 event/task/run 和 runtime store 边界。构建步骤从这两份 TypeScript 合同生成 `runtime/contract-manifest.json`。

同一 manifest 被以下消费者使用：

- Node/Pi runtime：运行时解析 Provider、ASR summary、飞书 event/task/run，不再只靠类型断言。
- Python runtime store：拒绝未知 schema/status，避免把错误或旧版本结果当成可复用 artifact。
- Swift AgentWorkbench：把未知 task/profile/run/step 状态显示为 contract warning，不静默归为正常状态。
- JSON schema / workspace validator：校验 Execution Profile、飞书状态和 Provider protocol 集合一致。

## 技术问题对应的业务问题

| 技术问题 | 用户或业务表现 | 本轮控制 |
| --- | --- | --- |
| Task/Profile/状态自由字符串漂移 | 任务走错 Runner、Todo 一直显示进行中、重复回复或无法继续 | 权威常量、运行时 guard、schema/manifest 集合校验 |
| 飞书 step 的 `details.status` 覆盖正式 step status | 已完成任务在飞书或 Workbench 中显示未知/卡住，运营误判需要重跑 | 修正合并顺序，禁止详情覆盖 `name/status/at`，写入前校验 run state |
| 文档复审路径读取未定义的 `asr` 变量 | 客户文档评论/修订在已有正文读取后直接崩溃，无法交付 revision | 将复审上下文明确标记为未上传媒体，并纳入全量 `.mjs` checkJs |
| Provider registry 通过强制类型断言 | 配置看起来健康，第一次真实生成才失败，造成超时、漏交付或无效模型费用 | registry runtime parser 与 generation result guard |
| ASR `complete` 与 partial/failed chunk 可同时出现 | 残缺转录被生成纪要或 Source Pack，决定、行动项和客户需求可能错误 | complete 必须有 segment、无 failed chunk、非 partial |
| Model Route 成功/失败返回没有共同 reason 合同 | fallback 后 Agent 无法解释为何换模型，故障恢复与费用审计困难 | selected 明确 `reason=null`，blocked 保留可恢复原因 |
| checkpoint、wave 索引和可选参数靠隐含假设 | 长 PRD/架构文档中途卡住、章节重复生成或恢复错误 | strict index/optional 检查、显式越界诊断和 checkpoint 字段合同 |
| Python/Swift 各自维护状态字符串 | 后端已失败但桌面端显示成功，或错误 store 结果被复用 | 共享语言中立 manifest 与真实 consumer smoke |
| 源码 checkout 通过但 npm tarball 不完整 | 开发机可运行，其他 Agent 安装后缺 `.d.ts`、exports 或运行文件 | `publint`、pack dry-run、临时 tgz 安装、NodeNext consumer 编译与 ESM import |

## 迁移顺序完成情况

1. 状态、合同与 Agent Runtime：已完成。Task/Ledger/Todo、Provider/ASR/飞书状态进入权威合同和运行时校验。
2. Provider、HTTP、飞书与持久化：已完成。真实 Provider、云端 ASR、飞书 handler/gateway、Python store 进入边界检查。
3. Workbench 与测试/发布：已完成。Swift 消费共享 manifest；全部直接编写 MJS tool/test/release script 进入 checkJs；npm tarball 使用真实 consumer 验证。

“迁移完成”表示所有直接编写 TS/JS 文件已进入相应静态检查和发布门，不表示所有 `.mjs` 已改名为 `.ts`，也不表示动态 artifact 内部已经没有任何 `any`。后续应只在修改相关模块时，把局部 `any` 替换为领域类型；禁止为提高语言百分比做无业务收益的后缀迁移。

## 发布验证

```bash
cd meeting-agent-pi-package
npm test
npm run typecheck
npm run publint
npm run pack:dry-run
npm run release:local
```

`release:local` 不发布 registry；它在隔离临时目录安装实际 tgz，并执行 NodeNext strict consumer 编译和 ESM import。Pi、sub-agent、Dynamic Workflow 与 TypeBox 继续使用受控 peer range，本轮没有升级关键依赖。

## 剩余风险

- `.mjs` 已 checkJs，但没有宣称 strict；复杂动态 artifact 的内部归一化仍需运行时 guard 和测试共同保证。
- `any` 仍集中在文档 Worker、Source Context、QA 与 Office artifact 的动态内部结构；它们是后续触达式收窄范围，不是新的跨系统真相源。
- 静态检查不能代替 DashScope、飞书、OSS 和模型 Provider 的真实在线可用性验证。
