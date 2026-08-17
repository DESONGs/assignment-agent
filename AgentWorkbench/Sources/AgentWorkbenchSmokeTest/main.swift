import AgentWorkbenchCore
import Foundation

enum SmokeFailure: Error, CustomStringConvertible {
  case failed(String)

  var description: String {
    switch self {
    case .failed(let message): message
    }
  }
}

func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() { throw SmokeFailure.failed(message) }
}

func writeJSON(_ value: Any, to url: URL) throws {
  let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
  try data.write(to: url)
}

func runSmoke() throws {
  let root = CommandLine.arguments.dropFirst().first.map(URL.init(fileURLWithPath:))
    ?? WorkbenchRunLoader.defaultRunsRoot()
  let loader = WorkbenchRunLoader(runsRoot: root)
  let runs = try loader.listRuns(limit: 120)
  try expect(!runs.isEmpty, "runtime run list is empty")
  try expect(runs.contains { $0.requiredFiles.allPresent }, "no run has task/state/metrics/agent-output/publish")

  guard let richRun = runs.first(where: { $0.streamEventCount > 0 && $0.contextPackCount > 0 }) else {
    throw SmokeFailure.failed("no run has model stream ndjson plus source context packs")
  }
  let loaded = loader.loadRun(richRun.runDir)
  try expect(!loaded.streamEvents.isEmpty, "model stream events were not parsed")
  try expect(loaded.streamEvents.contains { $0.event == "request_started" || $0.event == "attempt_started" }, "provider attempt/request events missing")
  try expect(!loaded.sourceContext.contextPacks.isEmpty, "context packs missing")
  try expect(loaded.sourceContext.contextPacks.contains { !$0.sourceSegmentIds.isEmpty }, "context packs lack segment refs")
  try expect(!loaded.toolCalls.isEmpty, "tool call timeline missing")
  try expect(loaded.sourceContext.sourceSegments.allSatisfy { $0.boundedPreview.count <= 260 }, "source segment preview exceeded bounded limit")
  try expect(!loaded.artifacts.contains { $0.preview.contains("## 会议主题") }, "raw generated markdown leaked into artifact preview")

  let payload: [String: Any] = [
    "Authorization": "Bearer secret-token-value",
    "cookie": "sessionid=abc",
    "fileToken": "AbCdEfGhIjKlMnOpQrStUvWxYz123456",
    "markdown": String(repeating: "正文", count: 400)
  ]
  let preview = WorkbenchRedactor.sanitizedPreview(payload, limit: 2_000)
  try expect(!preview.contains("secret-token-value"), "authorization secret leaked")
  try expect(!preview.contains("sessionid=abc"), "cookie leaked")
  try expect(!preview.contains("AbCdEfGhIjKlMnOpQrStUvWxYz123456"), "Feishu-style token leaked")
  try expect(preview.contains("[bounded-preview]"), "raw markdown was not bounded")
  try expect(!WorkbenchRedactor.containsSensitiveLeak(preview), "redacted preview still matches sensitive pattern")

  let tempRoot = FileManager.default.temporaryDirectory.appendingPathComponent("agent-workbench-fixture-\(UUID().uuidString)")
  let syntheticRun = tempRoot.appendingPathComponent("runs/synthetic")
  try FileManager.default.createDirectory(at: syntheticRun, withIntermediateDirectories: true)
  try writeJSON(["schemaVersion": "feishu-task-v1", "runId": "synthetic", "status": "running", "taskIntent": ["taskType": "meeting_minutes", "executionProfile": "audio_minutes", "reasoningDepth": "deep"], "requestedAt": "2026-05-24T00:00:00Z"], to: syntheticRun.appendingPathComponent("task.json"))
  try writeJSON([
    "schemaVersion": "feishu-run-state-v1",
    "runId": "synthetic",
    "status": "failed",
    "updatedAt": "2026-05-24T00:01:00Z",
    "steps": [["name": "asr", "status": "blocked", "at": "2026-05-24T00:00:30Z", "reason": "local_asr_service_not_running"]]
  ], to: syntheticRun.appendingPathComponent("state.json"))
  try writeJSON(["runId": "synthetic", "toolCalls": [["name": "local_asr", "status": "blocked"]], "qaGate": ["status": "qa_blocked"]], to: syntheticRun.appendingPathComponent("run.metrics.json"))
  try writeJSON(["status": "failed", "summary": "document_worker_deadline_exhausted context_gate_failed"], to: syntheticRun.appendingPathComponent("agent-output.json"))
  try writeJSON(["status": "failed", "reason": "publish_failed"], to: syntheticRun.appendingPathComponent("publish.json"))
  let synthetic = try WorkbenchRunLoader(runsRoot: tempRoot.appendingPathComponent("runs")).listRuns()
  try expect(synthetic.first?.failureReasons.map(\.rawValue).sorted() == FailureReason.allCases.map(\.rawValue).sorted(), "failure classification incomplete")
  try expect(synthetic.first?.contractWarnings.isEmpty == true, "valid synthetic run failed runtime contract validation")

  let contract = RuntimeContract.load(runsRoot: root)
  try expect(contract.available, "runtime contract manifest was not loaded")
  let driftWarnings = contract.validate(
    task: ["schemaVersion": "feishu-task-v1", "status": "running", "taskIntent": ["taskType": "meeting_minutes", "executionProfile": "direct_answer", "reasoningDepth": "shallow"]],
    state: ["schemaVersion": "feishu-run-state-v1", "status": "mystery", "steps": [["name": "asr", "status": "done"]]]
  )
  try expect(driftWarnings.contains("execution_profile_unknown:direct_answer"), "execution profile drift was not detected")
  try expect(driftWarnings.contains("run_status_unknown:mystery"), "run status drift was not detected")

  print("AgentWorkbenchSmokeTest passed: runs=\(runs.count), selected=\(loaded.id), streams=\(loaded.streamEvents.count), tools=\(loaded.toolCalls.count), contextPacks=\(loaded.sourceContext.contextPacks.count)")
}

do {
  try runSmoke()
} catch {
  fputs("AgentWorkbenchSmokeTest failed: \(error)\n", stderr)
  exit(1)
}
