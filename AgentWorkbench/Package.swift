// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "AgentWorkbench",
  platforms: [
    .macOS(.v14)
  ],
  products: [
    .library(name: "AgentWorkbenchCore", targets: ["AgentWorkbenchCore"]),
    .executable(name: "AgentWorkbench", targets: ["AgentWorkbenchApp"]),
    .executable(name: "AgentWorkbenchSmokeTest", targets: ["AgentWorkbenchSmokeTest"])
  ],
  targets: [
    .target(name: "AgentWorkbenchCore"),
    .executableTarget(
      name: "AgentWorkbenchApp",
      dependencies: ["AgentWorkbenchCore"]
    ),
    .executableTarget(
      name: "AgentWorkbenchSmokeTest",
      dependencies: ["AgentWorkbenchCore"]
    ),
    .testTarget(
      name: "AgentWorkbenchCoreTests",
      dependencies: ["AgentWorkbenchCore"]
    )
  ]
)
