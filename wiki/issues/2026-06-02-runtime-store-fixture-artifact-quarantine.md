> 历史快照：本文记录当时的问题与修复，不代表当前架构。当前状态见本目录 `README.md`。

# Runtime store fixture artifact quarantine

Status: closed

## Problem

Fixture `feishu_fixture_identity_fallback_20260602` wrote a 17-byte fake `.wav` into production `runtime-runs/feishu-agent/runs` and runtime store. Because `find-source` trusted `ready/raw_media` metadata without provenance or audio header validation, two live runs reused the fake artifact and failed in audio normalize.

## Fix

- Added production pollution audit: `runtime_store_cli.py audit-pollution`.
- Added audited quarantine: `runtime_store_cli.py quarantine-artifact`.
- Quarantined fake hash `27e992171c07bc7961b16ff84f9773efcfc9ea99e2f41244f2f8de8089d9c8a7`.
- Quarantined fixture raw_media ready artifacts from production store while preserving shared CAS for live artifacts.
- Cleared polluted attachment cache ready pointers.
- Made `find-source` exclude fixture/mock/dry-run by default and require exact `file_key` when provided.
- Added raw audio min-size/header validation in runtime store, handler reuse, historical reuse, and file-context.
- Made fixture/mock/dry-run runtime store indexing opt-in with `FEISHU_AGENT_INDEX_FIXTURES=1`.

## Verification

- `audit-pollution` returns `status=clean`.
- `find-source` for the polluted fileKey/sourceMessageId returns `status=not_found`.
- No sub-1024-byte attachment files remain under production Feishu run attachments.
- Node checks pass for handler and file context helpers.
- Runtime store Python compile passes with workspace pycache prefix.
- Live retry run `feishu_2026-06-02T14-12-14-088Z_om_x100b6ed9882e18a4b2cd428917948fc` did not reuse fake artifact; it blocked at `feishu_resource_download_timeout` after bot/user retry.
- `local_ci_check.py` reports `failedCount=0`; the remaining blocker is local Swift toolchain/cache environment, not runtime code.

## Residual Risk

Live retry still depends on production `lark-cli` permissions and Feishu resource availability. If download fails after cache/store cleanup, the user should see a Feishu resource acquisition failure, not an ASR/format failure.
