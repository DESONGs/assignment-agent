> 历史快照：本文记录当时的问题与修复，不代表当前架构。当前状态见本目录 `README.md`。

# Feishu audio parent attachment long-term reuse gap

Status: closed

## Problem

Feishu audio reply tasks could resolve parent message metadata but fail to download the actual MP3. If the 30-minute `.feishu-attachment-cache.json` entry had expired, the handler did not query runtime store/CAS or historical run artifacts before calling `lark-cli`. When `lark-cli` timed out, the run continued into the runner and surfaced as `no_audio_sources` / “转写未完成”, hiding the true `attachment_download_failed` root cause.

Representative run:

```text
runtime-runs/feishu-agent/runs/feishu_2026-06-02T07-51-12-317Z_om_x100b6edcf82370bcb30b7570dc79b00
```

## Fix

- Added `runtime_store_cli.py find-source` for read-only ready source lookup through runtime store CLI contract.
- Fixed runtime store Python 3.9 compatibility by replacing `dt.UTC` with `dt.timezone.utc`.
- Added `source_refs.file_key` migration and indexing for future precise Feishu attachment lookup.
- Extended handler attachment reuse states:
  - `local_reuse_store_artifact`
  - `local_reuse_historical_run_artifact`
- Added `source_acquisition_gate` before runner execution.
- Tightened file-context readiness so missing local files are not `ready`.
- Split user-facing source failures into `attachment_download_failed` and `local_source_file_missing`.

## Verification

- `python3 meeting-agent-pi-package/tools/runtime_store_cli.py status` passed on system Python.
- `find-source` returned the known MP3 raw media candidate.
- `feishu_fixture_cache_reuse_20260602` reused runtime store artifact via hardlink.
- `feishu_fixture_source_gate_missing_20260602_b` blocked before runner with `local_source_file_missing`.
- `feishu_fixture_download_failed_20260602` blocked before runner with `attachment_download_failed` and a specific user-facing message.

## Follow-up

Live Feishu retry should confirm the same parent MP3 now reuses the local artifact and proceeds to ASR/document generation. `lark-cli` upgrade remains an environment maintenance item, not part of this fix.
