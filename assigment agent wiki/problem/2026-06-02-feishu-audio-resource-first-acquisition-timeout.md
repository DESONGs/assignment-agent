# Feishu 音频首次附件获取超时与身份兜底缺失复盘

Status: fixed / historical

## 现象

用户在 Feishu 中对音频文件发送“生成会议纪要”，机器人返回：

```text
音频附件下载失败，暂时无法转写。已尝试复用本地缓存但未命中。失败原因：当前文件无法读取，请重新上传或确认权限。。
```

代表性失败文件：

```text
record-20260602-175319-3c.wav
```

代表性失败 run：

```text
runtime-runs/feishu-agent/runs/feishu_2026-06-02T10-22-00-341Z_om_x100b6edea2b8d4acb11edf9ff56985d
```

同一时间相邻音频 `record-20260602-170933-f2.wav` 已成功生成并发布会议纪要，说明 handler、ASR、document worker 和发布链路当时可用。

## 根因

失败音频的父消息 metadata 能被解析：

```json
{
  "fileKey": "file_v3_00129_4e07cf38-bd70-4c79-9486-c3819ac8092g",
  "sourceMessageId": "om_x100b6edea2a4913cb3649bda9dd4cd6",
  "name": "record-20260602-175319-3c.wav"
}
```

但首次下载没有成功落到本地：

```json
{
  "downloadStatus": "failed",
  "exitCode": 128,
  "stderrTail": "cannot create file: context deadline exceeded"
}
```

对应 run 的 `inputs/attachments/` 为空，runtime store `find-source` 返回 `not_found`。这与上一轮“历史本地复用缺口”不同：上一轮已有历史 MP3/CAS 可用，本次失败文件没有任何 ready artifact。

旧链路问题：

1. 普通 IM 附件下载固定使用 `--as bot`，没有 user 登录态兜底。
2. `context deadline exceeded` 只执行一次下载尝试，未做有限 retry。
3. 短期 attachment cache 只保留 metadata，未记录 `sourceReady=false`、失败分类和下载尝试。
4. `source_acquisition_gate` 能阻断长链路，但 failure report 缺少具体 `failureClass/downloadAttempts`。
5. 用户可见文案泛化为“当前文件无法读取”，且出现中文双句号。

## 修复

已完成以下修复：

1. 新增 IM resource 下载失败分类：
   - `feishu_resource_download_timeout`
   - `feishu_resource_permission_denied`
   - `lark_cli_unavailable`
   - `feishu_resource_not_found`
   - `attachment_download_failed`
2. 默认附件下载身份顺序改为 `bot,user`，可用 `FEISHU_AGENT_ATTACHMENT_DOWNLOAD_AS` 覆盖。
3. 新增 `FEISHU_AGENT_ATTACHMENT_DOWNLOAD_MAX_ATTEMPTS`，默认每个身份最多尝试 2 次。
4. `downloadAttachments()` 对每次下载写入 `downloadAttempts[]`，包含 identity、attempt、exitCode、timedOut、failureClass、retryable、stderrTail。
5. bot 失败后 user 成功时记录 `downloadStatus=downloaded_identity_fallback` 和 `downloadAs=user`。
6. 同身份重试成功时记录 `downloadStatus=downloaded_after_retry`。
7. 文件消息首次下载失败时，短期 attachment cache 保留 metadata，但标记 `sourceReady=false`、`lastFailureClass`、`lastDownloadAttempts`，不把失败路径当成本地可读文件。
8. attachment cache TTL 改为优先使用 `receivedAt`，避免 Feishu `createTime` 与本机时间偏差导致失败 metadata 刚写入就被剪掉。
9. 后续回复 run 会重新尝试下载，不会把失败 cache 误判为 ready source。
10. `source_acquisition_gate` 写入 `failureClass/downloadAs/downloadAttempts/retryable` 到 `agent-output.json.finalFailureReport`。
11. 用户回复使用具体 failure class 对应文案，并修复双句号。

## 验证

静态检查已通过：

```bash
node --check meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs
node --check meeting-agent-pi-package/tools/im_file_context_helpers.mjs
python3 src/validate_workspace.py
python3 meeting-agent-pi-package/tools/local_ci_check.py
```

`local_ci_check.py` 结果为 `passed_with_environment_blockers`，无代码失败项；唯一 blocker 是 `swift_toolchain_sdk_mismatch`。

本地证据：

- 失败 run 的附件目录为空，确认不是 ASR 或文档生成失败。
- runtime store 对失败 fileKey/sourceMessageId 查询为 `not_found`。
- 相邻成功文件查询返回 ready raw media candidate，证明长期复用链路有效。

Fixture 验证：

- `feishu_fixture_identity_fallback_20260602`：fake `lark-cli` 模拟 bot 超时、user 成功，最终 `downloadStatus=downloaded_identity_fallback`、`downloadAs=user`、`source_acquisition_gate=pass`。
- `feishu_fixture_identity_fallback_all_fail_20260602_c`：fake `lark-cli` 模拟 bot/user 都超时，最终 blocked 在 `source_acquisition_gate`，`finalFailureReport.failureClass=feishu_resource_download_timeout`，未进入 ASR/document worker/publish。
- 失败 fixture 的 `.feishu-attachment-cache.json` entry 保留 `sourceReady=false`、`lastFailureClass=feishu_resource_download_timeout` 和完整 `lastDownloadAttempts`，且没有可误用的 `localPath`。

## 残余风险

- 如果 bot/user 两个身份都无法读取该 Feishu 资源，系统会明确 blocked 并要求重传或确认权限，不会外发 raw audio 或进入外部 ASR。
- Wiki 发布仍可能因为 Feishu wiki move scope/token 行为降级到 Drive fallback；该问题不影响音频获取、ASR、文档生成和飞书回复。

## 后续 Regression

Fixture `feishu_fixture_identity_fallback_20260602` 后续被发现使用真实 `fileKey/sourceMessageId` 写入生产 runtime store，并把 17-byte fake `.wav` 标为 `ready/raw_media`。该污染导致后续 live run 复用假音频并在 audio normalize 阶段报“音频格式暂不支持自动转码”。该问题不是本页下载 retry 逻辑本身的失败，已在 `2026-06-02-feishu-fixture-artifact-polluted-runtime-store.md` 和 `2026-06-02-runtime-store-fixture-artifact-quarantine.md` 中单独修复：fixture artifact 已 quarantine，生产 `find-source` 默认排除 fixture/mock/dry-run，并增加 raw audio header/min-size 校验。

## Live Completion

2026-06-03 已完成同一父消息 live retry：

- `lark-cli` 已从 `1.0.32` 升级到 `1.0.46`。
- 新增附件下载专用超时 `FEISHU_AGENT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS`，默认 `900000ms`；普通 CLI 操作仍保留较短默认超时。
- Live run `feishu_2026-06-03T06-48-24-686Z_om_x100b6ed9882e18a4b2cd428917948fc` 成功下载 `record-20260602-175319-3c.wav`。
- bot 两次失败后，user fallback 成功，状态为 `downloaded_identity_fallback`。
- 本地 ASR 完成 `42/42` chunks，`failedChunks=0`。
- 会议纪要生成、QA/Policy、Drive fallback 发布和飞书回复均完成。
- 发布 URL：`https://r0q4yoqkms3.feishu.cn/file/W4oRb7vNJogTZcxylCIcGHW2nLc`。
