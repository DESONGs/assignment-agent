> 历史快照：本文记录当时的问题与修复，不代表当前架构。当前状态见本目录 `README.md`。

# Feishu audio resource acquisition retry and identity fallback

Status: closed

## Problem

For `record-20260602-175319-3c.wav`, the handler resolved Feishu parent-message attachment metadata but failed to acquire the first local audio source. The only download attempt used `lark-cli im +messages-resources-download --as bot` and returned `cannot create file: context deadline exceeded`. Since there was no runtime store or historical run artifact for this file, source acquisition blocked and the user saw a generic unreadable-file message.

Representative run:

```text
runtime-runs/feishu-agent/runs/feishu_2026-06-02T10-22-00-341Z_om_x100b6edea2b8d4acb11edf9ff56985d
```

## Fix

- Added default attachment download identity order `bot,user` through `FEISHU_AGENT_ATTACHMENT_DOWNLOAD_AS`.
- Added bounded per-identity retry through `FEISHU_AGENT_ATTACHMENT_DOWNLOAD_MAX_ATTEMPTS`.
- Added IM resource failure classes: `feishu_resource_download_timeout`, `feishu_resource_permission_denied`, `lark_cli_unavailable`, `feishu_resource_not_found`, and `attachment_download_failed`.
- Added `downloadAttempts[]` audit records for every Feishu resource download attempt.
- Added success states `downloaded_after_retry` and `downloaded_identity_fallback`.
- Marked failed attachment-cache metadata as `sourceReady=false` with `lastFailureClass` and `lastDownloadAttempts`.
- Made attachment-cache TTL use `receivedAt` first so Feishu `createTime` skew cannot immediately prune failed acquisition metadata.
- Extended `source_acquisition_gate` and `agent-output.json.finalFailureReport` with `failureClass`, `downloadAs`, `downloadAttempts`, and `retryable`.
- Fixed generic/double-punctuation source acquisition failure text.

## Verification

- `node --check meeting-agent-pi-package/tools/feishu_agent_task_handler.mjs`
- `python3 src/validate_workspace.py`
- `python3 meeting-agent-pi-package/tools/local_ci_check.py` returned `passed_with_environment_blockers` with no failed checks; the remaining blocker is `swift_toolchain_sdk_mismatch`.
- Fixture `feishu_fixture_identity_fallback_20260602` confirmed bot timeout followed by user success as `downloaded_identity_fallback`.
- Fixture `feishu_fixture_identity_fallback_all_fail_20260602_c` confirmed bot/user timeout blocks at `source_acquisition_gate` with `feishu_resource_download_timeout`.

## Follow-up

Run live Feishu QA against the same parent message after confirming the production handler PATH can access `lark-cli`. Expected behavior: bot retry first, user fallback if bot still times out, then ASR/document generation if a local audio source is acquired. If both identities fail, the Feishu reply should include the concrete failure class and not enter ASR, document worker, QA, or publish.

## Live Follow-up Completion

Completed on 2026-06-03:

- Upgraded `lark-cli` from `1.0.32` to `1.0.46`.
- Added `FEISHU_AGENT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS`, default `900000`, so large IM resource downloads are not killed by the generic 120s CLI timeout.
- Live run `feishu_2026-06-03T06-48-24-686Z_om_x100b6ed9882e18a4b2cd428917948fc` acquired `record-20260602-175319-3c.wav` through user identity fallback after bot timeout.
- Download result: `downloadStatus=downloaded_identity_fallback`, `downloadAs=user`, `sizeBytes=39420018`, `audioValidation.ok=true`.
- ASR result: `42/42` chunks completed, `failedChunks=0`.
- Document result: meeting minutes generated in 3 section batches, QA/Policy passed, Feishu reply sent.
- Publish result: Wiki move remained blocked by Feishu wiki scope/token behavior, but Drive fallback published successfully at `https://r0q4yoqkms3.feishu.cn/file/W4oRb7vNJogTZcxylCIcGHW2nLc`.

## Regression Note

After the fixture verification, `feishu_fixture_identity_fallback_20260602` polluted production runtime store with a 17-byte fake `.wav` while using the real Feishu `fileKey/sourceMessageId`. Later live runs reused that fake artifact and failed audio normalize with a format error. This was fixed separately in `2026-06-02-runtime-store-fixture-artifact-quarantine.md` by quarantining fixture artifacts, excluding fixture/mock/dry-run from production `find-source`, and adding raw audio header validation.
