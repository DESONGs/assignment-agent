# Office Agent PRD

更新时间：2026-08-12。

## 1. 产品定位

Office Agent 是面向个人与小团队的主动型办公助手。它处理问答、文件总结、多源综合、文档生成与修订、飞书协作，以及最成熟的会议理解场景：一份单路混音录音、一个实时音频流、飞书附件或一组本地文件。

价值时刻不是“得到一段转录”，而是用户拿到一份可读、可回溯、能继续行动的会议结果，并能按需继续生成 PRD、技术架构、运营方案或需求确认材料。

## 2. 核心用户场景

- 上传微信、录音设备或会议软件导出的单份音频/视频文件。
- 从智能眼镜持续采集一个实时音频流，结束后生成同一套会议产物。
- 在飞书发送音频、文件或自然语言指令并接收结果。
- 对多人会议区分匿名参会人、议题、立场、决定和行动项。
- 对长会议调用一个或多个独立核验 Agent，而不是让单次模型摘要承担全部判断。
- 审阅纪要后继续要求生成 PRD、技术架构、运营文档或客户确认清单。

## 3. 黄金路径

1. 用户提供文件、实时流或飞书附件，并说明期望产物。
2. 系统选择文件 ASR 或实时流 ASR；云端优先，本地 provider 可作为 fallback。
3. 系统生成完整转录、可读转录、speaker/quality 标签和 evidence index。
4. Meeting Intelligence 识别会议类型、参会人代号、主议题、决策状态、行动项、风险和待确认。
5. 简单会议由父 Agent 处理；复杂会议按需委派 sub-agent/workflow。
6. 父 Agent 验证委派证据，生成会议纪要并执行 QA。
7. QA 通过后按需提炼可跨会议复用的长期记忆；父 Agent 验证并持久化，失败不阻塞交付。
8. 用户获得本地 Markdown 或飞书文档；实名缺失等非关键信息可随后补充。

## 4. 功能范围

### 输入与 ASR

- 文件端与实时流端明确分离。
- 文件端支持 runtime 声明的完整音视频扩展名矩阵。
- 原容器被 provider 拒绝时才重封装或转码，不修改原文件。
- 文件端支持 speaker diarization；`speaker_0/1/...` 只代表聚类。
- robust 单录混音模式可用第二模型复核不确定片段，但不做声源分离承诺。

### Meeting Intelligence

- 稳定参会人代号、用户显式姓名映射，以及带 evidence/basis/confidence 的姓名候选。
- 动态 topic map，不依赖固定行业模板。
- 决策状态：proposed、discussion、objection、agreed、rejected、unresolved。
- 行动项分别记录内容、owner、due date 和证据；无证据字段留空。
- 将 `needs_review`、语义跳变、speaker 冲突和 overlap 风险传播到写作与 QA。

### Agentic 能力

- 父 Agent 根据当前任务决定直接处理、单 sub-agent 或 Dynamic Workflow。
- 子 Agent 使用 fresh context、只读工具和项目定义角色。
- Dynamic Workflow 支持并行、完整性检查、verify 和结构化综合。
- 父 Agent 对返回 segment id 做集合校验，隔离跨会议和无证据输出。
- 委派失败不阻塞整个会议任务；系统记录原因并执行显式父级 review。

### 记忆能力

- 当前父会话使用 Pi 原生 Compaction 做短期上下文压缩。
- 长期记忆由一个持久角色、fresh 单次运行的 `meeting-memory-curator` 提出候选，不使用 Dynamic Workflow，也不运行常驻 LLM。
- 只接受已确认项目事实、已达成决定、用户显式参会人身份、稳定术语和持续开放问题；普通行动项、低置信 ASR、未确认提议和长段原文不进入长期记忆。
- 父 Agent 必须验证 `sourceClaimIds` 与当前会议 `evidenceSegmentIds`，去重并将同 key 不同值记录为待审冲突；子 Agent 无写入权限。

### 文档与飞书

- 会议纪要标题和章节由当前会议决定。
- 重要结论必须可回溯；原始长转录独立保存，不复制到纪要。
- 可按需生成 PRD、技术架构、运营方案和需求确认清单。
- 飞书支持进度、发布、回复和可理解的失败恢复。

## 5. 非功能要求

- 凭证安全：API Key、Token、Cookie、Authorization 和 session 不进入模型或产物。
- 证据完整：partial ASR 不得冒充完整会议。
- 失败透明：provider、模型、格式、权限、网络和委派失败分别记录。
- 运行可观测：每次 run 保存 planner、model route、Meeting Intelligence、delegation、QA、Policy 和 publish artifact。
- 成本有界：简单会议不启动 sub-agent；复杂会议 specialist 不超过当前配置上限。
- 记忆非阻塞：记忆模型、解析或写入失败不能改变已通过 QA 的会议交付状态。

## 6. 产品边界

- 单路混音可以改善 speaker 聚类和语义归属，但无法保证恢复完全重叠语音。
- 未登记声纹聚类不能凭空产生真实姓名；自我介绍、明确称呼、上下文关系或已登记声纹可形成候选，但候选不绑定责任、承诺或长期身份。
- 智能眼镜只是 ingestion 设备；不会改变底层会议理解架构。
- 默认不自动发布后续 PRD/架构等建议文档，用户确认后再生成。
- 会议内容允许用于当前任务能力；凭证安全和高影响动作仍受约束。

## 7. 验收标准

- 常见文件格式不因本地模型输入限制被提前拒绝。
- 文件与实时流不会走错 endpoint。
- 两人以上会议生成稳定匿名代号，并在证据不足时保留待确认。
- sub-agent/workflow 只有真实工具完成事件才记为执行成功。
- 跨会议 segment id 无法进入最终文档。
- 长期记忆候选无法引用当前会议以外的 segment，也不能绕过 Meeting Intelligence claim 所有权。
- 会议纪要覆盖持续主议题，决策、行动项和风险与 transcript 一致。
- 本地运行目录、录音、转录与凭证均不进入 Git。
