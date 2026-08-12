# Meeting Agent Wiki

更新时间：2026-08-12。

本目录分为“当前规范”和“历史证据”。阅读当前项目时只以根层专题文档为准；日期化目录用于解释过去为什么做出某项选择，不代表当前行为。

## 当前规范

| 文档 | 作用 |
| --- | --- |
| [00-plan.md](00-plan.md) | 当前里程碑、已完成能力与下一步 |
| [01-prd.md](01-prd.md) | 产品用户、场景、范围和验收 |
| [02-agent-architecture.md](02-agent-architecture.md) | Agent 端专项架构，包含架构图、关系图、流程图和时序图 |
| [03-system-prompts.md](03-system-prompts.md) | System Prompt 分层与提示词契约 |
| [04-skill-design.md](04-skill-design.md) | Skill、extension、tool 与 package 的职责边界 |
| [05-feishu-rokid-permissions.md](05-feishu-rokid-permissions.md) | 飞书、Rokid、ASR、凭证和外部动作边界 |
| [06-agent-team-index.md](06-agent-team-index.md) | 父 Agent、会议 sub-agent 与 Dynamic Workflow 角色索引 |
| [07-test-plan.md](07-test-plan.md) | 当前自动测试、真实 smoke 和发布验收 |
| [11-current-project-architecture.md](11-current-project-architecture.md) | 代码目录、运行组件与 artifact 同步状态 |
| [12-feishu-agent-bidirectional-integration-plan.md](12-feishu-agent-bidirectional-integration-plan.md) | 当前飞书双向集成规范 |
| [13-office-agent-product-technical-review.md](13-office-agent-product-technical-review.md) | Office Agent 扩展边界与技术取舍 |
| [14-local-data-storage-cache-backend.md](14-local-data-storage-cache-backend.md) | runtime store、cache、CAS、retention 和 Docker 边界 |

## 历史证据

- `issues/`：已发现问题及修复证据；打开的问题以目录索引状态为准。
- `plan/`：日期化实施计划；完成后不再约束当前架构。
- `problem/`：问题分析过程。
- `retrospective/`：阶段复盘。
- `thinking/`：探索性分析和设计推演。
- `05-19-feishu-sdk-handler-handoff.md`：历史 handoff，已由当前飞书规范替代。

每个历史子目录都有自己的 `README.md`。进入日期化文档前先读该目录说明；旧状态、命令和约束不会被当前校验器当作产品事实。

历史文档中可能出现本地 ASR 优先、pointer-only 隐私门、旧固定 worker、旧 provider 状态等描述。它们只表示当时状态，不能覆盖 2026-08-12 当前规范。

## 真相源优先级

发生冲突时按以下顺序判断：

1. 当前代码、schema、runtime JSON 与 lockfile。
2. `README.md`、`agent.md`、本目录根层当前规范。
3. 自动测试与真实 run artifact。
4. 日期化历史文档。
