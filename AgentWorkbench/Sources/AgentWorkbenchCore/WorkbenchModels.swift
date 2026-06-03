import Foundation

public struct RequiredRuntimeFiles: Sendable {
  public let task: Bool
  public let state: Bool
  public let metrics: Bool
  public let agentOutput: Bool
  public let publish: Bool

  public var allPresent: Bool {
    task && state && metrics && agentOutput && publish
  }
}

public struct RunSummary: Identifiable, Sendable {
  public let id: String
  public let runDir: URL
  public let status: String
  public let taskType: String
  public let requestedAt: String?
  public let updatedAt: String?
  public let requiredFiles: RequiredRuntimeFiles
  public let streamEventCount: Int
  public let toolCallCount: Int
  public let contextPackCount: Int
  public let artifactCount: Int
  public let qaStatus: String
  public let policyStatus: String
  public let publishStatus: String
  public let failureReasons: [FailureReason]
}

public enum FailureReason: String, CaseIterable, Identifiable, Sendable {
  case localAsrServiceNotRunning = "local_asr_service_not_running"
  case documentWorkerDeadlineExhausted = "document_worker_deadline_exhausted"
  case contextGateFailed = "context_gate_failed"
  case qaBlocked = "qa_blocked"
  case publishFailed = "publish_failed"

  public var id: String { rawValue }
}

public struct TimelineEvent: Identifiable, Sendable {
  public let id: String
  public let name: String
  public let status: String
  public let at: String?
  public let artifact: String?
  public let detail: String
}

public struct StreamEvent: Identifiable, Sendable {
  public let id: String
  public let file: String
  public let event: String
  public let at: String?
  public let provider: String?
  public let model: String?
  public let status: String?
  public let reason: String?
  public let contextPackId: String?
  public let sourceSegmentIds: [String]
  public let promptBudgetChars: Int?
  public let preview: String
}

public struct ToolCallEvent: Identifiable, Sendable {
  public let id: String
  public let toolName: String
  public let startedAt: String?
  public let finishedAt: String?
  public let durationMs: Int?
  public let status: String
  public let exitCode: Int?
  public let stderrTail: String?
  public let preview: String
}

public struct ArtifactPreview: Identifiable, Sendable {
  public let id: String
  public let relativePath: String
  public let kind: String
  public let sizeBytes: Int64
  public let preview: String
}

public struct RequiredFilePreview: Identifiable, Sendable {
  public let id: String
  public let name: String
  public let present: Bool
  public let preview: String
}

public struct SourceRecordPreview: Identifiable, Sendable {
  public let id: String
  public let sourceType: String
  public let status: String
  public let title: String
}

public struct SourceSegmentPreview: Identifiable, Sendable {
  public let id: String
  public let sourceId: String
  public let sourceType: String
  public let segmentKind: String
  public let quality: String
  public let boundedPreview: String
}

public struct ContextPackPreview: Identifiable, Sendable {
  public let id: String
  public let workUnitId: String
  public let docType: String
  public let sourceSegmentIds: [String]
  public let sourceBlockIds: [String]
  public let promptBudgetChars: Int?
  public let boundedSegmentPreviews: [SourceSegmentPreview]
}

public struct SourceContextSummary: Sendable {
  public let manifestPresent: Bool
  public let manifestPreview: String
  public let sourceRecords: [SourceRecordPreview]
  public let sourceSegments: [SourceSegmentPreview]
  public let contextPacks: [ContextPackPreview]
  public let warnings: [String]
}

public struct RuntimeRun: Identifiable, Sendable {
  public let id: String
  public let runDir: URL
  public let requiredFiles: [RequiredFilePreview]
  public let timeline: [TimelineEvent]
  public let streamEvents: [StreamEvent]
  public let toolCalls: [ToolCallEvent]
  public let sourceContext: SourceContextSummary
  public let artifacts: [ArtifactPreview]
  public let qaStatus: String
  public let policyStatus: String
  public let publishStatus: String
  public let failureReasons: [FailureReason]
  public let safetyNotes: [String]
}
