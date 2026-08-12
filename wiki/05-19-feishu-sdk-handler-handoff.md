# 2026-05-19 飞书 SDK Handler Handoff（历史）

状态：已归档，2026-08-12。

本文原先记录 SDK 长连接与 handler 初次打通时的 handoff。相关实现已经继续演进，旧命令、旧 ASR 边界、旧测试数量和旧发布假设不再作为当前规范。

当前入口：

- [飞书双向 Agent 集成规范](12-feishu-agent-bidirectional-integration-plan.md)
- [当前项目架构与代码映射](11-current-project-architecture.md)
- [测试与发布验收](07-test-plan.md)

仍然有效的历史结论只有：SDK gateway 与 CLI event runner 应转发到同一个 handler；gateway 不生成会议内容；长任务需要异步接受与最终回复分离；handler 已回复时必须抑制 gateway 重复回复。
