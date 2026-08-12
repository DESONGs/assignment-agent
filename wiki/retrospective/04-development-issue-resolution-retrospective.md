> 历史快照：本文是阶段复盘，不代表当前架构。当前入口见 `README.md`。

# 开发问题与修复专项复盘

更新时间：2026-05-22

## 问题总览

本专项复盘覆盖当前 `issues/` 和 `problem/` 下的所有开发问题。它把问题分为代码缺陷、环境权限、架构缺口、运行观测缺口和数据治理缺口，避免把权限配置问题误判为代码问题，也避免把已修复代码缺陷继续当作 open blocker。

| 问题 | 类型 | 当前状态 |
| --- | --- | --- |
| Feishu bot end-to-end runtime 未闭环 | 代码缺口 + live 条件 | code path fixed，仍有环境权限依赖 |
| `lark-cli` keychain/auth 阻塞 live smoke | 环境权限 | open/configuration |
| PI provider membership 阻塞真实内容生成 | 环境权限 | open/configuration |
| Feishu 音频格式 normalization 缺口 | 代码缺陷 | fixed |
| 音频纪要与发布策略过度保守 | 代码缺陷 + policy 边界 | fixed by runtime behavior |
| ASR 后 pipeline 长时间 pending | 运行观测缺口 | fixed by thin runner，仍需 live regression |
| Feishu Drive scope 缺失 | 环境权限 | open/configuration |
| 显式 Feishu file URL 被旧音频缓存误路由 | 代码缺陷 | fixed |
| 文件上下文与 Hermes trajectory 缺口 | 代码缺陷 + 观测缺口 | fixed |
| 文档修订评论上下文路由缺失 | 代码缺陷 + 权限边界 | implemented，live 取决于评论权限 |
| 评论线程读取与正文匹配边界 | 架构边界 | design fixed |
| Wiki / Hermes Wiki 权限前置条件 | 环境权限 | open/configuration |
| Document Worker streaming、deadline、checkpoint retry | 运行观测缺口 | fixed infrastructure |
| Runtime Context Plane contract gap | 架构缺口 | first implementation fixed，needs live QA |
| 音频重复下载、ASR health preflight、重复 ACK | 数据治理 + UX | fixed |

## 来源覆盖矩阵

| 来源文件 | 本文覆盖位置 |
| --- | --- |
| `issues/2026-05-19-feishu-bot-end-to-end-runtime-not-wired.md` | 2026-05-19 / Feishu bot end-to-end runtime 补齐 |
| `issues/2026-05-19-feishu-lark-cli-keychain-auth-blocks-live-smoke.md` | 2026-05-19 / `lark-cli` keychain/auth 阻塞 live smoke |
| `issues/2026-05-19-pi-provider-membership-blocks-feishu-live-generation.md` | 2026-05-19 / PI provider membership 阻塞真实内容生成 |
| `issues/2026-05-20-feishu-audio-format-normalization-gap.md` | 2026-05-20 / 音频格式 normalization 缺口 |
| `issues/2026-05-20-feishu-audio-minutes-and-publish-policy-gap.md` | 2026-05-20 / 音频纪要与发布策略过度保守 |
| `issues/2026-05-20-feishu-audio-minutes-post-asr-pipeline-stall.md` | 2026-05-20 / ASR 后 pipeline 长时间 pending |
| `issues/2026-05-20-feishu-cloud-file-drive-scope-missing.md` | 2026-05-20 / Feishu Drive scope 缺失 |
| `issues/2026-05-20-feishu-explicit-file-url-routed-to-audio-cache.md` | 2026-05-20 / 显式 Feishu file URL 被旧音频缓存误路由 |
| `issues/2026-05-20-feishu-file-context-observability-gap.md` | 2026-05-20 / 文件上下文与 Hermes trajectory 缺口 |
| `issues/2026-05-21-feishu-document-revision-comment-context-routing.md` | 2026-05-21 / 文档修订评论上下文路由缺失 |
| `issues/2026-05-21-feishu-wiki-and-hermes-wiki-permission-prerequisites.md` | 2026-05-21 / Wiki 与 Hermes Wiki 权限前置条件 |
| `issues/2026-05-22-runtime-context-plane-contract-gap.md` | 2026-05-22 / Runtime Context Plane contract gap |
| `problem/2026-05-21-feishu-document-comments-context-matching.md` | 2026-05-21 / 评论线程读取与正文匹配边界 |
| `problem/2026-05-22-document-worker-stream-timeout-diagnostic.md` | 2026-05-22 / Document Worker streaming、deadline、checkpoint retry |
| `problem/2026-05-22-feishu-audio-runtime-duplicate-download-asr-ack.md` | 2026-05-22 / 音频重复下载、ASR health preflight、重复 ACK |

## 修复时间线

### 2026-05-19

Feishu bot end-to-end runtime 补齐。

- 触发场景：用户希望在飞书发送指令或上传录音后，本地 Agent 自动生成文档并回复。
- 用户侧现象：早期只有 CLI 能力和 gateway 片段，缺少 handler 到 PI task、发布、回复的完整闭环。
- 根因：飞书能力被拆成主动 CLI、事件入口、本地 handler 三层，但第三层未完整落地。
- 修复动作：新增 CLI-first event runner、本地 task handler、附件下载 planned/live 路径、dry-run/live publish 分层、文件上下文和最近附件缓存。
- 验证方式：fixture text/file/audio event 能生成 event、task、state、agent-output、publish、reply 等 artifact；真实文本事件和 bot reply 已验证。
- 当前状态：代码路径 fixed；真实内容生成仍受 provider 权益和 bot Drive scope 影响。
- 残留风险：live smoke 必须区分代码路径、登录态、Drive/Wiki 权限和 provider 可用性。

`lark-cli` keychain/auth 阻塞 live smoke。

- 触发场景：运行真实飞书事件消费、附件下载、Markdown 创建和回复。
- 用户侧现象：fixture 可跑，但 live publish/reply 前置登录态不稳定。
- 根因：本机 CLI profile/keychain 未初始化或当前运行环境不可访问。
- 修复动作：不绕过边界；记录为环境阻塞，要求先完成官方登录流程并只暴露脱敏状态摘要。
- 验证方式：CLI auth verify 通过后再跑 live smoke。
- 当前状态：open/configuration。
- 残留风险：不能把 fixture 通过等同于 live 权限已具备。

PI provider membership 阻塞真实内容生成。

- 触发场景：真实飞书 run 已能进 handler，但 PI 内容生成不写最终输出。
- 用户侧现象：Feishu 能接收任务和回复状态，mock publish 可创建文档，真实会议纪要或 PRD 无法生成。
- 根因：主 provider 和复核 provider 当前账号或权益不可用。
- 修复动作：handler fallback 逻辑已补，但两个 provider 都不可用时只能明确 blocked。
- 验证方式：最小 provider smoke 返回 OK 后，再执行真实 Feishu 任务。
- 当前状态：open/configuration。
- 残留风险：provider 问题不能被误归因到 Feishu bridge。

### 2026-05-20

音频格式 normalization 缺口。

- 触发场景：用户上传 WAV、MP3、M4A、AAC、FLAC、OGG 等常见音频。
- 用户侧现象：旧 runner 只允许 WAV，合法音频在 ASR 前被拒绝。
- 根因：把本地 ASR 服务输入约束暴露成产品输入限制，缺少本地 normalize。
- 修复动作：新增音频 normalize helper，本地转成 16k mono s16 WAV，优先 ffmpeg，fallback macOS afconvert，并写入阶段状态。
- 验证方式：24-bit stereo WAV、M4A、无转码器路径、ASR payload 路径回归。
- 当前状态：fixed。
- 残留风险：转码器缺失时仍需要清晰用户提示。

音频纪要与发布策略过度保守。

- 触发场景：飞书中用户上传录音后回复“形成会议纪要”，或明确要求生成并发布。
- 用户侧现象：音频被当作普通 file，或纯文本回复无法关联父消息录音；文档生成后发布被过度确认阻塞。
- 根因：attachmentKind 过度相信 resourceType；文件引用规则未覆盖录音/转写表达；Policy Gate 对用户明确写入请求没有区分非删除动作。
- 修复动作：音频扩展名优先识别；录音、音频、转写等表达进入父消息/root 消息和缓存解析；Feishu inbound 明确写入请求在非删除场景下允许 QA pass 后执行；删除类动作保持 blocked。
- 验证方式：回复音频父消息进入 `audio_minutes`；图片和视频返回 unsupported；删除类命令不出现在 planned/live commands。
- 当前状态：fixed by runtime behavior。
- 残留风险：新 channel adapter 必须复用这套边界。

ASR 后 pipeline 长时间 pending。

- 触发场景：父消息音频已下载，本地 ASR 已完成，但用户长期只看到“处理中”。
- 用户侧现象：没有会议纪要、QA、发布或最终回复；artifact 只显示前半段完成。
- 根因：ASR 后的会议纪要生成、QA、Policy、发布和回复被藏在长时间 PI 子进程中；缺少阶段 timeout、heartbeat 和 partial output。
- 修复动作：新增薄 `task_execution_runner.mjs`，显式执行 ASR 后阶段，通过 runtime CLI 调用 Planner、Model Router、Prompt Registry、Document Worker、QA Gate 和 Policy Gate。
- 验证方式：fixture 要求出现 local ASR completed、meeting minutes generated、QA completed、reply 等阶段；失败时写 blocked/needs_fix。
- 当前状态：fix direction implemented，仍需持续 live regression。
- 残留风险：长文档和 provider 超时仍可能影响用户侧完成时间。

Feishu Drive scope 缺失。

- 触发场景：用户发送飞书云文件链接并要求基于文件生成文档。
- 用户侧现象：系统能解析文件链接，但无法下载文件。
- 根因：当前应用身份缺少云空间文件读取/下载权限。
- 修复动作：handler 将权限错误映射为明确用户提示，不 fallback 到 recent cache。
- 验证方式：task attachment reason 记录为 drive scope missing，并列出所需权限类别。
- 当前状态：open/configuration。
- 残留风险：权限未开通时不能继续装作已读取文件。

显式 Feishu file URL 被旧音频缓存误路由。

- 触发场景：用户发明确文件链接并要求生成 PRD、技术架构和 checklist。
- 用户侧现象：旧实现从 recent cache 拿到同 chat 的旧音频，错误进入音频会议纪要链路。
- 根因：显式文件链接未先转换为 source reference；cache fallback 未按模态过滤；`requiresLocalAsr` 被当成路由决策。
- 修复动作：当前附件和显式文件链接先进入 `sourceReferences[]`；显式链接禁用 recent-cache fallback；缓存按文本/音频模态过滤；document pipeline 支持可选 ASR 和 consolidated evidence pack。
- 验证方式：文件链接 + 多文档生成不得使用旧音频；文本文件任务不出现 ASR 阶段。
- 当前状态：fixed。
- 残留风险：所有新 source 类型都要遵守显式 source 优先。

文件上下文与 Hermes trajectory 缺口。

- 触发场景：用户上传 PDF 后再回复“总结文件内容”，事件本身可能没有附件。
- 用户侧现象：文件无法稳定关联，direct answer 被文档发布 policy 阻塞，回复暴露内部诊断；Hermes 无法直接读取真实 run。
- 根因：附件解析只覆盖当前消息和缓存；direct answer 与文档发布共用 policy；run artifact 到 trajectory 缺转换层。
- 修复动作：解析顺序固定为当前附件 -> 父消息/root 消息 -> 最近附件缓存；direct answer 不因 publish policy 阻塞；每个 run 生成 metrics、manifest、sanitized trajectory；Hermes sidecar 支持 run dir 输入。
- 验证方式：fixture 缺文件时清晰提示；父消息附件可进入 file-context；sidecar 可从 run dir 输出 proposals。
- 当前状态：fixed。
- 残留风险：真实飞书文件消息本体事件仍需 live 观察。

### 2026-05-21

文档修订评论上下文路由缺失。

- 触发场景：用户引用 doc/docx/wiki 并要求“根据批注/评论/修改内容优化”。
- 用户侧现象：任务被识别为 direct answer，最终返回暂不支持。
- 根因：Task intent 未识别文档生命周期修订；旧实现只看导出正文中的可见痕迹，没有读取独立评论线程。
- 修复动作：新增 document revision 能力、review context artifact、prompt overlay、capability registry 同步和 CLI-first 评论线程读取。
- 验证方式：评论修订任务必须进入 `document_revision`，生成 `review-context.json`，使用 base prompt + overlay，不落回 ASR 或 direct answer。
- 当前状态：implemented；live 评论读取取决于飞书评论权限。
- 残留风险：不能凭正文里出现批注字样就声称已读取独立评论。

评论线程读取与正文匹配边界。

- 触发场景：多文档、多评论场景下需要根据评论修改正文。
- 用户侧现象风险：评论被混成全局池，可能把一个 source 的评论应用到另一个 source。
- 根因：评论 API 不一定提供稳定段落路径，正文导出也不保证包含独立评论线程。
- 修复动作：明确不新增常驻评论 watcher；评论读取按任务 on-demand；`review-context.json` 按 `sourceDocuments[].comments[]` 分组；每条评论记录 matchStatus 和 matchReason。
- 验证方式：exact_unique 才作为局部修订依据；exact_multiple、fuzzy、unmatched、exported_body_detected 进入待确认或明确说明。
- 当前状态：design fixed。
- 残留风险：复杂评论定位需要更多真实文档样本验证。

Wiki / Hermes Wiki 权限前置条件。

- 触发场景：用户交付物默认发布到 Feishu Wiki，Hermes 复盘候选写入单独思考库。
- 用户侧现象：Wiki 不可用时需要 fallback，而不是失败或混入错误空间。
- 根因：用户交付 Wiki 和 Hermes 思考库需要不同目标与权限。
- 修复动作：用户交付物 Wiki 不可用时 fallback 到 Drive 并记录原因；Hermes 缺少单独目标时只记录 blocked，不写用户交付 Wiki。
- 验证方式：生成 wiki publish plan/result；Hermes 生成 candidate/gate/publish 三个 artifact。
- 当前状态：open/configuration。
- 残留风险：不能把 learning materials 和客户交付物放到同一目标。

### 2026-05-22

Document Worker streaming、deadline、checkpoint retry。

- 触发场景：文档生成等待约 10 分钟后失败，只留下 opaque timeout。
- 用户侧现象：回复“上下文已准备完成，但文档生成失败，可重试”，无法判断模型是否正在输出。
- 根因：provider 调用非 streaming，runtime tool 只在完整返回后写结果；外层 600 秒 timeout 杀掉 worker；内层没有 deadline-aware budget。
- 修复动作：provider 支持 streaming trace；document worker 写 attempts；runtime store 索引 stream trace；worker 增加 deadlineAt/runtimeBudgetMs；fallback 按预算跳过；checkpointed workflow 支持 retry ledger、partial artifact、final failure report。
- 验证方式：诊断 run 能生成 attempts、stream summary 和 runtime store artifact；失败时能定位 batch、provider、timeout 原因和已完成 sections。
- 当前状态：fixed infrastructure。
- 残留风险：上下文预算和 patch-first revision 仍需继续优化。

Runtime Context Plane contract gap。

- 触发场景：音频、显式文件链接、文件上下文、长文档 timeout、文档修订都暴露上下文所有权不清。
- 用户侧现象：不同功能表现为缓存误路由、prompt 膨胀、timeout、评论上下文过大或跨 source 风险。
- 根因：runtime 有输出分片，没有输入分片；每个 section batch 仍接收完整大上下文。
- 修复动作：新增 `source-context-runtime.ts`，负责 source records、segments、retrieval、context packs、work units 和 pre-generation context gate；runner 不再拼接大段 source text。
- 验证方式：Document Worker prompts 不再包含完整大 prompt；work unit 带 context pack ref、hash、source segment provenance。
- 当前状态：first implementation fixed，needs live QA。
- 残留风险：必须在真实 document generation、revision、ASR transcript、多源合成中持续验证。

音频重复下载、ASR health preflight、重复 ACK。

- 触发场景：用户先发音频，再回复指令生成纪要和 todo。
- 用户侧现象：多次“已接受任务”、文件缓存确认和转写失败混在一起；重跑时重复下载同一文件；ASR 服务未启动导致 blocked。
- 根因：gateway 只按 messageId 去重；async handler ACK 默认可见；download 前不查本地已下载 artifact；ASR 服务不是自动托管 daemon。
- 修复动作：async accepted response 默认静默；文件缓存事件默认静默最终回复；下载前复用当前 run 或缓存本地文件；ASR cache hit 前置，cache miss 才做 health preflight；新增本机 ASR lifecycle CLI。
- 验证方式：重跑同一音频可本地复用；ASR 不可用时返回 `local_asr_service_not_running`；用户侧不再重复 ACK。
- 当前状态：fixed。
- 残留风险：尚未实现 interaction-level debounce，但可见噪声已收敛。

## 共性根因总结

- 输入源边界不清会导致缓存误关联。显式 URL、当前附件、父消息/root 消息和 recent cache 必须有优先级和模态过滤。
- 输出分片不等于上下文分片。长文档只按章节分 batch，但每批仍吃完整上下文，会持续触发 provider timeout。
- 长任务必须有阶段 marker、heartbeat、deadline budget、stream trace 和 partial checkpoint，否则失败后无法定位。
- 环境问题要与代码问题分离记录。CLI 登录态、Drive/Wiki scope、provider 权益、评论权限都属于配置前置条件。
- 用户侧回复必须屏蔽内部诊断术语，只给状态、结果和可执行下一步。
- 权限和 scope 问题必须沉淀为明确 blocker，不能被 fallback、缓存或导出正文掩盖。
- Learning sidecar 只能读脱敏 trajectory 和 proposal，不能成为生产写路径。

## 后续防回归规则

- 新增文件、音频或文档输入前，必须先设计 extraction、segmentation、context budget、privacy、cache/store、failure UX。
- 显式 URL 或文件标识优先于 recent cache；recent cache 必须按文本、音频等模态过滤。
- `audio_minutes` 必须保留完整阶段 marker：下载、normalize、ASR start/done、model route、minutes generated、QA、Policy、publish/reply。
- 文档修订必须生成 `review-context.json`，不得凭导出正文伪造评论处理结果。
- 长文档 worker 必须使用 bounded context pack、stream trace、checkpoint retry 和 final failure report。
- Provider fallback 前要预检可用性，避免在长任务热路径中浪费预算。
- open blocker 继续回写到 `wiki/issues/`，不能只留在复盘文档。
- 任何用户可见回复都不得暴露本地 run id、内部 gate 名称、provider 栈或本地路径。

## 后续建议

- 将本文件作为问题修复 review 的 checklist，每次新增 issue 后补一行总览和时间线。
- 对 `fixed but needs live QA` 的问题建立 live regression 表，避免“代码已修”被误读为“生产条件已满足”。
- 对文档修订、长文档生成和多源合成继续增加 source context 相关 fixture。
- 对 ASR、Feishu permissions、provider readiness 建立统一 preflight summary。
