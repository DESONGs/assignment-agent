# AgentWorkbench P0 验收状态

更新时间：2026-08-12。

状态：P0 只读观测能力已实现。当前文档不复用 2026-05 的固定 run/stream 数量作为持续有效证据；每次发布以当次 build 与 executable smoke 输出为准。

## 验收范围

- 能从自定义或默认 runs root 列出运行。
- 能读取 run files、model stream、source context、tool timeline 和 bounded preview。
- 能识别常见失败类别，并显示可恢复原因。
- 不包含 `lark-cli`、URLSession 写调用、Docker/ASR lifecycle、retry、publish、delete 或 move 执行能力。
- 所有 credential-like fields 在 UI 层 redacted。

当前 Meeting Intelligence、Agentic 与 meeting-memory curation artifacts 已进入运行 manifest；Workbench 后续视图应优先展示 participant/topic/decision/action、delegation attempts、evidence reconciliation 和记忆 rejection/conflict，而不是扩大写权限或直接编辑长期记忆。

## 验证命令

```bash
env CLANG_MODULE_CACHE_PATH=.build/module-cache SWIFTPM_DISABLE_USER_CACHE=1 swift build
env CLANG_MODULE_CACHE_PATH=.build/module-cache SWIFTPM_DISABLE_USER_CACHE=1 swift test --disable-xctest --disable-swift-testing
env CLANG_MODULE_CACHE_PATH=.build/module-cache SWIFTPM_DISABLE_USER_CACHE=1 swift run AgentWorkbenchSmokeTest
```

已知环境限制：某些 CommandLineTools 不提供 XCTest/Swift Testing modules，因此 executable smoke 才是 fixture assertion 的完成证据。
