# Dynamic Worker Component Index

## 定位

本文只保留当前运行层需要的动态 worker 组件说明。旧的固定角色拆分已经删除：运行层不预设常驻 role，不把一组 agent 文档提前塞入上下文，而是由 PI Agentic Planner 根据当前任务选择 capability、工具和 worker。

会议纪要场景可以使用 scenario playbook：本地 ASR 和 evidence index 后，对长 transcript/full evidence 做 pointer-only offload；再按需启用动态 worker 组件；模型路由必须写入 `model-route.json`；最终发布前必须串行通过 QA gate 和必要的 Policy Gate。这个链路不是全局 fixed workflow，短任务不应自动加载 Feishu、Rokid、WebAccess/MCP 或 worker pool。

## 当前动态 worker 组件

运行层对应 `meeting-agent-pi-package/extensions/agent-team-runtime.ts`。组件只返回 JSON，不直接写文件、不发布飞书、不持久化记忆；主控负责整合、artifact 写入、QA gate、Policy Gate 和外部动作。

| Component | 触发场景 | 输出 |
| --- | --- | --- |
| `topic_map_extractor` | 长会议、多议题、需要章节展开 | `topicMap`、主题覆盖、证据指针 |
| `evidence_coverage_checker` | 需要检查结论是否有证据 | 覆盖缺口、unsupported claims 候选 |
| `entity_gate_checker` | 需要防跨会议实体污染 | unsupported entities、cross meeting terms |
| `feishu_readiness_checker` | 发布或写入飞书前 | 权限、目标、脱敏、阻断原因 |
| `document_shard_writer` | 文档 prompt handoff/readiness | 文档类型、prompt 指针、缺口，不内置章节 |
| `risk_open_question_extractor` | 需要行动项、风险、待确认问题 | risks、open questions、follow-up candidates |

多文档正式生成不走 `document_shard_writer` 写全文，而走 provider-backed document workers：

```text
document-router
  -> document-prompt-registry.json
  -> document_prompt_render_batch
  -> document_workers_run
  -> section batches
  -> merge / repair
  -> QA gate
```

## Registry 与 Observability

所有 worker/component 都必须被 Capability Registry 描述为 planner-selectable capability descriptions，而不是固定角色清单。registry 字段至少包含 `description`、`toolIntents`、`policy`、`observability`、`installState` 和 `securityReview`。

运行指标必须使用 `plannerDecisions`、`capabilitySelections`、`policyDecisions`、`workerDecisions` 和 `packageAudits` 解释为什么启用、跳过或拒绝某个 worker/package。不得记录 secret、token、App Secret、raw media、raw request body 或完整 raw transcript。

## 组件启用规则

- 简短私有草稿：通常只启用 core、prompt registry、doc writer，不启用 dynamic worker pool。
- 长会议纪要：可启用 topic map、evidence coverage、entity gate、risk/open question worker。
- 多文档生成：按文档并行，再由每个 document worker 内部分批生成 required sections。
- 飞书机器人不回应或飞书消息触发本地任务：优先启用 `feishu-agent-bridge`，用 CLI event runner / task handler / optional SDK gateway 处理，不把 MCP 判断为必需。
- SDK/MCP/官方文档查询：可启用 WebAccess/MCP，但必须记录 sources，并经过 Policy Gate 判断外部联网边界。

## 禁止行为

- 不把动态 worker 组件解释成 fixed roles。
- 不把旧角色文档恢复为运行时 prompt。
- 不在 worker 内执行发布、通知、日历、任务或安装依赖。
- 不在 worker 内读取或输出飞书 secret、CLI session、token、cookie。
- 不把没有证据的推断写成事实。
