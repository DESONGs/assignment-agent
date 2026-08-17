# Agent Workbench

更新时间：2026-08-12。

AgentWorkbench 是 macOS SwiftUI 只读运行观测界面。它读取 `runtime-runs/feishu-agent/runs/*`，不执行 retry、ASR、Agent、发布、删除、移动、飞书写入或 Docker 写入。

## 当前读取范围

- `task.json`、`state.json`、`run.metrics.json`、`run-manifest.json`
- `agent-output.json`、`publish.json`、`reply.json`
- `artifacts/model-streams/**/*.ndjson`
- source context manifests、records、segments 和 context packs
- ASR summary、speaker/quality 摘要与 transcript artifact metadata
- Meeting Intelligence、participant/topic/evidence/agent plan
- agentic orchestration plan/result/events
- meeting-memory curation plan/result/events（只读；不读取或修改项目长期 `MEMORY.md`）
- runtime tool results、QA/Policy 和 bounded artifact preview

Workbench 的 preview 有长度上限，这是界面性能和防误操作设计，不代表 Agent 不能读取完整会议内容。敏感 key（token、cookie、session、authorization、API key、secret、credential）始终 redacted；默认界面不会内嵌播放 raw media 或一次性渲染完整长 transcript。

Workbench 会直接读取 `meeting-agent-pi-package/runtime/contract-manifest.json`，校验 task、execution profile、reasoning depth、run status 和 step status。未知值会显示为“合同异常”，避免运行已失败但观测界面仍把它当作正常状态。

## 运行

```bash
env CLANG_MODULE_CACHE_PATH=.build/module-cache SWIFTPM_DISABLE_USER_CACHE=1 swift build
env CLANG_MODULE_CACHE_PATH=.build/module-cache SWIFTPM_DISABLE_USER_CACHE=1 swift test --disable-xctest --disable-swift-testing
env CLANG_MODULE_CACHE_PATH=.build/module-cache SWIFTPM_DISABLE_USER_CACHE=1 swift run AgentWorkbenchSmokeTest
env CLANG_MODULE_CACHE_PATH=.build/module-cache SWIFTPM_DISABLE_USER_CACHE=1 swift run AgentWorkbench
./scripts/validate_contract_smoke.sh
```

指定 runs root：

```bash
swift run AgentWorkbench /path/to/runtime-runs/feishu-agent/runs
swift run AgentWorkbenchSmokeTest /path/to/runtime-runs/feishu-agent/runs
```

部分 CommandLineTools 环境不暴露 XCTest/Swift Testing modules；此时 `swift test` 只证明 package test graph 可编译，真实 fixture assertion 由 `AgentWorkbenchSmokeTest` 提供。
若默认 SDK 与 compiler 不匹配，`validate_contract_smoke.sh` 会选择本机兼容 SDK，在临时目录编译 Core/App/SmokeTest 并对真实 runs 执行 smoke；也可通过 `ASSIGNMENT_AGENT_SWIFT_SDK` 显式指定 SDK。
