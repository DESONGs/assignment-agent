# 运维复盘

更新时间：2026-05-22

## 复盘结论

本项目的运维复杂度主要来自四类本机依赖：飞书 CLI 登录态、模型 provider 配置、本地 MLX/Metal ASR 服务、Docker/Redis 后台 worker。复盘后的运维原则是：Host-owned 能力由 Host 管，Docker 只做受限后台执行；环境类问题必须以明确 blocker 呈现，不能被误报成代码缺陷。

## 配置入口

项目人工运行配置入口是 `.env.local`。它负责本地 provider、模型和运行策略配置；飞书登录态由官方 CLI 管理，不写入项目文件。

运维要求：

- `.env.local` 不进入 wiki 示例的真实值。
- `.pi/settings.json` 只声明 PI package，不保存 provider 真实凭据。
- 进入模型上下文的飞书认证检查只能是脱敏摘要。
- 任何环境检查都只报告可用性、错误类别、缺失项和下一步，不输出敏感原文。

## 本地 ASR 运维

本地 ASR 是 Host-owned 服务，不属于 Docker worker。

原因：

- Qwen3-ASR 依赖 macOS MLX/Metal。
- Codex sandbox 或 headless 环境可能无法访问 Metal。
- 原始音频只允许进入本地 ASR，不走外部兜底。

推荐运维命令入口：

```bash
python3 meeting-agent-pi-package/tools/local_asr_service_ctl.py status
python3 meeting-agent-pi-package/tools/local_asr_service_ctl.py start
python3 meeting-agent-pi-package/tools/local_asr_service_ctl.py stop
```

运行策略：

- `audio_minutes` 执行前先做 ASR health preflight。
- 服务不可达时返回 `local_asr_service_not_running`，并提示启动命令。
- cache hit 时不需要健康检查。
- 服务不可用不触发外部 ASR，也不进入 Docker。

## Docker 与 Redis 运维

本地 Docker 用于受限执行面：

```bash
docker compose -f docker-compose.local-runtime.yml up -d runtime-queue pi-document-worker hermes-worker
```

职责划分：

- Redis 是临时队列，不是长期存储。
- `pi-document-worker` 只处理 bounded document job。
- `hermes-worker` 只生成 learning proposal，默认不写外部知识库。
- Docker worker 不调用飞书 CLI、不发布、不回复、不写 Host-owned SQLite。

故障处理：

- Redis 不可用时，worker job 应标记 blocked 或 retry-later。
- 不应自动回退到 Host 长链路，避免重新引入不可观测长任务。
- Docker worker 失败后，由 Host handler 读取 artifact 并继续给用户明确回复。

## Feishu CLI 运维

飞书能力依赖官方 CLI、当前登录态和开放平台 scope。项目不自建飞书 Adapter。

常见状态：

- CLI 未安装：返回清晰安装/配置提示。
- 本机 keychain/profile 未初始化：标记为 live smoke 环境阻塞。
- bot 缺 Drive 读取权限：不能读取云文件，应提示开通文件读取/下载权限。
- Wiki 权限不足：用户交付物 fallback 到 Drive，并记录原因。
- 评论权限不足：`review-context.json` 记录评论线程不可读，不声称已处理评论。

运维重点是把权限问题说清楚，而不是用 recent cache、导出正文或 dry-run 掩盖。

## Provider 运维

Provider 问题应与代码问题分开记录。

已见过的阻塞包括：

- 主 provider 返回账号或权限类拒绝。
- 复核 provider 返回权益不可用。
- 诊断环境与 live handler 环境不一致，导致 replay 直接 fast blocked。

修复后的要求：

- runtime CLI 默认加载与 live handler 一致的本地 provider env allowlist。
- 只报告 loaded/missing key names，不输出真实值。
- provider 不可用时写入 model route 和最终 failure report。
- fallback 不可用时不要继续消耗长文档预算。

## 用户侧状态文案

用户侧文案需要稳定、少诊断、可行动。

推荐状态：

- 已接受
- 处理中
- 需要补充信息
- 已完成
- 暂不支持
- 失败，可重试

禁止在用户侧暴露：

- 本地 run id。
- QA/Policy 内部术语。
- handler 诊断堆栈。
- provider 原始错误详情。
- 本地路径和内部 artifact 结构。

音频任务修复后，async handler 的 accepted response 默认不直接给用户发可见 ACK；文件缓存事件默认静默，避免“文件已缓存”和“文档正在生成”重复提示。

## 常见故障排查

| 现象 | 优先判断 | 处理方式 |
| --- | --- | --- |
| 音频任务提示转写不可用 | 本地 ASR 服务未启动 | 运行 ASR status/start；确认 127.0.0.1:8765 health。 |
| 文件链接无法读取 | Drive scope 缺失 | 开通文件读取/下载权限，重新发布应用。 |
| Wiki 发布 fallback | Wiki 创建或移动权限缺失 | 检查 Wiki space 和 node 权限，保留 Drive fallback 记录。 |
| 文档生成 10 分钟后失败 | 长文档 provider 或上下文预算问题 | 查看 stream trace、attempts、checkpoint 和 final failure report。 |
| 文件任务用了旧音频 | 显式 source 未优先或缓存模态过滤缺失 | 检查 sourceReferences 和 recent cache filter。 |
| 用户看到重复 ACK | gateway 与 async handler 都回复 | 确认 suppressGatewayReply 和文件缓存静默策略。 |
| 评论修订未读取评论 | 评论 scope 不足或任务未进 revision profile | 检查 `review-context.json` 和 task intent。 |

## 已修复事项

- ASR health preflight 和 lifecycle CLI 落地。
- async ACK 默认静默，减少重复提示。
- 文件缓存事件默认静默最终回复。
- 附件下载前支持当前 run 和缓存本地复用。
- Document Worker 失败可通过 streaming trace、deadline 和 checkpoint 定位。
- runtime store indexer 提供 run/artifact 查询和 cleanup dry-run。

## 遗留风险

- ASR 服务仍需本机 daemon 管理，尚未形成用户级 UI。
- 飞书权限配置仍依赖开放平台和租户审批。
- Wiki 与 Hermes 思考库目标需要单独配置和验证。
- Docker worker 与 Host handler 的 env parity 需要持续检查。

## 后续建议

- 为本地 ASR、Docker worker、Feishu readiness、provider readiness 建立一键 status summary。
- 将常见 blocker 的用户文案和内部 issue code 固化到测试计划。
- 保持 Docker worker 不直接写 SQLite；Host post-run indexer 统一登记。
- 对 live smoke 建立前置检查清单，避免在权限不满足时误判代码失败。
