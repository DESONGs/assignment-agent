# Feishu Wiki 与 Hermes Wiki 权限前置条件

## Status

Partially resolved.

- User deliverables Wiki: resolved for current local user flow. 2026-05-23 live verification created/reused the real Feishu Wiki Space `PI Agent 项目知识库` and mounted project deliverables under `项目｜抖音私信 AI 客服方案`.
- Hermes Wiki: still open/configuration-dependent. It must keep using a separate target (`HERMES_WIKI_SPACE_ID` or `HERMES_WIKI_ROOT_NODE_TOKEN`) and must not publish into the user deliverables Wiki.

## Context

用户交付物发布主路径改为 Feishu Wiki。当前实现已增加 Publish Taxonomy / Project Workspace：同源会议纪要、PRD、技术架构、Checklist 等文档按项目组织到真实 Wiki Space，而不是按 `runId` 或 `feishu-chat-*` 文件夹命名。Hermes 思考库默认 Gate pass 后尝试自动入库单独 Hermes Wiki。

## Required Permissions

用户交付物 Wiki：

- `wiki` 节点创建、移动、读写权限。
- `markdown +create` 创建文档权限。
- `wiki +move` 将 Drive 文档挂载到 Wiki 的权限。
- 如需读取用户提供的云文件，还需要 `drive:file:download` / `drive:file:readonly`。

Hermes 思考库：

- 单独 `HERMES_WIKI_SPACE_ID` 或 `HERMES_WIKI_ROOT_NODE_TOKEN`。
- 与用户交付物 Wiki 分离，避免学习材料混入客户交付资料库。

## Runtime Behavior

- `FEISHU_AGENT_PUBLISH_TARGET=auto` 时，Wiki 不可用会记录 `wiki_publish_blocked_drive_fallback` 并 fallback 到 Drive。
- Publish Taxonomy 会生成 `projectTitle/projectKey/sourceThreadKey` 和项目树；`feishu_publish_organize_cli.mjs apply --live --no-delete` 可对历史发布执行无删除重整。
- 当前 canonical 用户交付 Wiki Space：`PI Agent 项目知识库`。项目节点采用 `项目｜{projectTitle}`，分类节点按 `会议纪要 / PRD / 技术架构 / 客户需求确认 / To-do` 动态创建或复用。
- 用户可见 Wiki 文档标题不得使用 Feishu token、`feishu file 00 ...`、normalized audio 文件名、runId 或 generic upload filename；展示名应由项目名、文档类型、业务用途和 run 时间戳组成。
- `HERMES_WIKI_AUTO_PUBLISH=1` 且缺少 Hermes target 时，`hermes-wiki-publish.json` 记录 `hermes_wiki_publish_blocked_missing_target`，不会写入用户交付 Wiki。

## Verification

- `lark-cli wiki +space-list --as user --format json`
- dry-run run 生成 `wiki-publish-plan.json` 与 `wiki-publish.json`。
- `node meeting-agent-pi-package/tools/feishu_publish_organize_cli.mjs inventory`
- `node meeting-agent-pi-package/tools/feishu_publish_organize_cli.mjs plan`
- `node meeting-agent-pi-package/tools/feishu_publish_organize_cli.mjs apply --live --no-delete`
- 2026-05-23 live verification: `PI Agent 项目知识库 / 项目｜抖音私信 AI 客服方案` 下已验证 `会议纪要(2) / PRD(2) / 技术架构(1) / 客户需求确认(2)`，共 7 份文档。Drive 侧部分旧文件夹移动返回 Feishu `source parent no permission`，无删除、旧 URL 保留。
- `python3 hermes-learning-sidecar/sidecar.py --run-dir <runDir> --out <out>` 生成 `hermes-wiki-candidate.json`、`hermes-wiki-reflection-gate.json`、`hermes-wiki-publish.json`。
