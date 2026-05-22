生成会议纪要。

请使用已加载的 `meeting-minutes` skill，并按以下要求输出：

- 语言：中文。
- 必须为流水线生成元数据，字段为 `meetingTitle`、`titleBasis`、`sourceFile`、`feishuFileName`、`evidenceCoverage`；但最终上传飞书的用户可见 Markdown 不得包含 JSON 元数据块。
- 必须先使用 `meetingProfile`：`meetingType`、`allowedRoles`、`allowedTopics`、`allowedTerms`、`ambiguousTerms`、`siblingForbiddenTerms`。正文中的角色、组织、表名、项目名和行动项 owner 必须来自当前 `meetingProfile` 或当前 transcript 的明确证据。
- 不得把 `ambiguousTerms` 自行扩展成 profile 外业务专名；例如 transcript 只说“表/问题/材料”时，只能写“需求表/问题表/待确认材料”，不能补成其他会议中的 HR 表、薪酬表或财务表。
- 如果输出中出现 `siblingForbiddenTerms` 或 profile/transcript 不支持的新实体，必须阻塞并请求修订，不得发布。
- `meetingTitle` 必须根据会议内容生成，主要参考：与会人员/角色、会议内容、会议安排、会议结论。
- 标题格式：`会议纪要｜{参与方/角色}｜{核心主题}｜{关键安排或结论}`；信息不足时使用角色称谓或 `待确认`，不得编造人名、日期或承诺。
- 如果输入中包含 `Document Title Plan`，必须把它作为标题候选和飞书文件名候选；若 transcript/evidence 能支持更具体的参会方、核心主题或关键结论，可优化 `meetingTitle`，但最终 Markdown H1 和飞书文件名必须仍与同一个 `meetingTitle` 同步。
- Markdown H1 必须等于 `meetingTitle`。
- 飞书 Markdown 文件名必须等于 `feishuFileName`，由 `meetingTitle` 派生，格式 `{meetingTitle}.md`，并去除 `/ \ : * ? " < > |` 等不适合文件名的字符。
- 必须先在内部生成 `topicMap`（不进入用户可见 Markdown）：每个主议题包含 `macroTopic`、`timeRange`、`evidenceDensity`、`coreJudgment`、`decisions`、`actions`、`risks`、`openQuestions`。凡是连续多个 transcript segment 讨论、有明确判断、有后续动作或有风险/开放问题的内容，都应列为主议题候选。
- 参考 PDF 或历史纪要的核心是“议题级总结逻辑”，不是固定目录模板：先识别会议中的产品需求、技术方案、商业模式、组织协作、合作结构、融资/发展判断等主议题，再决定章节层级。
- 结构必须根据 `topicMap` 动态选择：简单执行型会议可使用“会议主题、核心结论、关键讨论与需求拆解、决策与分歧、行动项、风险与开放问题、最终判断”；多议题/战略型会议应使用“会议主题、核心结论、若干主议题章节、代办事项、风险与开放问题、最终判断”。
- 多议题/战略型会议中，产品需求、商业模式、收费结构、超级个体、渠道合作、组织模式等只要有连续证据，不得压缩成一个 bullet；必须独立展开背景/问题、关键判断、边界或方案、后续动作和开放问题。
- 产品类主议题优先展开 MVP 边界、数据安全、部署环境、功能范围、待确认条件；业务类主议题优先展开公司定位、收费方式、交付模式、合作结构、近期策略；组织类主议题优先展开角色分工、知识库/复用资产、前后台协作。
- 行动项结构要服务执行：简单会议可用表格；复杂会议优先按主议题分组 checklist，确保每个重要主议题都有对应后续动作或明确写出“暂无行动项/待确认”。
- 所有关键判断必须可回溯到内部 evidence；用户可见 Markdown 只写自然时间点或来源描述，不显示 raw evidence id、chunk id、源音频文件名、`transcriptSegments` 字段名。
- 发布前 QA 必须检查 `unsupportedEntities`、`crossMeetingTerms`、`ambiguousTermExpansions` 和 `omittedMacroTopics`。前三类属于 blocking issue；`omittedMacroTopics` 若遗漏了连续多个 transcript segment 的主议题，必须修订后再发布。
- QA 结论、Evidence Notes、模型复核说明、`externalAudioUpload` 注释和其他测试字段只写入本地 QA artifact，不得出现在飞书会议纪要正文。
- 不确定内容标记为 `待确认`。
- 不编造 owner、deadline、预算或外部事实。
- 不要输出原始长转写。
- DeepSeek 负责主稿；小米 MiMo 复核建议只有能引用当前会议 evidence 时才合入。小米 MiMo 复核必须检查是否存在 `omittedMacroTopics`：连续多个 segment 的主议题是否被遗漏，商业模式/收费结构/超级个体/合作方式/组织模式是否被压缩成单句，行动项是否覆盖所有主议题。
- 原始音频/视频不得发送给外部模型；ASR 后 transcript/evidence 文本是默认允许的语义输入，不需要逐次确认。
- 如果会议输入中包含参考 PDF 或历史纪要，只学习其层级密度、标题组织、议题展开方式和表达风格，不把其中事实、owner、日期或决策混入当前会议。

会议输入：

{{input}}
