import AgentWorkbenchCore

// This target intentionally avoids XCTest/Testing imports because this local
// CommandLineTools install does not ship either module. `swift test` still
// compiles the package test graph; the executable AgentWorkbenchSmokeTest is
// the actual fixture smoke test.
let agentWorkbenchCoreTestsCompileProbe = WorkbenchRunLoader.self
