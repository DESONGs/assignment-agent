> 历史快照：本文记录当时的定位过程，不代表当前实现。当前状态见 `../issues/README.md`。

# Feishu 音频父消息下载失败与历史本地复用缺口复盘

Status: fixed / historical

## 现象

用户在 Feishu 中回复同一个 MP3 文件消息并发送“生成会议纪要”，机器人多次返回：

```text
转写未完成，暂时无法生成文档。
```

代表性失败 run：

```text
runtime-runs/feishu-agent/runs/feishu_2026-06-02T07-51-12-317Z_om_x100b6edcf82370bcb30b7570dc79b00
```

当时 `feishu-gateway`、`feishu-handler` 和 `local-asr` 均正常，因此问题不在服务未启动，而在 source acquisition。

## 根因

父消息附件 metadata 已解析成功：

```json
{
  "fileKey": "file_v3_00129_af83c713-5871-4e34-81a5-4f0b30ec19dg",
  "sourceMessageId": "om_x100b6ee8dc3924a4b29a584c2c699cf",
  "name": "2026_06_01__21_40_.mp3"
}
```

但 `lark-cli im +messages-resources-download` 下载失败：

```json
{
  "downloadStatus": "failed",
  "exitCode": 128,
  "stderrTail": "cannot create file: context deadline exceeded"
}
```

同源 MP3 其实已经在历史 run 和 CAS 中存在：

```text
runtime-runs/feishu-agent/runs/feishu_2026-06-01T18-02-24-286Z_om_x100b6ee8dc3924a4b29a584c2c699cf/inputs/attachments/2026_06_01__21_40_.mp3
runtime-runs/_store/objects/sha256/10/dc/10dce2967058e633345f788ebf98c493cd6f96d4d163f663675d5e6740f61b2d.mp3
```

旧链路只查当前 run 和 30 分钟短期 `.feishu-attachment-cache.json`，没有查 runtime store 或历史 run artifact。下载失败后仍进入 runner，最终被误归因为 `no_audio_sources`，用户看到的是泛化的“转写未完成”。

## 修复

已完成以下修复：

1. `runtime_store_cli.py` 修复 Python 3.9 兼容，全部 `dt.UTC` 改为 `dt.timezone.utc`。
2. 新增只读查询子命令 `find-source`，通过 `source_refs + artifacts` 返回 workspace 内 ready source candidate。
3. `source_refs` 增加兼容字段 `file_key`，新索引会记录 Feishu `fileKey`，历史记录仍可通过 `sourceMessageId/name/kind` 命中。
4. `downloadAttachments()` 的下载前复用顺序改为：
   - 当前 run 目标文件
   - 短期 attachment cache localPath
   - runtime store ready raw media
   - 历史 run artifact
   - 最后才调用 `lark-cli`
5. 命中 runtime store 时记录 `downloadStatus=local_reuse_store_artifact`；命中历史 run 时记录 `downloadStatus=local_reuse_historical_run_artifact`。
6. `lark-cli` 失败后会再查一次长期复用，避免并发 run 刚写入本地文件时误失败。
7. 新增 `source_acquisition_gate`：音频任务没有任何可读本地 audio source 时，不进入 `task_execution_runner_started`、ASR、document worker 或发布长链路。
8. `im_file_context_helpers.mjs` 收紧 ready 语义：本地文件不存在或为空时不再标记 `ready`；音频 pending/blocked 仍保持 `contextMode=local_asr_only` 且 `externalLlmAllowed=false`。
9. 用户可见失败原因拆分：下载失败返回 `attachment_download_failed` 对应中文文案，不再统一成“转写未完成”。

## 验证

静态与 store 验证：

```bash
python3 meeting-agent-pi-package/tools/runtime_store_cli.py status
python3 meeting-agent-pi-package/tools/runtime_store_cli.py find-source --file-key file_v3_00129_af83c713-5871-4e34-81a5-4f0b30ec19dg --source-message-id om_x100b6ee8dc3924a4b29a584c2c699cf --kind raw_media --limit 5
```

结果：`status` 在系统 Python 3.9 下通过；`find-source` 返回已索引 MP3 candidate。

复用 fixture：

```bash
node meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs --fixture runtime-runs/feishu-agent/runs/feishu_2026-06-02T07-51-12-317Z_om_x100b6edcf82370bcb30b7570dc79b00/event.json --run-id feishu_fixture_cache_reuse_20260602 --dry-run
```

结果：

- attachment `downloadStatus=local_reuse_store_artifact`
- `linkMode=hardlink`
- `source_acquisition_gate=pass`
- file context `ready/local_asr_only`
- 复用文件和历史文件 inode 相同

缺失 source fixture：

- 使用不存在的 fileKey/sourceMessageId dry-run。
- `source_acquisition_gate=blocked`
- `reason=local_source_file_missing`
- 没有 `task_execution_runner_started`
- audio context 为 `pending/local_asr_only/externalLlmAllowed=false`

下载失败 fixture：

- 当前 shell 无 `lark-cli`，模拟下载失败。
- `source_acquisition_gate=blocked`
- `reason=attachment_download_failed`
- 用户文案为：

```text
音频附件下载失败，暂时无法转写。已尝试复用本地缓存但未命中。失败原因：Feishu 下载超时或网络异常。
```

## 残余风险

- `lark-cli` 版本仍偏旧；本修复不自动升级 CLI。
- 历史 run 扫描限制在当前 Feishu output root 的最近 500 个 run；更久远文件应通过 runtime store/CAS 命中。
- Live Feishu 端到端重试仍依赖真实 Feishu 下载权限、外部 LLM provider 和本地 ASR 状态。
