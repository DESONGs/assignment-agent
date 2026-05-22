# 项目开发复盘索引

更新时间：2026-05-22

## 复盘目标

本文档集复盘 Meeting Document Agent 从会议文件 MVP、飞书双向入口、文档生成、Hermes 学习侧车，到本地数据治理的阶段性开发过程。复盘重点不是重新描述需求，而是沉淀已经验证过的架构判断、运行经验、运维边界、问题修复和数据管理规则，给后续开发者或 agent 接手时作为快速入口。

本复盘只使用项目内已有材料：根目录开发规则、当前 wiki、`issues/`、`problem/`、Hermes sidecar 文档、本地运行与存储方案。不写入未脱敏会议全文、原始音视频、账号凭据、访问凭据或命令原始认证输出。

## 阅读顺序

1. [架构复盘](01-architecture-retrospective.md)
2. [项目运行复盘](02-project-runtime-retrospective.md)
3. [运维复盘](03-operations-retrospective.md)
4. [开发问题与修复专项复盘](04-development-issue-resolution-retrospective.md)
5. [数据管理复盘](05-data-management-retrospective.md)

## 资料来源

- `agent.md`
- `wiki/00-plan.md`
- `wiki/01-prd.md`
- `wiki/02-agent-architecture.md`
- `wiki/05-feishu-rokid-permissions.md`
- `wiki/06-agent-team-index.md`
- `wiki/11-current-project-architecture.md`
- `wiki/13-office-agent-product-technical-review.md`
- `wiki/14-local-data-storage-cache-backend.md`
- `wiki/issues/*.md`
- `wiki/problem/*.md`
- `hermes-learning-sidecar/README.md`
- `hermes-learning-sidecar/dependency-policy.json`

## 当前状态口径

| 状态 | 含义 |
| --- | --- |
| `fixed` | 代码或文档层修复已落地，并有静态、fixture 或本地回归依据。 |
| `fixed but needs live QA` | 首版实现已完成，但仍需要真实飞书、模型 provider 或长任务 live 回归确认。 |
| `open/configuration` | 主要阻塞来自飞书权限、Wiki 权限、本机登录态或 provider 权益配置。 |
| `environment blocker` | 环境或账号条件未满足，不应被误判为业务代码缺陷。 |

## 维护规则

- 新发现的问题继续写入 `wiki/issues/` 或 `wiki/problem/`，不要只更新复盘文档。
- 影响架构、权限、运行时、数据存储或 QA 的修复，应同步更新对应专题 wiki。
- 复盘文档只保留脱敏的工程结论、状态和路径，不保存原始输入正文、原始音视频或凭据。
- open blocker 不能在复盘中被描述成已解决；必须保留下一步配置或 live QA 条件。
