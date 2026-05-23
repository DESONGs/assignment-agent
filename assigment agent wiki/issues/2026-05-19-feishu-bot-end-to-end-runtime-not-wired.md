# Feishu Bot End-to-End Runtime Live Smoke Blocked

## Summary

飞书机器人端到本地 Agent 的代码闭环已补齐，live smoke 仍受本机 `lark-cli` auth/keychain 和飞书开放平台权限约束。当前仓库已有 `feishu_event_runner.mjs`、`feishu_bot_event_gateway.mjs`、`feishu_agent_task_handler.mjs`、runtime schema 和 `feishu-agent-bridge` skill；fixture/mock QA 可验证 runner/gateway -> handler -> PI task -> dry-run publish/reply。

## Trigger Scenario

用户希望在飞书中给机器人发送指令或上传会议录音，然后本地 Agent 自动生成会议纪要和相关 PRD/运营/技术/确认表文档，并在飞书中创建对应文档或文件夹后回复结果。

## Current Evidence

- `lark-cli` 已安装，`docs` 和 `im` help 可用。
- 2026-05-19 复测 `lark-cli auth status --verify` 仍返回非 0，错误为 keychain 未初始化；当前未确认可主动写飞书，这属于 live smoke 环境阻塞。
- `.env.local` 当前未配置 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`。
- `@larksuiteoapi/node-sdk` 当前未安装在 `meeting-agent-pi-package`。
- 本机未发现运行中的 `feishu_bot_event_gateway.mjs` 或 PI bot handler 进程。
- `feishu_bot_event_gateway.mjs` 配置 loopback `FEISHU_BOT_HANDLER_URL=http://127.0.0.1:8788/feishu/events` 后默认转发 handler；未配置 handler 时才返回 diagnostic/echo。
- `FEISHU_AGENT_ASYNC=1` 已支持 `202 accepted + runId`，用于真实 PI pipeline 超过 gateway timeout 的场景。
- `feishu_agent_task_handler.mjs` 已实现 handler：接收 normalized event，生成 Planner/document pipeline task prompt，处理附件 manifest，读取 QA/Policy 后生成 publish/reply artifact。
- 文件、音频、视频消息资源下载已在 handler 中接入 `lark-cli im +messages-resources-download` planned/live 路径；fixture 可用 `localPath` 验证 hash 和 local-only 边界。
- 2026-05-19 live smoke 已收到真实 `im.message.receive_v1` 群聊文本事件，并生成 run artifact。
- 2026-05-19 live reply 已通过：`lark-cli im +messages-reply --as bot --text ...` 可回复真实消息。
- 2026-05-19 live publish 以 `--as user` 通过：mock-agent 路径创建了 4 份 Markdown 文件。bot 身份仍缺 `space:folder:create` / `drive:file:upload` scopes。
- 2026-05-19 PI execute 仍阻塞：`PI_PROVIDER=deepseek` 返回 403/402，`PI_REVIEW_PROVIDER=xiaomi-token-plan-sgp` 返回 membership/benefits 402。
- 2026-05-20 文件任务复盘：用户在同一会话上传 PDF 后发送“分析该文件”时，触发 Agent 的事件可能是纯文本且 `attachments=[]`。已补 `file-context` 与最近附件缓存，同 chat/sender/thread 30 分钟内可关联；无法关联时要求重新上传或同消息附带文件。
- 2026-05-20 已补不支持策略：图片理解、未接入写操作、无法识别文件类型等直接回复 `目前暂不支持该功能`。

## Impact

- 代码层面和真实飞书端均可触发本地 handler 并生成 run artifact；真实内容生成仍受 PI provider 会员/权限阻塞。
- 录音 fixture/localPath 可进入 local-only artifact；真实飞书附件下载仍需资源下载权限。
- 本地 mock 任务可通过 CLI user 身份创建飞书 Markdown；bot 身份发布仍需补 Drive scopes。

## Root Cause

原问题是能力拆成三层但只落地前两层；本轮已补齐第三层代码：

1. `feishu_cli`：主动操作飞书资源。
2. `feishu_bot_event_gateway.mjs` / `feishu_event_runner.mjs`：接收或消费消息事件并转发。
3. `feishu_agent_task_handler.mjs`：本地 PI/agent HTTP handler，负责消息解析、附件下载、Planner 调度 task、QA/Policy Gate 输出、飞书发布和回复。

## Fix Plan

1. 已实现 CLI-first runner：`feishu_event_runner.mjs`。
2. 已实现本地 handler：`feishu_agent_task_handler.mjs`。
3. 已实现附件下载 planned/live 路径和 local fixture hash。
4. 已实现 dry-run/live publish 分层：`drive +create-folder`、`markdown +create`、`drive +upload`、`im +messages-reply`。
5. 已 live：SDK gateway 收到真实消息，bot reply 权限通过，CLI user publish 权限通过。
6. 已修复：Feishu 文件上下文进入 `file-context`，支持 PDF/Word/Excel/Markdown/TXT/CSV 文本型文件、后续“该文件”指代关联和 direct answer 无文档发布路径。
7. 待验证：真实 PDF/Word/Excel live 文件下载权限、PI provider CLI 指向 `PI_CLI_BIN` 后的真实内容生成；bot Drive scopes（如需 bot 身份发布）。

## Verification Plan

- `python3 src/validate_workspace.py` 通过。
- `node --check meeting-agent-pi-package/tools/feishu_event_runner.mjs` 和 `feishu_agent_task_handler.mjs` 通过。
- Fixture text event 能生成 `event.json`、`task.json`、`state.json`、`agent-task.md`、`agent-output.json`、`publish.json`、`reply.json`。
- Fixture file/audio event 能验证附件 manifest、本地 hash、`file-context.json`、最近附件缓存、raw media 不外发。
- Unsupported fixture 必须回复 `目前暂不支持该功能`。
- live smoke 仍需 `lark-cli auth status --verify` 脱敏通过后执行。

## Status

Code path fixed. Remaining status: live receive/reply/user-publish works; real PI content generation is blocked by provider membership/permission, and bot publish still needs Drive scopes.
