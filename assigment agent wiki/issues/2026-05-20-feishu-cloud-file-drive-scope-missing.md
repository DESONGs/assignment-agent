# Feishu 云文件读取被 Drive Scope 阻塞

## Status

Open: configuration / permission issue.

## Symptom

用户在飞书中发送云文件链接或云文件卡片，并要求基于该 Markdown 文件生成 PRD、技术架构和客户 checklist。Handler 成功解析到 `https://www.feishu.cn/file/<token>`，但回复：

> 当前文件无法读取，请重新上传或确认权限。

## Root Cause

`lark-cli drive +download --as bot --file-token <token>` 返回 Feishu OpenAPI `99991672`。

错误含义：当前应用身份没有开通云空间文件读取/下载 scope。返回信息列出的可用 scope 包括：

- `drive:drive`
- `drive:drive:readonly`
- `drive:file:readonly`
- `drive:file`
- `drive:file:download`

这说明不是多源路由或 recent-cache 问题。文件 token 已被解析，阻塞点是 bot/app 的 OpenAPI 权限。

## Fix Needed

在飞书开放平台为当前应用开通至少一个文件读取/下载权限，推荐最小权限：

- `drive:file:download`
- `drive:file:readonly`

开通后需要重新发布应用，并确保租户/管理员审批完成。随后重试同一文件链接。

## Runtime Change

Handler 已将 `99991672` 映射为更明确的用户提示：

> 当前机器人缺少飞书云文件读取权限，请在飞书开放平台为应用开通云空间文件读取/下载权限后重试。

## Regression Check

- 显式 Feishu file URL 必须解析成 `explicit_feishu_file_url` source reference。
- 缺少 drive scope 时不能 fallback 到 recent cache。
- `task.json` 中 attachment `reason` 应为 `feishu_drive_scope_missing`，并记录 `errorCode=99991672` 和 required scopes。
