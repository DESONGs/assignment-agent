---
name: meeting-memory-curation
description: 完整音频会议通过 QA 后，按需调用单一 Meeting Memory Curator，并由父 Agent 验证和持久化长期记忆。
---

# Meeting Memory Curation

仅在 `audio_minutes` 已生成 model-validated Meeting Intelligence、最终会议纪要且 QA Gate 为 `pass` 时使用。它是会议交付后的非阻塞增强能力，不是所有任务都执行的固定阶段。

## 执行契约

- 使用 `pi-subagents@0.46.0` 的一个 `runs.run(...)`，agent 固定为 `meeting-memory-curator`。
- `context=fresh`、`agentScope=project`、child tools 仅 `read`；不调用 Dynamic Workflow，不创建常驻模型进程。
- 只向 child 提供当前会议的 Meeting Intelligence、最终纪要、QA、participant map 和完整 transcript 路径。
- Child 仅返回符合 `meeting-memory-candidates-v1` 契约的 JSON 候选，不写文件、不发布、不修改 prompt/skill。

## 父级验收

- 先验证顶层和 candidate schema；未知字段或缺少字段直接拒绝。
- project_fact、decision、terminology、open_question 必须是 high confidence，同时引用 Meeting Intelligence `sourceClaimIds` 和由 claim 持有的当前会议 `evidenceSegmentIds`。
- participant_identity 只能来自 `nameStatus=user_confirmed` 的显式映射。
- 拒绝低置信、越界 segment、needs_review/mixed evidence、普通行动项、未经确认提议、长段原文和 credential-like 内容。
- 完全重复不重写；同 `memoryKey` 不同内容写入 `conflicts.jsonl`，不覆盖当前 `MEMORY.md`。
- 父 Agent 是 `.pi/agent-memory/meeting-memory/` 的唯一写入者。任何 Curator、模型、解析或持久化失败只记录 blocked artifact，不阻塞纪要交付。Curation plan/result/events 是内部观测产物，不进入飞书交付附件列表。

当前会话的短期上下文由 Pi 原生 Compaction 负责；不要把 compaction summary 当作项目长期事实库。
