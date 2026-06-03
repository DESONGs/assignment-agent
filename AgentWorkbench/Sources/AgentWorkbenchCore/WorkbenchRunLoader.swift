import Foundation

public final class WorkbenchRunLoader: @unchecked Sendable {
  public let runsRoot: URL
  private let fileManager: FileManager

  public init(runsRoot: URL, fileManager: FileManager = .default) {
    self.runsRoot = runsRoot
    self.fileManager = fileManager
  }

  public static func defaultRunsRoot(from base: URL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)) -> URL {
    let direct = base.appendingPathComponent("runtime-runs/feishu-agent/runs")
    if FileManager.default.fileExists(atPath: direct.path) { return direct }
    let parent = base.deletingLastPathComponent().appendingPathComponent("runtime-runs/feishu-agent/runs")
    if FileManager.default.fileExists(atPath: parent.path) { return parent }
    return direct
  }

  public func listRuns(limit: Int = 200) throws -> [RunSummary] {
    guard let children = try? fileManager.contentsOfDirectory(
      at: runsRoot,
      includingPropertiesForKeys: [.isDirectoryKey, .contentModificationDateKey],
      options: [.skipsHiddenFiles]
    ) else { return [] }

    let runDirs = children.filter { url in
      (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
    }.sorted { left, right in
      let leftDate = (try? left.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
      let rightDate = (try? right.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
      return leftDate > rightDate
    }.prefix(limit)

    return runDirs.map { summarizeRun($0) }
  }

  public func loadRun(_ runDir: URL) -> RuntimeRun {
    let runId = runDir.lastPathComponent
    let task = JSONHelpers.object(JSONHelpers.loadJSON(runDir.appendingPathComponent("task.json")))
    let state = JSONHelpers.object(JSONHelpers.loadJSON(runDir.appendingPathComponent("state.json")))
    let metrics = JSONHelpers.object(JSONHelpers.loadJSON(runDir.appendingPathComponent("run.metrics.json")))
    let agentOutput = JSONHelpers.object(JSONHelpers.loadJSON(runDir.appendingPathComponent("agent-output.json")))
    let publish = JSONHelpers.object(JSONHelpers.loadJSON(runDir.appendingPathComponent("publish.json")))

    let required = requiredFilePreviews(runDir: runDir)
    let sourceContext = loadSourceContext(runDir: runDir)
    let streamEvents = loadStreamEvents(runDir: runDir)
    let toolCalls = loadToolCalls(runDir: runDir, metrics: metrics)
    let timeline = loadTimeline(runDir: runDir, state: state, metrics: metrics, streamEvents: streamEvents, toolCalls: toolCalls)
    let artifacts = loadArtifacts(runDir: runDir)
    let failures = classifyFailures(state: state, metrics: metrics, agentOutput: agentOutput, publish: publish, streamEvents: streamEvents)

    return RuntimeRun(
      id: JSONHelpers.string(task, "runId") ?? JSONHelpers.string(state, "runId") ?? runId,
      runDir: runDir,
      requiredFiles: required,
      timeline: timeline,
      streamEvents: streamEvents,
      toolCalls: toolCalls,
      sourceContext: sourceContext,
      artifacts: artifacts,
      qaStatus: qaStatus(metrics: metrics, agentOutput: agentOutput),
      policyStatus: policyStatus(metrics: metrics, agentOutput: agentOutput, publish: publish),
      publishStatus: JSONHelpers.string(publish, "status") ?? "missing",
      failureReasons: failures,
      safetyNotes: [
        "Read-only observability layer: no retry, publish, delete, move, Feishu write, Docker write, or ASR lifecycle actions.",
        "Artifact previews are bounded and redacted; raw media, full transcript, full document markdown, cookies, tokens, and API keys are not rendered."
      ]
    )
  }

  private func summarizeRun(_ runDir: URL) -> RunSummary {
    let task = JSONHelpers.object(JSONHelpers.loadJSON(runDir.appendingPathComponent("task.json")))
    let state = JSONHelpers.object(JSONHelpers.loadJSON(runDir.appendingPathComponent("state.json")))
    let metrics = JSONHelpers.object(JSONHelpers.loadJSON(runDir.appendingPathComponent("run.metrics.json")))
    let agentOutput = JSONHelpers.object(JSONHelpers.loadJSON(runDir.appendingPathComponent("agent-output.json")))
    let publish = JSONHelpers.object(JSONHelpers.loadJSON(runDir.appendingPathComponent("publish.json")))
    let required = RequiredRuntimeFiles(
      task: exists(runDir, "task.json"),
      state: exists(runDir, "state.json"),
      metrics: exists(runDir, "run.metrics.json"),
      agentOutput: exists(runDir, "agent-output.json"),
      publish: exists(runDir, "publish.json")
    )
    let streamCount = countFiles(runDir.appendingPathComponent("artifacts/model-streams"), suffix: ".ndjson")
    let contextPackCount = countFiles(runDir.appendingPathComponent("artifacts/source-context/context-packs"), suffix: ".json")
    let artifactCount = countFiles(runDir.appendingPathComponent("artifacts"), suffix: nil)
    let streamEvents = streamCount > 0 ? loadStreamEvents(runDir: runDir, maxEvents: 400) : []
    let failures = classifyFailures(state: state, metrics: metrics, agentOutput: agentOutput, publish: publish, streamEvents: streamEvents)
    let taskIntent = JSONHelpers.object(task["taskIntent"])

    return RunSummary(
      id: JSONHelpers.string(task, "runId") ?? JSONHelpers.string(state, "runId") ?? runDir.lastPathComponent,
      runDir: runDir,
      status: JSONHelpers.string(state, "status") ?? JSONHelpers.string(task, "status") ?? JSONHelpers.string(agentOutput, "status") ?? "unknown",
      taskType: JSONHelpers.string(taskIntent, "taskType", "executionProfile") ?? JSONHelpers.string(metrics, "taskType") ?? "unknown",
      requestedAt: JSONHelpers.string(task, "requestedAt"),
      updatedAt: JSONHelpers.string(state, "updatedAt") ?? JSONHelpers.string(metrics, "finishedAt"),
      requiredFiles: required,
      streamEventCount: streamCount,
      toolCallCount: JSONHelpers.array(metrics["toolCalls"]).count + countFiles(runDir.appendingPathComponent("runtime-tool-results"), suffix: ".json"),
      contextPackCount: contextPackCount,
      artifactCount: artifactCount,
      qaStatus: qaStatus(metrics: metrics, agentOutput: agentOutput),
      policyStatus: policyStatus(metrics: metrics, agentOutput: agentOutput, publish: publish),
      publishStatus: JSONHelpers.string(publish, "status") ?? "missing",
      failureReasons: failures
    )
  }

  private func requiredFilePreviews(runDir: URL) -> [RequiredFilePreview] {
    ["task.json", "state.json", "run.metrics.json", "agent-output.json", "publish.json"].map { name in
      let url = runDir.appendingPathComponent(name)
      let value = JSONHelpers.loadJSON(url)
      return RequiredFilePreview(
        id: name,
        name: name,
        present: value != nil,
        preview: value == nil ? "missing" : WorkbenchRedactor.sanitizedPreview(value, limit: 1_200)
      )
    }
  }

  private func loadTimeline(runDir: URL, state: [String: Any], metrics: [String: Any], streamEvents: [StreamEvent], toolCalls: [ToolCallEvent]) -> [TimelineEvent] {
    var events: [TimelineEvent] = []
    for (index, item) in JSONHelpers.array(state["steps"]).enumerated() {
      let object = JSONHelpers.object(item)
      let name = JSONHelpers.string(object, "name") ?? "stage"
      events.append(TimelineEvent(
        id: "state-\(index)-\(name)",
        name: name,
        status: JSONHelpers.string(object, "status") ?? "unknown",
        at: JSONHelpers.string(object, "at", "startedAt", "finishedAt"),
        artifact: JSONHelpers.string(object, "artifact").map { WorkbenchRedactor.redactText($0, limit: 220) },
        detail: WorkbenchRedactor.sanitizedPreview(object, limit: 500)
      ))
    }
    for (index, call) in toolCalls.prefix(120).enumerated() {
      events.append(TimelineEvent(
        id: "tool-\(index)-\(call.id)",
        name: "tool:\(call.toolName)",
        status: call.status,
        at: call.startedAt ?? call.finishedAt,
        artifact: nil,
        detail: call.preview
      ))
    }
    for (index, event) in streamEvents.filter({ $0.event.contains("blocked") || $0.event.contains("timeout") || $0.status == "blocked" || $0.reason?.contains("timeout") == true }).prefix(80).enumerated() {
      events.append(TimelineEvent(
        id: "stream-\(index)-\(event.id)",
        name: "stream:\(event.event)",
        status: event.status ?? event.reason ?? "event",
        at: event.at,
        artifact: event.file,
        detail: event.preview
      ))
    }
    return events.sorted { ($0.at ?? "") < ($1.at ?? "") }
  }

  private func loadStreamEvents(runDir: URL, maxEvents: Int = 2_000) -> [StreamEvent] {
    let root = runDir.appendingPathComponent("artifacts/model-streams")
    let files = recursiveFiles(root).filter { $0.pathExtension == "ndjson" }.sorted { $0.path < $1.path }
    var events: [StreamEvent] = []
    for file in files {
      guard events.count < maxEvents, let content = try? String(contentsOf: file, encoding: .utf8) else { continue }
      let relative = JSONHelpers.relativePath(file, root: runDir)
      for (lineIndex, line) in content.split(separator: "\n", omittingEmptySubsequences: true).enumerated() {
        guard events.count < maxEvents,
              let data = String(line).data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { continue }
        let event = JSONHelpers.string(object, "event") ?? file.deletingPathExtension().lastPathComponent
        let segmentIds = JSONHelpers.stringArray(object, "sourceSegmentIds")
        let previewObject: [String: Any] = [
          "event": event,
          "provider": JSONHelpers.string(object, "provider") ?? "",
          "model": JSONHelpers.string(object, "model") ?? "",
          "status": JSONHelpers.string(object, "status") ?? "",
          "reason": JSONHelpers.string(object, "reason") ?? "",
          "contextPackId": JSONHelpers.string(object, "contextPackId") ?? "",
          "sourceSegmentIds": segmentIds,
          "promptBudgetChars": JSONHelpers.int(object, "promptBudgetChars") as Any,
          "timeoutMs": JSONHelpers.int(object, "timeoutMs") as Any
        ]
        events.append(StreamEvent(
          id: "\(relative)#\(lineIndex)",
          file: relative,
          event: event,
          at: JSONHelpers.string(object, "at", "startedAt", "completedAt", "finishedAt"),
          provider: JSONHelpers.string(object, "provider"),
          model: JSONHelpers.string(object, "model"),
          status: JSONHelpers.string(object, "status"),
          reason: JSONHelpers.string(object, "reason"),
          contextPackId: JSONHelpers.string(object, "contextPackId"),
          sourceSegmentIds: segmentIds,
          promptBudgetChars: JSONHelpers.int(object, "promptBudgetChars"),
          preview: WorkbenchRedactor.sanitizedPreview(previewObject, limit: 700)
        ))
      }
    }
    return events
  }

  private func loadToolCalls(runDir: URL, metrics: [String: Any]) -> [ToolCallEvent] {
    var output: [ToolCallEvent] = []
    for (index, item) in JSONHelpers.array(metrics["toolCalls"]).enumerated() {
      let object = JSONHelpers.object(item)
      let name = JSONHelpers.string(object, "name", "tool") ?? "tool_call"
      output.append(ToolCallEvent(
        id: "metrics-\(index)-\(name)",
        toolName: name,
        startedAt: JSONHelpers.string(object, "startedAt", "at"),
        finishedAt: JSONHelpers.string(object, "finishedAt", "completedAt"),
        durationMs: JSONHelpers.int(object, "durationMs"),
        status: JSONHelpers.string(object, "status") ?? "observed",
        exitCode: JSONHelpers.int(object, "exitCode"),
        stderrTail: JSONHelpers.string(object, "stderrTail").map { WorkbenchRedactor.redactText($0, limit: 260) },
        preview: WorkbenchRedactor.sanitizedPreview(object, limit: 700)
      ))
    }

    let resultDir = runDir.appendingPathComponent("runtime-tool-results")
    for file in recursiveFiles(resultDir).filter({ $0.pathExtension == "json" }).sorted(by: { $0.path < $1.path }) {
      let object = JSONHelpers.object(JSONHelpers.loadJSON(file))
      let name = toolNameFromFile(file)
      output.append(ToolCallEvent(
        id: "result-\(file.lastPathComponent)",
        toolName: name,
        startedAt: timestampFromToolFile(file.lastPathComponent),
        finishedAt: JSONHelpers.string(object, "finishedAt", "completedAt") ?? JSONHelpers.modificationTime(file),
        durationMs: JSONHelpers.int(object, "durationMs"),
        status: JSONHelpers.string(object, "status") ?? JSONHelpers.string(object, "reason") ?? "completed",
        exitCode: JSONHelpers.int(object, "exitCode"),
        stderrTail: JSONHelpers.string(object, "stderrTail").map { WorkbenchRedactor.redactText($0, limit: 260) },
        preview: WorkbenchRedactor.sanitizedPreview(object, limit: 700)
      ))
    }
    return output
  }

  private func loadSourceContext(runDir: URL) -> SourceContextSummary {
    let root = runDir.appendingPathComponent("artifacts/source-context")
    let manifestURL = root.appendingPathComponent("context-manifest.json")
    let manifest = JSONHelpers.loadJSON(manifestURL)
    var warnings: [String] = []
    if manifest == nil { warnings.append("context-manifest.json missing") }

    let records = loadSourceRecords(root.appendingPathComponent("source-records.json"))
    let segments = loadSourceSegments(root.appendingPathComponent("source-segments.jsonl"), limit: 120)
    let packs = loadContextPacks(root.appendingPathComponent("context-packs"), segmentIndex: Dictionary(uniqueKeysWithValues: segments.map { ($0.id, $0) }))

    return SourceContextSummary(
      manifestPresent: manifest != nil,
      manifestPreview: manifest.map { WorkbenchRedactor.sanitizedPreview($0, limit: 1_200) } ?? "missing",
      sourceRecords: records,
      sourceSegments: segments,
      contextPacks: packs,
      warnings: warnings
    )
  }

  private func loadSourceRecords(_ url: URL) -> [SourceRecordPreview] {
    let object = JSONHelpers.object(JSONHelpers.loadJSON(url))
    let sources = JSONHelpers.array(object["sources"])
    return sources.enumerated().map { index, item in
      let source = JSONHelpers.object(item)
      let id = JSONHelpers.string(source, "sourceId", "id") ?? "source-\(index)"
      return SourceRecordPreview(
        id: id,
        sourceType: JSONHelpers.string(source, "sourceType", "type") ?? "source",
        status: JSONHelpers.string(source, "status", "quality") ?? "unknown",
        title: WorkbenchRedactor.redactText(JSONHelpers.string(source, "title", "fileName", "name") ?? id, limit: 180)
      )
    }
  }

  private func loadSourceSegments(_ url: URL, limit: Int) -> [SourceSegmentPreview] {
    guard let content = try? String(contentsOf: url, encoding: .utf8) else { return [] }
    var segments: [SourceSegmentPreview] = []
    for line in content.split(separator: "\n", omittingEmptySubsequences: true) {
      guard segments.count < limit,
            let data = String(line).data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      else { continue }
      let id = JSONHelpers.string(object, "segmentId", "id") ?? "segment-\(segments.count)"
      let preview = JSONHelpers.string(object, "textPreview")
        ?? JSONHelpers.string(object, "preview")
        ?? JSONHelpers.string(object, "text")
        ?? ""
      segments.append(SourceSegmentPreview(
        id: id,
        sourceId: JSONHelpers.string(object, "sourceId") ?? "",
        sourceType: JSONHelpers.string(object, "sourceType") ?? "",
        segmentKind: JSONHelpers.string(object, "segmentKind") ?? "text",
        quality: JSONHelpers.string(object, "quality") ?? "unknown",
        boundedPreview: WorkbenchRedactor.redactText(preview, limit: 240)
      ))
    }
    return segments
  }

  private func loadContextPacks(_ dir: URL, segmentIndex: [String: SourceSegmentPreview]) -> [ContextPackPreview] {
    recursiveFiles(dir).filter { $0.pathExtension == "json" }.sorted { $0.path < $1.path }.prefix(80).map { file in
      let object = JSONHelpers.object(JSONHelpers.loadJSON(file))
      let segmentIds = JSONHelpers.stringArray(object, "sourceSegmentIds")
      return ContextPackPreview(
        id: JSONHelpers.string(object, "contextPackId") ?? file.deletingPathExtension().lastPathComponent,
        workUnitId: JSONHelpers.string(object, "workUnitId") ?? "",
        docType: JSONHelpers.string(object, "docType") ?? "document",
        sourceSegmentIds: segmentIds,
        sourceBlockIds: JSONHelpers.stringArray(object, "sourceBlockIds"),
        promptBudgetChars: JSONHelpers.int(object, "promptBudgetChars"),
        boundedSegmentPreviews: segmentIds.prefix(12).compactMap { segmentIndex[$0] }
      )
    }
  }

  private func loadArtifacts(runDir: URL) -> [ArtifactPreview] {
    recursiveFiles(runDir.appendingPathComponent("artifacts")).sorted { $0.path < $1.path }.prefix(400).map { file in
      ArtifactPreview(
        id: JSONHelpers.relativePath(file, root: runDir),
        relativePath: JSONHelpers.relativePath(file, root: runDir),
        kind: artifactKind(file),
        sizeBytes: JSONHelpers.fileSize(file),
        preview: artifactPreview(file)
      )
    }
  }

  private func artifactPreview(_ file: URL) -> String {
    let ext = file.pathExtension.lowercased()
    guard ["json", "jsonl", "ndjson", "txt", "md"].contains(ext) else {
      return "[binary or unsupported preview suppressed]"
    }
    guard let content = try? String(contentsOf: file, encoding: .utf8) else { return "" }
    if file.path.contains("/source-context/source-segments.jsonl") {
      return "[source segments: bounded previews are shown in Source Context]"
    }
    if ext == "md" || file.lastPathComponent.lowercased().contains("transcript") {
      return "[raw document/transcript preview suppressed]"
    }
    return WorkbenchRedactor.redactText(content, limit: 700)
  }

  private func classifyFailures(state: [String: Any], metrics: [String: Any], agentOutput: [String: Any], publish: [String: Any], streamEvents: [StreamEvent]) -> [FailureReason] {
    let text = [
      JSONHelpers.recursiveText(state),
      JSONHelpers.recursiveText(metrics),
      JSONHelpers.recursiveText(agentOutput),
      JSONHelpers.recursiveText(publish),
      streamEvents.map { "\($0.event) \($0.status ?? "") \($0.reason ?? "")" }.joined(separator: " ")
    ].joined(separator: " ")

    var reasons: [FailureReason] = []
    if text.contains(FailureReason.localAsrServiceNotRunning.rawValue) { reasons.append(.localAsrServiceNotRunning) }
    if text.contains(FailureReason.documentWorkerDeadlineExhausted.rawValue) { reasons.append(.documentWorkerDeadlineExhausted) }
    if text.contains("context_gate_failed") || text.contains("context gate failed") { reasons.append(.contextGateFailed) }
    if text.contains("qa_blocked") || qaStatus(metrics: metrics, agentOutput: agentOutput).lowercased().contains("block") { reasons.append(.qaBlocked) }
    let publishStatus = JSONHelpers.string(publish, "status")?.lowercased() ?? ""
    if publishStatus.contains("fail") || publishStatus.contains("blocked") || text.contains("publish_failed") {
      reasons.append(.publishFailed)
    }
    return Array(Set(reasons)).sorted { $0.rawValue < $1.rawValue }
  }

  private func qaStatus(metrics: [String: Any], agentOutput: [String: Any]) -> String {
    let metricsQA = JSONHelpers.object(metrics["qaGate"])
    let outputQA = JSONHelpers.object(agentOutput["qaGate"])
    return JSONHelpers.string(metricsQA, "status", "overallStatus")
      ?? JSONHelpers.string(outputQA, "status", "overallStatus")
      ?? "missing"
  }

  private func policyStatus(metrics: [String: Any], agentOutput: [String: Any], publish: [String: Any]) -> String {
    if let status = JSONHelpers.string(publish, "policyGateStatus") { return status }
    let outputPolicy = JSONHelpers.object(agentOutput["policyGate"])
    if let status = JSONHelpers.string(outputPolicy, "status") { return status }
    if let first = JSONHelpers.array(metrics["policyDecisions"]).first {
      return JSONHelpers.string(JSONHelpers.object(first), "status") ?? "observed"
    }
    return "missing"
  }

  private func exists(_ dir: URL, _ name: String) -> Bool {
    fileManager.fileExists(atPath: dir.appendingPathComponent(name).path)
  }

  private func recursiveFiles(_ root: URL) -> [URL] {
    guard let enumerator = fileManager.enumerator(
      at: root,
      includingPropertiesForKeys: [.isRegularFileKey],
      options: [.skipsHiddenFiles]
    ) else { return [] }
    return enumerator.compactMap { item -> URL? in
      guard let url = item as? URL else { return nil }
      return ((try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true) ? url : nil
    }
  }

  private func countFiles(_ root: URL, suffix: String?) -> Int {
    recursiveFiles(root).filter { file in
      suffix == nil || file.lastPathComponent.hasSuffix(suffix!)
    }.count
  }

  private func toolNameFromFile(_ file: URL) -> String {
    let name = file.deletingPathExtension().lastPathComponent
    if let range = name.range(of: #"-\d{10,}$"#, options: .regularExpression) {
      return String(name[..<range.lowerBound])
    }
    return name
  }

  private func timestampFromToolFile(_ name: String) -> String? {
    guard let match = name.range(of: #"\d{10,}"#, options: .regularExpression),
          let milliseconds = Double(name[match])
    else { return nil }
    return ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: milliseconds / 1000.0))
  }

  private func artifactKind(_ file: URL) -> String {
    let path = file.path
    if path.contains("/model-streams/") { return "model-stream" }
    if path.contains("/source-context/") { return "source-context" }
    if path.contains("/document-workflow/") { return "document-workflow" }
    if file.lastPathComponent.contains("qa") { return "qa" }
    if file.lastPathComponent.contains("policy") { return "policy" }
    return file.pathExtension.isEmpty ? "artifact" : file.pathExtension
  }
}
