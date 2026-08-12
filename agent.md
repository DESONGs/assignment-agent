# Meeting Agent 开发与运行规则

更新时间：2026-08-12。

本文只记录当前有效的项目级约束。历史方案、故障记录和过往取舍保存在 `wiki/` 的日期化目录中，但不覆盖本文、代码或当前架构文档。

## 读取顺序

任何接手本项目的 Agent 或开发者先读：

1. `README.md`
2. `wiki/README.md`
3. `wiki/02-agent-architecture.md`
4. `wiki/11-current-project-architecture.md`
5. `wiki/01-prd.md`

按任务补充读取：

- Prompt：`wiki/03-system-prompts.md`
- Skill/tool：`wiki/04-skill-design.md`
- 飞书、Rokid、凭证：`wiki/05-feishu-rokid-permissions.md`
- Sub-agent/workflow：`wiki/06-agent-team-index.md`
- 测试：`wiki/07-test-plan.md`
- 运行存储：`wiki/14-local-data-storage-cache-backend.md`

## 当前运行基线

- Node `>=22.19.0`，项目 `.nvmrc` 为 `22.23.1`。
- Pi 开发依赖锁定 `0.84.1`。
- `pi-subagents@0.46.0`，调用使用 `workflowScript` + `runs.run(...)`，不得恢复已移除的顶层 `{agent, task}` 启动方式。
- `@quintinshaw/pi-dynamic-workflows@3.5.1`。
- 项目 Pi package 通过 `.pi/settings.json` 的 `../meeting-agent-pi-package` 加载；路径相对 `.pi/` 解析。
- `.env.local` 是本地模型与 ASR/OSS 配置入口，不得提交。

## 产品黄金路径

1. 识别用户目标、输入类型和预期交付物。
2. 音视频先选择 ASR provider：文件和实时流使用不同端口。
3. 生成完整 transcript、readable transcript、speaker/quality 元数据和 evidence index。
4. Meeting Intelligence 建立参会人、议题、决策状态、行动项、风险、开放问题和证据映射。
5. 根据当前会议复杂度选择父 Agent、一个 fresh sub-agent 或 Dynamic Workflow。
6. 父 Agent 对委派结果做 segment id 集合校验；越界证据必须隔离。
7. Prompt Registry 与 Document Workers 生成文档，QA Gate 检查证据与交付质量，Policy Gate 检查外部动作。
8. 已通过 QA 的完整音频会议按需唤醒一次 `meeting-memory-curator`；父 Agent 校验 claim/segment、去重、隔离冲突并更新项目长期记忆。
9. 按用户要求交付本地文件或发布飞书。记忆提炼失败不得阻塞已通过 QA 的会议交付。

这是一条产品黄金路径，不是所有任务都必须执行的固定 DAG。`fast_answer`、`file_summary`、文档修订和多源综合会按 execution profile 选择所需阶段。

## Agent 决策边界

- 父 Agent 是最终责任主体：理解目标、决定是否委派、整合冲突、验证证据、生成最终交付和执行外部动作。
- Meeting Intelligence 是会议语义状态源，不是另一个聊天 Agent。
- Sub-agent 是一次性、任务型、fresh context 的只读核验者，不拥有发布或生产写权限。
- Dynamic Workflow 只在存在多个独立核验轴时使用；并行度、Agent 数量和 retry 必须有界。
- `meeting-memory-curator` 是持久角色、fresh 单次子进程，不是常驻 LLM，也不是 Dynamic Workflow；它只提出结构化候选，无写入和发布权限。
- Pi 原生 Compaction 负责当前父会话的短期压缩；项目长期记忆只接受父 Agent 验证并持久化的候选，两者不能混为一个状态源。
- `agent-team-runtime` 仅为本地兼容 fallback，不再是会议 Agent 的主编排架构。
- Tool 完成事件只证明调用发生；只有父级 reconciliation 通过，子 Agent 结果才能进入写作与 QA。

## 会议证据规则

- 默认使用 `参会人 A/B/...`，不要根据声纹猜姓名。
- 用户给出 `参会人 A=张三` 时采用显式映射；未给实名不阻塞。
- 区分 proposed、discussion、objection、agreed、rejected、unresolved。
- `quality=needs_review` 可形成风险或待确认，不能单独确定决策、owner、日期、金额或承诺。
- 单录混音 diarization 是 speaker 聚类，不是声源分离；高重叠同时发言不得承诺完整恢复。
- 任何 sub-agent/workflow 返回的 segment id 都必须属于当前 transcript。跨会议 id、缺少 evidenceSegmentIds 的事实性发现进入 QA blocking finding。

## ASR 规则

- 默认 `MEETING_ASR_PROVIDER=auto`：DashScope/OSS 配置完整时优先云端文件 ASR；本地 `local_qwen3` 是显式 fallback/provider option。
- 文件端使用 DashScope HTTP transcription + OSS，支持完整文件格式矩阵；实时流使用独立 WebSocket endpoint。
- 只有 provider 拒绝容器或本地模型需要时才重封装/转码；不得把模型输入约束暴露为产品格式限制。
- 云端与本地 cache key 必须包含 provider/model/mode/diarization 等配置，不能相互污染。
- 云端失败必须区分鉴权、网络、模型、格式、超时和 partial；不得把 partial transcript 当完整会议生成纪要。

## 内容与凭证边界

- 会议内容可以进入选定的 ASR、模型、sub-agent、workflow、文档、QA 和记忆整理能力。
- 分段、检索、offload 与 bounded preview 是上下文质量和性能机制，不是内容隐私阻断。
- API Key、Token、Cookie、Authorization、App Secret、签名 URL 和登录会话永远不得进入 prompt、普通日志、会议产物或长期记忆。
- `lark-cli auth status --verify` 只通过 `auth-status-summary` 暴露安全摘要；其他可能含凭证的 CLI 输出使用 `secret-scan`。
- 删除、通知他人、日历/任务变更、客户可见发布、权限扩大和依赖安装由 Policy Gate 处理。

## 文档维护

- 当前事实只在 `README.md`、本文和 `wiki/` 根层专题文档维护。
- `wiki/issues/`、`plan/`、`problem/`、`retrospective/`、`thinking/` 是历史证据；新增内容必须带日期与状态，不得自称当前规范。
- 架构变化必须同步更新 `wiki/02-agent-architecture.md`、`wiki/11-current-project-architecture.md` 和必要的 Mermaid 图。
- 不在多个文档复制长命令、完整环境变量列表或组件表；以代码/runtime JSON 为真相源，文档提供语义解释和链接。

## 完成与验证

修改完成前至少运行：

```bash
python3 src/validate_workspace.py
cd meeting-agent-pi-package && npm test
python3 meeting-agent-pi-package/tools/local_ci_check.py
git diff --check
```

声明完成必须说明：用户可见结果、真实运行证据、未验证项和残余风险。不要用文件数量或测试数量代替产品完成度。

## 禁止事项

- 提交 `.env.local`、模型/OSS/飞书凭证、录音、转录或 `runtime-runs/`。
- 将文件端 ASR 与实时流 ASR 混为同一 endpoint。
- 用 mock、fallback 或计划文件冒充真实 sub-agent/workflow 执行。
- 用多数投票创造会议事实，或让子 Agent 绕过父级证据回收。
- 让记忆子 Agent 自行写文件、修改生产 prompt/skill，或让 Docker worker 执行飞书发布。
