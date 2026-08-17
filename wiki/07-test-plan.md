# 测试与发布验收

更新时间：2026-08-18。

测试目标是证明真实入口、状态、证据、Agent 委派和交付边界完整贯通，而不只是 schema 或 mock 存在。

## 1. 自动验证

```bash
python3 src/validate_workspace.py
cd meeting-agent-pi-package && npm test
python3 meeting-agent-pi-package/tools/local_ci_check.py
git diff --check
```

| 层 | 当前覆盖 |
| --- | --- |
| Workspace | 目录、package、runtime schema、prompt marker、文档链接与安全边界 |
| ASR | 文件/实时格式矩阵、endpoint 分离、diarization、single-mix robust、cache key |
| Public URL | URL 分类、RSS/小宇宙/YouTube/direct 适配、官方文稿优先、云端 ASR fallback、SSRF/重定向/大小限制、source pack provenance、真实 router |
| Meeting Intelligence | participant alias、topic/evidence、decision/action 验证、quality 传播 |
| Agentic | direct/single/dynamic 计划、Pi 0.46 API、workflow 生成、模型 fallback |
| Tool event | `tool_execution_end` 解析、未调用/失败状态、真实执行证明 |
| Reconciliation | 当前 segment id 集合、跨会议 id、缺失 evidenceSegmentIds、payload quarantine |
| Memory | Pi 原生 Compaction 配置、单 Curator 调用、sourceClaimIds、去重、冲突账本与非阻塞失败 |
| Document | prompt registry、section ordering、model route、QA gate |
| Channel | 飞书 event/task/file context/publish contract 与 secret scan |
| Runtime | Host-owned store、cache/CAS/retention、Docker job boundary |
| Type/Contract | 全部 TS extension 与直接编写 MJS 均 strict；Execution Profile/Ledger/Todo/Provider/飞书/QA/Source Context/Document Runtime/Office Artifact 与跨语言 manifest 一致 |
| npm Package | ESM exports、生成 `.d.ts`/source map、files allowlist、publint、pack dry-run 与临时 NodeNext consumer |

## 2. ASR 验收

- 文件端接受声明的 17 种扩展名，视频和音频分别识别；不因本地 Qwen 输入限制提前拒绝。
- 实时端只接受声明的编码，使用 WebSocket，不提交 OSS 文件任务。
- 文件端 payload 使用短期 OSS HTTPS URL，但 URL 不写入普通 artifact。
- `summary.status=complete`、segment 数量大于零、`failedChunks=0` 才能生成完整纪要。
- partial、零 segment、鉴权、网络、模型、格式和超时分别形成可诊断状态。
- diarization 的匿名 speaker id 稳定，2–100 人 hint 合法；实时不虚报文件端 speaker 能力。
- robust 模式双模型冲突进入 `needs_review`，不以投票覆盖原转录。
- 高重叠同时发言只标记风险，不测试或宣称声源级完整恢复。

### 公开 URL 验收

- 显式 URL 经本地与飞书共用的 Task Router 进入 `url_source_pack`；飞书文档链接不能误路由。
- YouTube、RSS/播客、小宇宙和直接媒体 fixture 均保留来源元数据；可靠官方带时间戳文稿必须跳过媒体与 ASR。
- 无可靠文稿时只允许完整云端文件 ASR；媒体未下载、ASR partial、零 segment 或模型章节失败均不能生成完整 source pack。
- 初始 URL、DNS 结果和每次重定向都拒绝内网/保留地址；响应、媒体和时长超过上限立即停止。
- source pack 每个事实/观点/推断都引用当前 transcript segment，并记录来自官方文稿还是 ASR。
- 成功路径必须写出真实 `policy-gate.json` 与 `qa-gate.json`，输出引用同一决策时间；不得由 runner 直接构造伪 pass。
- 真实小宇宙 smoke 至少验证公开页面元数据、媒体 probe、文稿可用性和 fallback 状态；`--resolve-only` 不得下载媒体或声称已转写。
- YouTube 官方字幕路径与无可靠字幕的云端 ASR fallback 都要至少完成一次公开短样例真实运行；live、private、playlist、大小和时长边界可用稳定 fixture/公开样例组合验证。
- 当前 2026-08-17 的小宇宙、YouTube 与飞书环境证据记录在 [17-public-url-live-validation.md](17-public-url-live-validation.md)，完整媒体和逐字稿仍只留在 ignored runtime。

## 3. Meeting Intelligence 验收

- 相同 speaker id 映射到稳定 `参会人 A/B/...`。
- 用户输入 `参会人 A=姓名` 后只替换显示名，不改变证据 id。
- topic map 覆盖持续讨论的主议题。
- proposed、discussion、objection、agreed、rejected、unresolved 不混淆。
- owner、due date、金额与承诺无证据时为空或待确认。
- `quality=needs_review` 不能单独生成确定决定或行动 owner。

## 4. Agentic 验收

必须覆盖三种模式：

1. 简单会议返回 `direct`，不启动无关 child。
2. 单一核验轴返回 `single_subagent`，并按 `workflowScript` + `runs.run(...)` 执行。
3. 多核验轴返回 `dynamic_workflow`，生成有界并发、完整性检查、verify 和 synthesizer。

真实 smoke 必须保存：

- 可信 orchestration plan。
- provider/model attempts。
- 匹配 `subagent` 或 `workflow` 的 `tool_execution_end`。
- child 结构化发现与 `evidenceSegmentIds`。
- 父级 reconciliation 结果。

以下情况不能记为成功：只有计划、只有 assistant 自述、工具名称不匹配、child 引用不存在 segment、事实性 finding 没有 evidenceSegmentIds。

## 5. 文档与发布验收

- 标题计划、文件名与 H1 一致。
- 重要判断能回到 transcript；原始长 transcript 不复制到纪要。
- QA Gate 包含 evidence coverage、entity isolation、speaker attribution、topic coverage 和 blocking findings。
- Policy Gate 与 QA Gate 分离：内容质量通过不代表外部动作自动允许。
- 飞书发布成功必须有 token/link 和最终回复；失败时本地产物保留并返回恢复方法。
- “目前暂不支持该功能”只在功能确实不存在时使用，不能代替真实错误诊断。

### 长期记忆验收

- 只在完整音频会议的 Meeting Intelligence 和 QA 都通过后运行。
- 真实 smoke 必须出现 `meeting-memory-curator` 对应的 `subagent` `tool_execution_end`，而不是 workflow 或自然语言自述。
- 事实性候选同时引用现有 `sourceClaimIds` 与由该 claim 拥有的当前会议 `evidenceSegmentIds`；参会人身份来自 `user_confirmed` 映射。
- 完全重复不重复写账本，同 key 不同值进入 `conflicts.jsonl` 且不覆盖 `MEMORY.md`。
- 子 Agent 无 write/bash/publish 工具；模型、解析或持久化失败只把记忆阶段标记为 blocked，不改变会议交付状态。

## 6. Host / Docker / Store 验收

架构保持 **Host 原生控制面 + Local Docker 受限执行面**。本地 Docker 不能减少本机总计算消耗；`fast_answer/file_summary 不进 Docker`，`document_generation/multi_source_synthesis 默认进 Docker worker`（queue 模式开启时），`raw audio 不进容器`。默认档位为 `4 CPU / 8GB / 长文档并发 2`。

启动命令：

```bash
docker compose -f docker-compose.local-runtime.yml up -d runtime-queue pi-document-worker
```

验证 Docker worker 不直接写 SQLite、不调用 `lark-cli`、不 publish、不 reply；Host 登记 worker 产物。Store cleanup 默认 dry run，只有 `cleanup --execute` 才执行删除。

## 7. 文档回归

- 当前入口只引用 `wiki/`，不得恢复拼写错误的旧目录。
- Wiki 根层是当前规范，日期化子目录明确标记为历史证据。
- `wiki/02-agent-architecture.md` 至少包含系统架构图、角色关系图、流程图、委派决策图、时序图和数据关系图。
- 当前文档不得声称“本地 ASR 优先”“会议内容只能 pointer-only”或“dynamic worker pool 是主架构”。
- 相对 Markdown 链接必须解析到存在文件；Mermaid fence 必须成对。

## 8. 发布门

发布前集中执行一次：

1. workspace validator。
2. Node test + 全部 extension/runtime/test/release script typecheck。
3. local CI check。
4. `npm audit --omit=dev`。
5. Markdown 链接、Mermaid fence、`git diff --check`。
6. 至少一次与本次变化同层的真实 smoke；若外部凭证或 provider 不可用，明确记录未验证项。

若变化触及 TypeScript 合同或 npm 包边界，还要运行：

```bash
cd meeting-agent-pi-package
npm run publint
npm run pack:dry-run
npm run release:local
```

`release:local` 必须从 tgz 在临时目录执行真实 npm 安装，再以 NodeNext strict consumer 编译并执行 ESM import；consumer 必须同时导入 QA、Source Context、Document Runtime 与 Office Artifact 子路径。源码 checkout 测试通过不能代替该验证。所有 TS extension 与直接编写 MJS 都必须保持 strict。不得用 TypeScript 文件比例代替覆盖证据。

`qa-runs/` 是 legacy `qa-runs/`，只保留 non-production fixture 指针；`qa-runs/**/*.json|jsonl|txt|wav` 不得作为当前生产成功证据提交。
