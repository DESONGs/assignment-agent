# P0 Acceptance Evidence

Status: implemented and locally verified on 2026-05-24.

## Evidence Map

1. Required run files are read from `runtime-runs/feishu-agent/runs/*`.
   - Code: `Sources/AgentWorkbenchCore/WorkbenchRunLoader.swift`
   - UI: `Run Files` detail tab
   - Smoke evidence: `AgentWorkbenchSmokeTest passed: runs=47`

2. Model stream NDJSON is parsed and surfaced.
   - Code: `loadStreamEvents(...)`
   - UI: `Model Stream` tab
   - Smoke evidence: selected fixture parsed `streams=1610`

3. Source context artifacts are surfaced with bounded previews and references.
   - Code: `loadSourceContext(...)`, `loadSourceSegments(...)`, `loadContextPacks(...)`
   - UI: `Context` tab
   - Smoke evidence: selected fixture parsed `contextPacks=3`; source segment previews are capped.

4. Tool call timeline is surfaced.
   - Code: `loadToolCalls(...)`
   - UI: `Tools` tab and merged `Stage Timeline`
   - Smoke evidence: selected fixture parsed `tools=32`

5. Failure reason classes are recognized.
   - Code: `FailureReason`, `classifyFailures(...)`
   - Smoke evidence: synthetic fixture asserts all P0 failure classes:
     `local_asr_service_not_running`, `document_worker_deadline_exhausted`,
     `context_gate_failed`, `qa_blocked`, `publish_failed`.

6. P0 has no write actions.
   - Runtime app/core contain no `lark-cli`, `Process`, `URLSession`, Docker,
     ASR lifecycle, retry, publish, delete, or move execution code.
   - The only write path is the smoke executable creating a temporary synthetic
     fixture under `FileManager.default.temporaryDirectory`.

7. Build/test/smoke commands pass.
   - `env CLANG_MODULE_CACHE_PATH=.build/module-cache SWIFTPM_DISABLE_USER_CACHE=1 swift build`
   - `env CLANG_MODULE_CACHE_PATH=.build/module-cache SWIFTPM_DISABLE_USER_CACHE=1 swift test --disable-xctest --disable-swift-testing`
   - `env CLANG_MODULE_CACHE_PATH=.build/module-cache SWIFTPM_DISABLE_USER_CACHE=1 swift run AgentWorkbenchSmokeTest`

## Local Toolchain Note

This CommandLineTools install does not expose XCTest or Swift Testing modules.
The package therefore keeps `swift test` as a package test graph compile check
and uses the executable `AgentWorkbenchSmokeTest` for real fixture assertions.

## Boundary

Agent Workbench is a read-only observability package. It does not modify PI
runtime planner, runner, profiles, capability registry, Feishu publish, ASR,
Docker worker, or Hermes worker boundaries.
