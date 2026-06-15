# 会议纪要 Prompt 梳理与 0606 Terry 商业模式纪要逆推

日期：2026-06-07

## 结论

当前 PI meeting-agent 的会议纪要能力不是单一 system prompt，而是多层 prompt contract 叠加：

1. `agent.md`：项目级静态开发约束，定义权限、ASR、证据、文档输出规则。
2. `feishu_agent_task_handler.mjs`：Feishu runtime task prompt，约束真实链路必须走 planner、capability registry、prompt registry、document worker、QA/Policy。
3. `document-worker-runtime.ts`：实际传给模型的 document worker system prompt，要求证据约束、只读 bounded context pack、不编造 owner/deadline/budget。
4. `prompts/meeting-minutes.md` + `skills/meeting-minutes/SKILL.md`：会议纪要写作规则，要求 topicMap、动态结构、标题契约、证据覆盖、QA 复核。
5. `document-prompt-registry.json`：会议纪要最终仍被约束到固定 requiredSections：`会议主题 / 核心结论 / 主议题章节 / 行动项 / 风险与开放问题 / 最终判断`。

这份 `2026-06-06-terry-business-model-meeting.pdf` 的质量特点是“商业模式对齐型纪要”：它不是普通会议摘要，而是围绕收费模式、套餐体系、退款机制、交付物定位、背书风险、渠道合作、开单 deadline 做议题级归纳。它可以作为会议纪要 prompt 的重要参考，但不应该把具体事实写进 prompt，只应抽取其结构策略和质量约束。

## 当前 Prompt 层级梳理

### 1. 项目级静态约束：`agent.md`

核心规则：

- PI 是主动执行框架，不应固化为单一会议流水线。
- 原始音频只在 ASR provider 阶段处理；当前策略支持本地 `local_qwen3` 和云端 `aliyun_dashscope_paraformer`，ASR 后只把 transcript/evidence 交给文档生成与 QA。
- ASR 后 transcript/evidence 文本默认可发给 DeepSeek/小米用于纪要、文档生成和复核。
- 会议产物必须区分已证据支持事实、合理推断、待确认问题。
- 文档标题必须来自内容证据，不能来自 raw audio filename、Feishu token、runId。
- 文件、ASR、批注、多源证据不得直接拼进 prompt；长内容必须进入 Source Context，模型只消费 bounded context pack。

判断：这层更像“开发者/项目治理 system prompt”，不是单次模型调用的 prompt。它定义边界，但不直接决定会议纪要结构。

### 2. Feishu runtime task prompt：`buildAgentTaskMarkdown()`

位置：`meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs`

它把 Feishu 入站事件转换成一份任务说明，核心约束包括：

- 音频必须走 ASR provider abstraction，不能绕过 runtime 直接拼接 transcript；云端 provider 只在 ASR 阶段接收 raw audio。
- 短任务不启动长文档 worker。
- 长文档结构必须走 `document router -> document-prompt-registry -> document_prompt_render_batch -> document_workers_run sectionBatching`。
- 生成结果必须经过 QA Gate 和 Policy Gate。
- 不支持图片、视频、删除等能力时直接回复不支持。

判断：这是 runtime orchestrator prompt，负责“不绕过模块”，不是会议纪要的内容 prompt。

### 3. Document worker system prompt

位置：`meeting-agent-pi-package/extensions/document-worker-runtime.ts`

当前实际 system prompt：

```text
你是一个证据约束的中文办公文档写作 worker。你只根据当前 work unit 的 bounded context pack 和目标章节写作，不调用飞书，不修改日历/任务，不编造 owner/deadline/budget/外部事实。输出 Markdown。
```

判断：这是最接近传统意义的 provider system prompt。优点是短、硬、边界清楚；缺点是没有表达“会议纪要类型差异”，类型策略都在 prompt registry 和 context pack 中。

### 4. 会议纪要 prompt

位置：

- `meeting-agent-pi-package/prompts/meeting-minutes.md`
- `meeting-agent-pi-package/skills/meeting-minutes/SKILL.md`

已有强约束：

- 中文输出。
- 必须生成 runtime metadata，但用户可见 Markdown 不包含 JSON 元数据。
- 必须先构建 `meetingProfile` 和内部 `topicMap`。
- 标题格式：`会议纪要｜{参与方/角色}｜{核心主题}｜{关键安排或结论}`。
- 结构根据 topicMap 动态选择。
- 多议题/战略型会议中，商业模式、收费结构、超级个体、渠道合作、组织模式等不能压成一个 bullet。
- 产品、业务、组织三类议题有不同展开重点。
- 所有关键判断必须可回溯到 evidence。
- 参考 PDF 只能学习层级密度、标题组织、议题展开方式和表达风格，不能混入事实。

判断：这层方向是对的，并且已经覆盖了 0606 PDF 的很多风格要求。

### 5. Registry 与 worker 的结构限制

位置：`meeting-agent-pi-package/runtime/document-prompt-registry.json`

当前 `meeting-minutes` 固定 requiredSections：

```json
["会议主题", "核心结论", "主议题章节", "行动项", "风险与开放问题", "最终判断"]
```

Document worker 又要求每个 batch “目标章节必须逐字作为 Markdown 二级标题输出”。这会产生一个结构张力：

- prompt 文本说“结构必须根据 topicMap 动态选择”；
- registry/worker 又强制固定 6 个二级标题；
- 因此模型很难完全复现 0606 PDF 这种 `会议背景 / 关键讨论主题 / 决策与共识 / 开放问题 / 待办事项 / 风险与注意事项 / 时间线摘要` 的结构，只能把它塞进固定章节下面。

这是目前最值得完善的地方。

## PDF 纪要结构分析

PDF：`2026-06-06-terry-business-model-meeting.pdf`

PDFKit 抽取结果：7 页，标题为 `会议纪要：0606 Terry 商业模式与服务套餐对齐`。

### 文档结构

1. `核心结论`
   - 6 条编号结论，先给最终判断。
   - 每条都是业务决策，不是流水账。
   - 覆盖收费模式、套餐体系、退款机制、背书风险、交付物定位、deadline。

2. `会议背景`
   - 说明前序文档和本次会议目标。
   - 明确本次是对 `03 服务范围与套餐` 进行校对，并关联 `01 商业模式/资产归属`。

3. `关键讨论主题`
   - 9 个议题，每个议题带时间范围。
   - 议题按业务决策链组织，而不是按发言顺序机械摘要。
   - 典型议题包括：
     - AI 顾问诊断两种收费模式。
     - ABCDE 套餐体系。
     - B2B 退款机制与信任建设。
     - 交付物定位。
     - C/D 小规模与大规模系统区分。
     - 运维服务与 SaaS 订阅。
     - 富士康身份背书与背调风险。
     - 渠道合作与分成模式。
     - 服务清单输出与开单推进。

4. `决策与共识`
   - 用清单列出已经确定的判断。
   - 与前面的议题互相印证。

5. `开放问题`
   - 用 checkbox 表达未闭合事项。
   - 包含 C/D 命名、量化指标、运维分级、培训定价、渠道分成、海外/国内报价、title 安排等。

6. `待办事项`
   - 用表格组织事项、负责人、截止、状态。
   - deadline 被突出为“次日中午”“周一前”。

7. `风险与注意事项`
   - 将风险和已有缓解策略写在一起。
   - 包含背调风险、过分诊断风险、交付物主观性、海外合规等。

8. `时间线摘要`
   - 用时间戳表格复盘议题流。
   - 这对长音频特别有价值，便于回看。

### 写作风格

- 先结论后背景，再议题展开。
- 商业决策密度高，价格、范围、退款、渠道、背书、deadline 都具体。
- 大量使用矩阵/表格：收费模式表、套餐表、背书场景表、待办表、时间线表。
- 使用业务类比帮助理解，例如律师模式、医院模式、门诊部/住院部。
- 保留关键业务原词，但不输出原始转写。
- 对开放问题不美化，直接列为未定。

## 逆推出的可能生成 Prompt

下面不是原始 prompt，而是根据 PDF 输出形态逆推的高概率任务 prompt。

```text
你是中文商业会议纪要 writer。请基于输入的带时间戳会议转写，生成一份面向内部 BD、销售、合伙人和交付团队使用的商业模式对齐会议纪要。

目标：
- 不写流水账，输出可直接用于后续服务范围清单、报价、渠道沟通和销售推进的纪要。
- 先给核心结论，再按议题展开。
- 所有判断必须来自本次会议证据；不确定内容写“待确认”。
- 不输出原始长转写，不输出 evidence id，不输出源音频文件名。

标题：
- 使用格式：会议纪要：{日期或会议编号} {参与方/主题}
- 本次主题聚焦 Terry 商业模式与服务套餐对齐。

输出结构：

# 会议纪要：0606 Terry 商业模式与服务套餐对齐

## 核心结论
- 用 5-8 条编号结论总结最重要的业务决策。
- 必须覆盖：收费模式、套餐体系、退款机制、交付物定位、背书/合规风险、近期 deadline。
- 每条要能直接指导下一步执行。

## 会议背景
- 说明本次会议承接了哪些前序文档或前序会议。
- 说明本次会议的主要校对对象和目标。

## 关键讨论主题
- 按宏观议题组织，不按发言顺序机械摘要。
- 每个议题标题必须包含时间范围。
- 每个议题写清：背景/问题、关键判断、方案或边界、后续动作、开放问题。
- 如果出现收费、套餐、退款、渠道、背书、交付物等结构化信息，优先用 Markdown 表格。

重点议题识别：
- AI 顾问诊断收费模式。
- 套餐体系和服务分层。
- B2B 退款机制与信任建设。
- 交付物范围：业务层 vs 技术层。
- 小规模系统与大规模系统差异。
- 运维、SaaS、培训讲课。
- 身份背书、公开宣传、背调风险。
- 渠道合作、返佣、源码/资产归属。
- 服务清单输出和近期销售推进。

## 决策与共识
- 只列已经明确达成的共识。
- 用 ✅ 标记已定事项。

## 开放问题
- 用 checkbox 列出未闭合事项。
- 不要把未定事项包装成已定结论。

## 待办事项
- 用表格输出：事项 / 负责人 / 截止 / 状态。
- 明确紧急事项和 deadline。
- 没有负责人或截止时写“待确认”。

## 风险与注意事项
- 列出商业、合规、交付、背调、信任和客户预期风险。
- 每个风险尽量写出当前缓解策略。

## 时间线摘要
- 用表格列出时间戳和议题。
- 服务后续回看和定位。
```

## 可以参考并完善的点

### P0：补齐“会议类型 -> 输出结构”的显式映射

当前 prompt 说“动态选择结构”，但 registry 固定了会议纪要 requiredSections。建议新增会议纪要 section profile：

- `execution_meeting`：保留当前 6 段结构。
- `business_model_alignment`：采用 PDF 风格结构：
  - 核心结论
  - 会议背景
  - 关键讨论主题
  - 决策与共识
  - 开放问题
  - 待办事项
  - 风险与注意事项
  - 时间线摘要
- `product_solution_meeting`：突出产品需求、MVP、数据安全、部署、验收。
- `technical_architecture_meeting`：突出系统边界、数据流、风险、测试计划。

落地建议：不要让 worker 自由决定所有标题，而是在 `source-context-runtime` 或 router 阶段产出 `meetingStructureProfile`，再由 registry/prompt 选择对应 requiredSections。

### P0：商业模式会议的 topicMap 要更具体

当前 prompt 已提到“商业模式、收费结构、渠道合作”，但仍偏泛。建议在 `meeting-minutes.md` 加入 business topic coverage checklist：

- 收费模式：按小时、固定费用、订阅、套餐、返佣、差价。
- 套餐边界：每个套餐的定位、交付物、价格区间、独立签约/退款关系。
- 退款与信任机制：退款触发条件、阶段边界、品牌信任策略。
- 交付物边界：业务层报告、PRD、流程图、ROI、技术架构是否外发。
- 渠道/合作：渠道商角色、返佣、加价、客户归属。
- 合规/背书：公开宣传、身份背书、背调、title、logo 使用。
- 近期推进：deadline、销售/BD 所需材料、谁负责。

QA Gate 应把这些作为商业模式会议的 `omittedMacroTopics` 检查项。

### P0：增强表格/矩阵生成规则

PDF 的高可读性很大程度来自结构化表格。当前 prompt 只要求行动项表格，建议加入：

- 当出现两种及以上模式比较时，输出“模式 / 机制 / 定价 / 优点 / 风险”表。
- 当出现服务套餐时，输出“套餐 / 定位 / 核心交付物 / 定价区间 / 适用客户”表。
- 当出现背书或合规场景时，输出“场景 / 决策 / 原因 / 风险等级”表。
- 当出现时间戳密集议题时，输出“时间线摘要”表。

### P1：把“时间线摘要”设为长音频默认附加段

长会议纪要只给结论和行动项还不够，用户后续回看需要定位。建议：

- 对超过 45 分钟或 segment 数超过阈值的会议，自动生成 `时间线摘要`。
- 时间线摘要不替代正文，只作为回看索引。
- 时间线条目必须来自 ASR segment 时间范围，不允许估算。

### P1：会议背景应显式承接历史文档

PDF 里把 01/03 版文档和前序会议放进背景，这比单独总结当前音频更有项目连续性。建议：

- 如果 source context 中存在历史纪要、PRD、服务范围文档，会议背景必须写“本次承接/校对/对齐的上游材料”。
- 但只能写当前 context 已提供的上游材料，不能凭项目记忆补充。

### P1：核心结论需要绑定 deadline 和用途

PDF 的核心结论不仅写“决定了什么”，还写“为什么现在要做”和“用来支撑什么”。建议在 prompt 加入：

- 核心结论至少覆盖一条“近期交付/销售推进 deadline”，如果 transcript 有明确 deadline。
- 对每条结论标注其用途类型：销售推进、BD 沟通、交付边界、合规风险、内部协作。

### P2：不要过早引入向量库解决这个问题

这次 PDF 体现的问题主要是 prompt/schema 和会议类型识别问题，不是检索召回不足。P0 应先做：

- 结构化 segmentation。
- meetingStructureProfile。
- deterministic topic coverage checklist。
- context pack 中明确 selected segment -> topic 的映射。

只有当多文件、多历史纪要、多项目知识库导致 deterministic/FTS 召回不足时，再考虑 embedding/vector。

## 对当前 Prompt 的具体修改方向

### `meeting-minutes.md`

建议新增一个“商业模式/服务套餐会议”规则块：

```text
如果 topicMap 判断会议属于 business_model_alignment / service_package_alignment：
- 必须识别收费模式、套餐体系、退款机制、交付物边界、渠道合作、背书/合规风险、近期销售/BD deadline。
- 输出结构优先使用：核心结论、会议背景、关键讨论主题、决策与共识、开放问题、待办事项、风险与注意事项、时间线摘要。
- 多模式比较、套餐体系、背书场景必须优先使用 Markdown 表格。
- 关键讨论主题必须带时间范围；无法定位时间时写“时间待确认”。
```

### `document-prompt-registry.json`

当前固定 requiredSections 会压住动态结构。建议从单一数组升级为结构 profile：

```json
{
  "docType": "meeting-minutes",
  "requiredSections": ["会议主题", "核心结论", "主议题章节", "行动项", "风险与开放问题", "最终判断"],
  "sectionProfiles": {
    "business_model_alignment": ["核心结论", "会议背景", "关键讨论主题", "决策与共识", "开放问题", "待办事项", "风险与注意事项", "时间线摘要"]
  }
}
```

worker 仍然可以保持“必须逐字输出目标章节”，只是目标章节由 context plane/router 选择，而不是固定死。

### `source-context-runtime`

建议在 context manifest 中补充：

- `meetingStructureProfile`
- `topicCoverageChecklist`
- `timelineRequired`
- `matrixCandidates`
- `referenceStyleProfile`

其中 `referenceStyleProfile` 只保存结构和风格，不保存参考 PDF 的事实。

### `qa-gate`

建议新增针对 business model meeting 的覆盖检查：

- `pricing_model_missing`
- `package_boundary_missing`
- `refund_mechanism_missing`
- `deliverable_boundary_missing`
- `channel_or_revenue_split_missing`
- `backing_or_compliance_risk_missing`
- `deadline_or_sales_enablement_missing`
- `timeline_summary_missing_for_long_meeting`

这些不一定全部 blocking，但对商业模式会议应至少作为 needs_fix 或 warning。

## 不建议做的事

- 不要把 0606 PDF 的事实写入通用 prompt。
- 不要把该 PDF 固化成唯一会议纪要模板。
- 不要用 runId、文件名或 Feishu token 推断会议标题。
- 不要为了复刻 PDF 风格绕过 context plane，把整篇 transcript 或参考 PDF 直接塞进 prompt。
- 不要优先上向量库；当前问题更像 section contract 和 meeting type profile 缺口。

## 验收标准

后续如果按上述方向实现，至少应满足：

- 商业模式会议能输出 `核心结论 / 会议背景 / 关键讨论主题 / 决策与共识 / 开放问题 / 待办事项 / 风险与注意事项 / 时间线摘要`。
- 普通执行会议仍可使用简洁结构，不被商业模板污染。
- 参考 PDF 只影响结构和风格，不混入事实。
- 长音频纪要具备时间线摘要。
- 套餐、定价、退款、渠道、背书风险等持续讨论主题不会被压成一个 bullet。
- QA 能识别商业模式会议遗漏关键宏观议题。
