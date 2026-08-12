> 历史快照：本文记录当时的定位过程，不代表当前实现。当前状态见 `../issues/README.md`。

# Feishu 音频任务重复下载、ASR 启动与重复提示问题复盘

日期：2026-05-22

## 背景

用户在飞书中先发送音频文件 `record-20260521-224648-60.wav`，随后回复该文件消息要求“生成会议纪要和后续 to do list”。运行过程中出现三类问题：

1. 交互层多次回复，且不同回复展示出不同状态。
2. 音频会议纪要 run 阻塞在 `local_asr_service_unavailable`。
3. 重跑 blocked run 时，目标 run 目录里已经存在完整 wav，handler 仍然重新调用 `lark-cli im +messages-resources-download` 下载同一文件。

本问题文档先记录现状、原因和修复边界；2026-05-22 已按文末“修复落地状态”完成代码侧收敛。

## 当前任务结果

涉及的两个 run：

- 文件消息 run：`feishu_2026-05-21T15-48-19-885Z_om_x100b6fc6dafdf0a0c43e11280947d7c`
- 回复指令 run：`feishu_2026-05-21T15-48-20-913Z_om_x100b6fc6daf664a0c37495af75c0eb9`

文件消息 run 被判定为 `file_context_cached / fast_answer / completed`，只做音频缓存确认。回复指令 run 被判定为 `meeting_minutes / audio_minutes`，恢复 ASR 后已完成转写、文档生成、QA、Policy、发布和回复。

最终发布结果：

- 文档：`会议纪要｜00 normalized 16k mono s16｜会议讨论｜待确认.md`
- 飞书链接：`https://www.feishu.cn/file/UGp9bWK8CoBdb7xJnJ1cqPeMn4b`
- 最终 run 状态：`completed`
- ASR 服务健康状态：`ok`，`lastStatus=complete`

## 问题一：重复下载与本地同文件复用缺口

### 现象

重跑回复指令 run 时，目标路径已经存在完整文件：

```text
runtime-runs/feishu-agent/runs/feishu_2026-05-21T15-48-20-913Z_om_x100b6fc6daf664a0c37495af75c0eb9/inputs/attachments/record-20260521-224648-60.wav
```

文件大小为 `55,343,218` bytes。但 handler 仍然启动：

```text
lark-cli im +messages-resources-download --as bot --message-id om_x100b6fc6dafdf0a0c43e11280947d7c --file-key ... --type file --output runtime-runs/.../record-20260521-224648-60.wav
```

下载过程中出现过临时文件：

```text
inputs/attachments/.record-20260521-224648-60.wav.*.tmp
```

这说明重复下载风险发生在进入 runtime store / CAS 之前。

### 代码原因

`downloadAttachments()` 对飞书消息附件的主路径是：

```text
event attachment with fileKey/sourceMessageId
-> lark-cli im +messages-resources-download
-> output to current run inputs/attachments
```

只有当 attachment 已经带 `localPath` 时才会跳过下载并标记 `downloadStatus=local`。真实飞书事件和 parent/cache 解析出来的附件通常只有 `fileKey`、`sourceMessageId`、`cacheSourceMessageId` 等元数据，不带可复用的本地路径或 CAS object pointer。

因此当前逻辑没有在下载前检查：

- 当前 run 目标路径是否已经存在完整文件。
- parent/root 文件消息 run 是否已经下载过同一 `messageId + fileKey`。
- `.feishu-attachment-cache.json` 或 `recent_sources` 是否能提供本地 artifact。
- runtime store 中是否已有同 SHA/CAS object 可 hardlink 到当前 run。

此外，`downloadAttachments()` 对 lark-cli 下载结果的成功判断是 `exitCode === 0 && existsSync(localPath)`。如果 lark-cli 返回失败，但目标路径里已经有旧的完整文件，task 仍可能被记录为 `downloadStatus=failed`，`attachments_resolved=needs_fix`，同时后续 file context / ASR 又因为 `localPath` 可读继续成功。这会造成状态观测不一致。

### 当前存储量化

本次音频 SHA：

```text
a641ee981383818320b10946a04cdade8075f96c581f2d2f2620f6c4db2500af
```

runtime store 中该 SHA 有 3 条逻辑 artifact：

- 文件消息 run 的 `raw_media`
- 回复指令 run 的 `raw_media`
- 回复指令 run 的 `normalized_audio`

三条逻辑记录合计 `166,029,654` bytes，但都指向同一个 CAS object：

```text
runtime-runs/_store/objects/sha256/a6/41/a641ee981383818320b10946a04cdade8075f96c581f2d2f2620f6c4db2500af.wav
```

文件系统上这 3 个 run path 和 CAS object 当前 inode 相同，`nlink=4`，说明 dedupe 后物理层已经通过 hardlink 共享同一份 55MB 文件。

当前 store 状态：

```text
runs=95
artifacts=2189
activeBytes=2,046,804,904
casObjects=185
casBytes=430,607,171
orphanCasObjects=0
expiredCandidates=0
```

结论：CAS/hardlink 已经压住了最终物理重复，但它是事后治理，不能阻止下载阶段重复拉取、临时文件增长、网络/凭证调用开销和中间状态误报。

### 修复边界建议

优先修复下载前复用，而不是只依赖事后 dedupe：

1. 在 `downloadAttachments()` 调用 lark-cli 前，先检查目标 `localPath` 是否已存在且非空；如果存在并可 hash，标记为 `downloadStatus=local_reuse_current_run`，跳过下载。
2. 为附件缓存增加本地 artifact pointer：`messageId + fileKey + fileName + sha256 + sizeBytes + localPath/objectPath`。
3. 回复文件消息时，优先从 parent/root run 或 `recent_sources` 找到已下载 artifact，并 hardlink/symlink/copy 到当前 run。
4. 如果 lark-cli 失败但目标文件已存在且 hash/size 可用，应区分为 `downloadStatus=local_reuse_after_cli_failed`，不要把整个 `attachments_resolved` 打成 `needs_fix`。
5. runtime store 可继续作为最终索引和 dedupe 层，但不应替代下载前的 source-level reuse。

## 问题二：ASR 服务没有正常启动

### 现象

首次处理回复指令 run 时，音频 normalize 已完成，但本机 ASR 调用失败：

```text
local_asr_completed = blocked
reason = local_asr_service_unavailable
httpStatus = 0
```

同时 `127.0.0.1:8765/health` 不可连接，说明不是模型推理失败，而是 ASR HTTP 服务没有在 handler 可访问的本机端口上运行。

### 代码和配置边界

项目配置中 ASR URL 为：

```text
LOCAL_ASR_SERVICE_URL=http://127.0.0.1:8765
LOCAL_ASR_MODEL_DIR=models/Qwen3-ASR-1.7B-MLX-4bit
```

runner 的音频路径只调用本地 Qwen3-ASR HTTP 服务；服务不可用时必须阻塞，不会自动退回外部 ASR 或脚本兜底。

ASR 服务入口为：

```text
meeting-agent-pi-package/tools/local_asr_http_service.py
```

服务需要通过 `.venv-qwen3-asr` 加载 `mlx_qwen3_asr` 和 MLX Metal 模型。它不是由 Feishu handler 或 Docker compose 自动托管的进程。

### 直接原因

ASR 没有正常启动的直接原因是：本机 `127.0.0.1:8765` 没有运行 `local_asr_http_service.py` 常驻进程。

补充验证：在 Codex sandbox 内直接导入/运行 ASR 入口时，MLX 报错：

```text
RuntimeError: [metal::load_device] No Metal device available.
```

这说明 MLX/Metal ASR 不能放在当前 sandbox/headless 执行环境里启动；它必须作为 sandbox 外的本机 macOS 进程运行，才能访问 Metal 设备。

恢复方式：

```text
screen -dmS local_asr_service_20260522 ...
.venv-qwen3-asr/bin/python meeting-agent-pi-package/tools/local_asr_http_service.py --host 127.0.0.1 --port 8765 --model-dir models/Qwen3-ASR-1.7B-MLX-4bit --preload
```

恢复后 `/health` 返回：

```text
status=ok
modelLoaded=true
loadedModelDir=models/Qwen3-ASR-1.7B-MLX-4bit
lastStatus=complete
lastError=null
```

### 修复边界建议

1. Feishu audio profile 执行前增加 ASR health preflight。不可用时直接返回明确状态：`local_asr_service_not_running`，附带启动命令和当前端口。
2. 提供明确的本机 ASR lifecycle 脚本，例如 `start-local-asr`、`stop-local-asr`、`status-local-asr`，避免依赖人工记忆 README 命令。
3. 不把 ASR 放入本地 Docker worker。该服务依赖 macOS MLX/Metal 和本地模型路径，继续保留 Host-owned。
4. 如果 Codex/sandbox 内健康检查失败，需要区分 sandbox 网络/Metal 限制和真实服务不可用；关键判断以 sandbox 外 health check 为准。

## 问题三：交互层重复提示与状态不一致

### 现象

用户看到的回复包括：

```text
已接受任务，正在处理。
已接受任务，正在处理。
转写未完成，暂时无法生成文档。
已收到音频，可继续发送处理要求。
```

其中“已收到音频”来自文件消息 run，“转写未完成”来自回复指令 run。它们不是同一个 run 的状态互相覆盖，而是两个不同消息事件各自产生了可见回复。

### 代码原因

当前 gateway 只按 `messageId` 去重：

```text
if (seen.has(event.messageId)) return;
```

发送文件和回复文件的文字指令在飞书中是两个不同 `messageId`，因此都会被 gateway 处理。

handler 当前以 async 模式运行。每个事件进入 handler 后都会立即返回：

```json
{
  "status": "accepted",
  "text": "已接受任务，正在处理。",
  "suppressGatewayReply": false
}
```

gateway 收到 handler 返回后，只要 `suppressGatewayReply !== true`，就会发送 handler text。因此文件事件和文字指令事件各发一次“已接受任务，正在处理。”。

同时，文件消息本身没有 actionable prompt，会被 router 判定为：

```text
responseMode=ack_file_cached
immediateResponse=已收到音频，可继续发送处理要求。
```

后续文字回复消息会关联 parent/root 文件，进入 `audio_minutes`。ASR 未启动时，这个 run 再回复：

```text
转写未完成，暂时无法生成文档。
```

因此用户看到的是：

- gateway accepted for file event
- gateway accepted for text event
- file event final ack
- text event final blocked/completed reply

### 修复边界建议

推荐以“最终 handler live reply 为准”，减少 gateway 层可见 ACK：

1. async handler 的 `202 accepted` 默认设置 `suppressGatewayReply=true`，只作为 HTTP ingress 确认，不作为用户可见消息。
2. 如果需要保留可见 ACK，只对真正进入长链路的 actionable task 发送；`ack_file_cached` 文件缓存事件不发“正在处理”。
3. 对“文件消息 + 短时间内回复指令”的组合建立 interaction-level debounce：按 `rootId/parentId/sourceMessageId + sender + chat` 聚合，而不是只按单个 `messageId` 去重。
4. 文件事件的最终 ack 可以延迟或静默：当后续文字指令在短窗口内到达时，只保留文字指令 run 的最终回复。
5. reply 文案中避免把文件缓存确认和文档生成状态混在一起；可显式区分“文件已缓存”和“文档任务已开始/完成”。

## 总体结论

这次不是 SQLite/runtime store 读取错乱，而是三个边界叠加：

1. 附件下载层缺少下载前本地复用，导致同一文件被重新拉取，虽然 CAS 事后消除了物理重复。
2. 本机 ASR 是 Host-owned MLX/Metal 服务，没有作为 daemon 自动启动；服务缺失时 audio_minutes 正确阻塞。
3. gateway 与 async handler 的 ACK 语义没有收敛，文件事件和回复指令事件各自可见回复，造成用户感知上的重复和状态不一致。

后续优先级建议：

1. 先修 `suppressGatewayReply` 和 `ack_file_cached` 可见 ACK，减少用户侧噪声。
2. 再修附件下载前复用，避免重复下载和状态误报。
3. 最后补 ASR lifecycle 脚本和 health preflight，降低音频任务进入 blocked 的概率。

## 修复落地状态

2026-05-22 已完成本轮 fix，边界保持为 Host-owned Feishu/ASR、Docker 不接 raw audio、不新增外部 ASR 兜底：

1. async handler 的 accepted response 默认返回 `suppressGatewayReply=true`，只作为 HTTP ingress ACK；如需恢复旧可见 ACK，可设置 `FEISHU_AGENT_ASYNC_VISIBLE_ACK=1`。
2. `ack_file_cached` 默认静默最终回复，只写 `reply.json`，状态为 `ack_file_cached_silent`；如需恢复文件缓存确认回复，可设置 `FEISHU_AGENT_FILE_ACK_REPLY_MODE=live`。
3. 附件下载前会先复用当前 run 目标文件，状态为 `local_reuse_current_run`；带 `localPath` 的附件缓存会 hardlink/symlink/copy 到当前 run，状态为 `local_reuse_cached_attachment`；`lark-cli` 失败但目标文件已存在且可 hash 时，状态为 `local_reuse_after_cli_failed`，不再把 `attachments_resolved` 打成异常。
4. 下载完成后的附件会补写 `.feishu-attachment-cache.json` artifact pointer，包含 `messageId/sourceMessageId/fileKey/name/resourceType/localPath/sha256/sizeBytes/downloadStatus`，便于回复父消息或短窗口复用。
5. `ensureLocalAsr()` 先检查当前 run ASR artifact 和 ASR cache；只有 cache miss 才执行 `GET /health` preflight。服务不可达时返回 `local_asr_service_not_running`，带启动命令、端口和 `status-local-asr` 提示，不 normalize、不进入外部 ASR、不进入 Docker。
6. 新增本机 lifecycle CLI：`python3 meeting-agent-pi-package/tools/local_asr_service_ctl.py status|start|stop`。该工具默认使用 `.venv-qwen3-asr/bin/python`、`127.0.0.1:8765`、`models/Qwen3-ASR-1.7B-MLX-4bit`，pid/log 位于 `runtime-runs/_services/local-asr/`。

本轮没有实现 interaction-level debounce；用户可见重复提示先通过 suppress async ACK 和静默 `ack_file_cached` 收敛。
