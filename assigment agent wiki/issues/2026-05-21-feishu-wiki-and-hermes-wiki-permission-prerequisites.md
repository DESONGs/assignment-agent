# Feishu Wiki 与 Hermes Wiki 权限前置条件

## Status

Open: depends on Feishu app/user Wiki permissions.

## Context

用户交付物发布主路径改为 Feishu Wiki，Hermes 思考库默认 Gate pass 后尝试自动入库单独 Hermes Wiki。

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
- `HERMES_WIKI_AUTO_PUBLISH=1` 且缺少 Hermes target 时，`hermes-wiki-publish.json` 记录 `hermes_wiki_publish_blocked_missing_target`，不会写入用户交付 Wiki。

## Verification

- `lark-cli wiki +space-list --as user --format json`
- dry-run run 生成 `wiki-publish-plan.json` 与 `wiki-publish.json`。
- `python3 hermes-learning-sidecar/sidecar.py --run-dir <runDir> --out <out>` 生成 `hermes-wiki-candidate.json`、`hermes-wiki-reflection-gate.json`、`hermes-wiki-publish.json`。
