import Foundation

public struct RuntimeContract: Sendable {
  public static let expectedSchemaVersion = "assignment-agent-runtime-contracts-v1"

  public let manifestPath: String?
  public let loadError: String?
  private let taskTypes: Set<String>
  private let executionProfiles: Set<String>
  private let reasoningDepths: Set<String>
  private let runStatuses: Set<String>
  private let runStepStatuses: Set<String>

  public var available: Bool { loadError == nil }

  private init(
    manifestPath: String?,
    loadError: String?,
    taskTypes: Set<String> = [],
    executionProfiles: Set<String> = [],
    reasoningDepths: Set<String> = [],
    runStatuses: Set<String> = [],
    runStepStatuses: Set<String> = []
  ) {
    self.manifestPath = manifestPath
    self.loadError = loadError
    self.taskTypes = taskTypes
    self.executionProfiles = executionProfiles
    self.reasoningDepths = reasoningDepths
    self.runStatuses = runStatuses
    self.runStepStatuses = runStepStatuses
  }

  public static func load(
    runsRoot: URL,
    fileManager: FileManager = .default,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> RuntimeContract {
    let candidates = manifestCandidates(runsRoot: runsRoot, environment: environment)
    guard let manifestURL = candidates.first(where: { fileManager.fileExists(atPath: $0.path) }) else {
      return RuntimeContract(
        manifestPath: nil,
        loadError: "runtime_contract_manifest_missing"
      )
    }
    do {
      let data = try Data(contentsOf: manifestURL)
      guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            root["schemaVersion"] as? String == expectedSchemaVersion,
            let task = root["task"] as? [String: Any],
            let feishu = root["feishu"] as? [String: Any]
      else {
        return RuntimeContract(manifestPath: manifestURL.path, loadError: "runtime_contract_manifest_invalid")
      }
      func strings(_ object: [String: Any], _ key: String) -> Set<String>? {
        guard let values = object[key] as? [String], !values.isEmpty else { return nil }
        return Set(values)
      }
      guard let taskTypes = strings(task, "taskTypes"),
            let executionProfiles = strings(feishu, "executionProfiles"),
            let reasoningDepths = strings(feishu, "reasoningDepths"),
            let runStatuses = strings(feishu, "runStatuses"),
            let runStepStatuses = strings(feishu, "runStepStatuses")
      else {
        return RuntimeContract(manifestPath: manifestURL.path, loadError: "runtime_contract_manifest_values_missing")
      }
      return RuntimeContract(
        manifestPath: manifestURL.path,
        loadError: nil,
        taskTypes: taskTypes,
        executionProfiles: executionProfiles,
        reasoningDepths: reasoningDepths,
        runStatuses: runStatuses,
        runStepStatuses: runStepStatuses
      )
    } catch {
      return RuntimeContract(manifestPath: manifestURL.path, loadError: "runtime_contract_manifest_read_failed")
    }
  }

  public func validate(task: [String: Any], state: [String: Any]) -> [String] {
    guard available else { return [loadError ?? "runtime_contract_unavailable"] }
    var warnings: [String] = []
    if task["schemaVersion"] as? String != "feishu-task-v1" {
      warnings.append("task_schema_version_unknown")
    }
    if let status = task["status"] as? String, !runStatuses.contains(status) {
      warnings.append("task_status_unknown:\(status)")
    }
    let intent = task["taskIntent"] as? [String: Any] ?? [:]
    if let taskType = intent["taskType"] as? String, !taskTypes.contains(taskType) {
      warnings.append("task_type_unknown:\(taskType)")
    }
    if let profile = intent["executionProfile"] as? String, !executionProfiles.contains(profile) {
      warnings.append("execution_profile_unknown:\(profile)")
    }
    if let depth = intent["reasoningDepth"] as? String, !reasoningDepths.contains(depth) {
      warnings.append("reasoning_depth_unknown:\(depth)")
    }
    if state["schemaVersion"] as? String != "feishu-run-state-v1" {
      warnings.append("state_schema_version_unknown")
    }
    if let status = state["status"] as? String, !runStatuses.contains(status) {
      warnings.append("run_status_unknown:\(status)")
    }
    for step in state["steps"] as? [[String: Any]] ?? [] {
      guard let status = step["status"] as? String else {
        warnings.append("run_step_status_missing")
        continue
      }
      if !runStepStatuses.contains(status) {
        let name = step["name"] as? String ?? "unknown"
        warnings.append("run_step_status_unknown:\(name):\(status)")
      }
    }
    return Array(Set(warnings)).sorted()
  }

  private static func manifestCandidates(runsRoot: URL, environment: [String: String]) -> [URL] {
    var candidates: [URL] = []
    if let explicit = environment["ASSIGNMENT_AGENT_CONTRACT_MANIFEST"], !explicit.isEmpty {
      candidates.append(URL(fileURLWithPath: explicit))
    }
    var roots: [URL] = [
      URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
      runsRoot,
    ]
    for root in roots {
      var current = root.standardizedFileURL
      for _ in 0..<10 {
        candidates.append(current.appendingPathComponent("meeting-agent-pi-package/runtime/contract-manifest.json"))
        let parent = current.deletingLastPathComponent()
        if parent.path == current.path { break }
        current = parent
      }
    }
    var seen = Set<String>()
    roots.removeAll()
    return candidates.filter { seen.insert($0.standardizedFileURL.path).inserted }
  }
}
