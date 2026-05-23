# Feishu 音频纪要与发布策略过度保守缺口

## Summary

真实飞书测试中，用户上传 `.wav` 录音后回复“形成会议纪要”，Agent 收到并下载了音频文件，但由于飞书把录音作为 `resourceType=file` 传入，handler 先相信 `file` 类型，导致 `.wav` 被 `file-context` 判为 `unsupported_file_type`。同时，“形成会议纪要”没有触发父消息/root 消息附件回溯，纯文本回复事件会被标记为 `no_file_reference`。

另一个问题是发布策略过度保守：用户已经明确要求“撰写/发布/放到云端文件夹”时，`publish_customer_visible` 仍可能返回 `needs_confirmation`，造成文档生成后无法默认发布。

## Impact

- 音频会议纪要任务无法稳定进入 local ASR。
- 回复音频父消息的自然语言任务无法关联上一条录音。
- 用户明确要求生成并发布时，仍可能被 Policy Gate 阻断。

## Root Cause

- `attachmentKind` 按 `resourceType` 优先，覆盖了 `.wav/.mp3/.m4a` 等扩展名。
- 文件引用正则只覆盖“文件/附件/PDF/Word/Excel”等文本文件表达，未覆盖“会议纪要/录音/音频/转写/minutes”。
- Policy Gate 将 `publish_customer_visible` 统一视为需确认动作，没有区分 Feishu inbound 中用户显式请求的非删除写入。

## Fix Plan

- 音频扩展名优先识别为 `audio`；视频和图片素材直接不支持。
- 将会议纪要、录音、音频、转写等表达纳入父消息/root 消息和最近附件缓存解析。
- 音频 file-context 使用 `local_asr_only`，不外发 raw audio。
- Feishu inbound 明确请求创建、撰写、保存、发布、放到云端或覆盖修改时，非删除类 `write_private` / `publish_customer_visible` 默认通过。
- 删除、清空、移除、销毁类动作始终 blocked。
- 发布默认复用当前 chat/thread 会话目录；明确 file token/link 的修改使用 `markdown +overwrite`。

## Acceptance

- `.wav` 文件消息无文本时只缓存音频并回复可继续发送处理要求。
- 回复 `.wav` 父消息“形成会议纪要”时，`taskType=meeting_minutes` 且 `requiresLocalAsr=true`。
- 图片和视频素材回复 `目前暂不支持该功能`。
- 用户明确要求发布/放到云端时，QA pass 后自动创建或更新飞书文档。
- 任意 delete/trash/remove/purge 类操作不出现在 planned/live commands。
