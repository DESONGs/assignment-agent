> 历史快照：本文记录当时的定位过程，不代表当前实现。当前状态见 `../issues/README.md`。

# Feishu fixture artifact polluted runtime store

Status: fixed / historical

## 现象

用户对 `record-20260602-175319-3c.wav` 再次发送“生成会议纪要”后，机器人返回：

```text
目前音频格式暂不支持自动转码。
```

代表性 live runs：

```text
runtime-runs/feishu-agent/runs/feishu_2026-06-02T13-36-19-664Z_om_x100b6ed98be198b0b21add4907d3568
runtime-runs/feishu-agent/runs/feishu_2026-06-02T13-36-48-030Z_om_x100b6ed9882e18a4b2cd428917948fc
```

## 根因

这不是 ASR、转码器或真实音频格式问题，而是 fixture 污染了生产 runtime store。

`feishu_fixture_identity_fallback_20260602` 使用真实 `fileKey/sourceMessageId` 执行 fake `lark-cli` 验证，生成了 17 bytes 的伪 `.wav`：

```text
sha256=27e992171c07bc7961b16ff84f9773efcfc9ea99e2f41244f2f8de8089d9c8a7
sizeBytes=17
fileKey=file_v3_00129_4e07cf38-bd70-4c79-9486-c3819ac8092g
```

旧的 runtime store 只校验 `ready`、路径存在和 size > 0，没有校验 fixture provenance 和音频 header，因此该假文件被索引为 `ready/raw_media`。后续 live run 命中 `local_reuse_store_artifact`，把 17-byte 文件 hardlink 到当前 run，`afconvert` 读取时失败：

```text
Error: Couldn't open input file ('typ?')
```

## 修复

已完成：

- 暂停 supervisor 管理的 Feishu handler/gateway 后执行清理。
- 备份 SQLite：`runtime-runs/_store/backups/runtime-store.sqlite.before-pollution-cleanup-20260602-1354.bak`。
- 新增 `runtime_store_cli.py audit-pollution`。
- 新增 `runtime_store_cli.py quarantine-artifact`。
- quarantine 3 条 17-byte fake audio artifacts 和 2 条 fixture raw_media ready 索引。
- 保留共享 CAS object 给真实 live artifacts，不删除飞书远端文件。
- 清理 `.feishu-attachment-cache.json` 中 2 条 fake hash ready 指针，改为 `sourceReady=false`。
- `find-source` 默认排除 fixture/mock/dry-run，并收紧 fileKey 查询。
- `find-source` 返回 raw audio candidate 前执行 header/min-size 校验。
- handler 的当前 run/cache/store/historical reuse 均执行同一音频校验。
- fixture/mock/dry-run 默认不再写生产 runtime store，除非显式 `FEISHU_AGENT_INDEX_FIXTURES=1`。
- file-context 不再把无效本地音频标为 ready。

## 验证

清理后：

```text
runtime_store_cli.py audit-pollution -> status=clean
runtime_store_cli.py find-source --file-key ... --source-message-id ... -> status=not_found
find runtime-runs/feishu-agent/runs -path '*inputs/attachments/*' -type f -size -1024c -> no output
```

静态检查：

```bash
node --check meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs
node --check meeting-agent-pi-package/tools/im_file_context_helpers.mjs
PYTHONPYCACHEPREFIX=/private/tmp/assignment-agent-pycache python3 -m py_compile meeting-agent-pi-package/tools/runtime_store_cli.py
```

Live retry：

```text
runId=feishu_2026-06-02T14-12-14-088Z_om_x100b6ed9882e18a4b2cd428917948fc
result=blocked
failureClass=feishu_resource_download_timeout
downloadAttempts=bot x2 + user x2
```

该 retry 未再命中 17-byte fake artifact，也未进入 ASR/转码伪失败；当前剩余失败是 Feishu `lark-cli im +messages-resources-download` 对同一资源持续返回 `context deadline exceeded`。

CI：

```text
local_ci_check.py -> passed_with_environment_blockers
failedCount=0
blockedCount=1
blocker=swift_toolchain_sdk_mismatch / sandbox clang cache permission
```

## 后续要求

- 所有 fixture/live QA 必须使用隔离 output root 或 fake fileKey，不能复用真实 Feishu fileKey/sourceMessageId 写生产 store。
- 生产 `find-source` 不得返回 fixture/mock/dry-run artifact。
- raw audio 只有通过本地 header/min-size 校验后才能进入 ASR。
