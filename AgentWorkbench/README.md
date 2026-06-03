# Agent Workbench

macOS SwiftUI read-only observability workbench for PI Agent runtime artifacts.

## Scope

P0 is an observability layer only. It reads `runtime-runs/feishu-agent/runs/*`
and does not execute retry, publish, delete, move, Feishu write, Docker write,
or ASR lifecycle actions.

## What It Reads

- `task.json`, `state.json`, `run.metrics.json`, `agent-output.json`, `publish.json`
- `artifacts/model-streams/**/*.ndjson`
- `artifacts/source-context/context-manifest.json`
- `artifacts/source-context/source-records.json`
- `artifacts/source-context/source-segments.jsonl`
- `artifacts/source-context/context-packs/*.json`
- `runtime-tool-results/*.json`
- bounded artifact previews

## Safety

The UI renders bounded and redacted previews only. Sensitive keys such as
token, cookie, session, authorization, API key, secret, and credential are
redacted. Raw media, full transcript, full generated markdown, and full source
documents are suppressed from artifact previews.

## Commands

The local CommandLineTools install in this workspace does not expose XCTest or
Swift Testing modules, so `swift test` is used as a package test graph compile
check, and the executable smoke target performs the real fixture assertions.

```sh
cd AgentWorkbench
env CLANG_MODULE_CACHE_PATH=.build/module-cache SWIFTPM_DISABLE_USER_CACHE=1 swift build
env CLANG_MODULE_CACHE_PATH=.build/module-cache SWIFTPM_DISABLE_USER_CACHE=1 swift test --disable-xctest --disable-swift-testing
env CLANG_MODULE_CACHE_PATH=.build/module-cache SWIFTPM_DISABLE_USER_CACHE=1 swift run AgentWorkbenchSmokeTest
env CLANG_MODULE_CACHE_PATH=.build/module-cache SWIFTPM_DISABLE_USER_CACHE=1 swift run AgentWorkbench
```

Pass a custom runs root to the app or smoke test when needed:

```sh
swift run AgentWorkbench /path/to/runtime-runs/feishu-agent/runs
swift run AgentWorkbenchSmokeTest /path/to/runtime-runs/feishu-agent/runs
```
