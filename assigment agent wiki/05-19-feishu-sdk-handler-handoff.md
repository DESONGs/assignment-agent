# 05/19 Feishu SDK Handler Handoff

> 维护状态：历史 handoff。当前实现以 `wiki/11-current-project-architecture.md` 和
> `wiki/12-feishu-agent-bidirectional-integration-plan.md` 为准。本文中提到的
> `runId` 是 HTTP/local artifact 追踪字段，不应出现在飞书用户可见回复中；
> gateway/handler 现在必须返回“已接受任务/已完成处理”等用户语义文本。

## 背景

本 side thread 已确认飞书开放平台长连接配置可用：用户在飞书里给机器人发送消息后，机器人已能返回消息。这说明链路已经打通到：

飞书客户端 -> 飞书开放平台事件 -> 本地 SDK long connection gateway -> 机器人回复。

本轮进一步把旧的“收到消息 / 后续接入 PI agent”确认回复升级为 handler 驱动的任务处理回复，同时保持现有架构边界。

## 本轮改动

### `meeting-agent-pi-package/tools/feishu_bot_event_gateway.mjs`

- gateway 仍只负责 SDK 长连接、事件标准化、转发 handler、发送即时回复。
- 如果配置了 `FEISHU_BOT_HANDLER_URL`，默认优先使用 `http` handler 模式，不再需要显式设置 `FEISHU_BOT_REPLY_MODE=http`。
- handler 返回 `status/runId/documents/publishStatus/replyStatus` 时，gateway 会转换为飞书可读文本。
- 移除旧兜底语义：handler 已配置时，不再回复“后续可通过 FEISHU_BOT_HANDLER_URL 接入 PI agent 处理”。
- 新增 `FEISHU_BOT_HANDLER_TIMEOUT_MS`，默认 `20000` ms。
- 标准化事件增加 `schemaVersion: feishu-event-v1`、`source: sdk-long-connection`、`message.attachments`，兼容 handler 已有 normalized event 输入。

### `meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs`

- handler 仍负责 run artifact、附件解析、PI task 创建、PI pipeline 调用、publish plan、reply plan。
- HTTP 响应新增 `text` 字段，供 SDK gateway 直接回复飞书。
- HTTP 响应新增 `summary`、`documents`、`publishStatus`、`replyStatus`。
- 新增 `--async` / `FEISHU_AGENT_ASYNC=1`：
  - handler 先返回 `202 accepted + runId`；
  - 后台继续跑 `handleEvent(...)`；
  - 适合真实 PI pipeline 时间较长，避免 SDK gateway 等待超时。
- 如果 handler 自己已经 live 回复成功，返回 `suppressGatewayReply=true`，避免 gateway 二次回复。

## 当前架构边界

- `feishu_bot_event_gateway.mjs`：入口层，只保持长连接、转发和即时回复，不生成文档、不调用 PI、不发布飞书文档。
- `feishu_agent_task_handler.mjs`：任务桥接层，创建本地 run artifact，调用 PI，读取 manifest，执行 publish/reply。
- PI runtime：仍负责 Planner、Capability Registry、prompt registry、document workers、QA Gate、Policy Gate。
- `feishu_event_runner.mjs`：CLI-first 入口仍可用，继续转发到同一个 handler。

本轮没有改动 prompt registry、document worker、QA Gate、Policy Gate 或模型 provider。

## 推荐运行方式

本地 handler，先 dry-run：

```bash
FEISHU_AGENT_EXEC_MODE=execute \
FEISHU_AGENT_ASYNC=1 \
FEISHU_AGENT_PUBLISH_MODE=dry-run \
FEISHU_AGENT_REPLY_MODE=dry-run \
node meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs
```

SDK gateway：

```bash
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
node meeting-agent-pi-package/tools/feishu_bot_event_gateway.mjs
```

关键 env：

```bash
FEISHU_APP_ID=...
FEISHU_APP_SECRET=...
FEISHU_BOT_HANDLER_URL=http://127.0.0.1:8788/feishu/events
FEISHU_AGENT_ASYNC=1
```

确认 dry-run 产物正常后，再考虑：

```bash
FEISHU_AGENT_PUBLISH_MODE=live
FEISHU_AGENT_REPLY_MODE=live
```

## 已执行 QA

- `node --check meeting-agent-pi-package/tools/feishu_bot_event_gateway.mjs` passed。
- `node --check meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs` passed。
- `node --check meeting-agent-pi-package/tools/feishu_event_runner.mjs` passed。
- `python3 src/validate_workspace.py` passed。
- 直接 POST handler fixture passed：
  - 返回 `status: completed`
  - 返回可读 `text`
  - dry-run 生成 PRD、Ops、Architecture、Checklist 四份文档计划。
- `feishu_event_runner -> handler` fixture passed：
  - runner 正常 forward；
  - handler 返回可读任务结果；
  - 会议纪要 dry-run 文档计划生成。
- async handler fixture passed：
  - 返回 `202 accepted`
  - 返回 `runId`
  - 后台 state 最终为 `completed`，步骤包含 `event_normalized`、`attachments_resolved`、`task_created`、`pi_agent_pipeline`、`feishu_publish`、`feishu_reply`。

测试 artifact 在：

```text
runtime-runs/feishu-agent-side-smoke/runs/
```

## 主线程接手建议

1. 重启当前正在跑的 gateway/handler，确保加载本轮代码。
2. 先用 `FEISHU_AGENT_EXEC_MODE=mock` 在真实飞书消息里验证机器人返回的是“已接受任务/已完成处理”等用户语义文本，而不是本地 `runId`、文档计划或旧确认句。
3. 再切到 `FEISHU_AGENT_EXEC_MODE=execute` + `FEISHU_AGENT_ASYNC=1`，确认 PI pipeline 能写 `agent-output.json`。
4. 最后再切 `publish/reply` 到 `live`，验证飞书文档发布和消息回复权限。

## 风险与注意

- 真实 PI pipeline 可能超过 20 秒，因此 live 建议开启 `FEISHU_AGENT_ASYNC=1`。
- 如果 handler 的 `FEISHU_AGENT_REPLY_MODE=live` 已经回复，gateway 会根据 `suppressGatewayReply=true` 不再重复回复。
- 原始音视频仍应只本地处理；本轮没有改变 raw media 外发策略。
- 现有 live 发布仍依赖 `lark-cli` 的 auth/keychain、Drive/Markdown/IM 权限和 `FEISHU_AGENT_FOLDER_TOKEN`。
