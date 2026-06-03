import AgentWorkbenchCore
import SwiftUI

@main
struct AgentWorkbenchApp: App {
  var body: some Scene {
    WindowGroup {
      WorkbenchRootView()
        .frame(minWidth: 1180, minHeight: 760)
    }
  }
}

@MainActor
final class WorkbenchViewModel: ObservableObject {
  @Published var runs: [RunSummary] = []
  @Published var selectedRunID: RunSummary.ID?
  @Published var selectedRun: RuntimeRun?
  @Published var errorMessage: String?

  private let loader: WorkbenchRunLoader

  init() {
    let root: URL
    if let argRoot = CommandLine.arguments.dropFirst().first {
      root = URL(fileURLWithPath: argRoot)
    } else {
      root = WorkbenchRunLoader.defaultRunsRoot()
    }
    loader = WorkbenchRunLoader(runsRoot: root)
    refresh()
  }

  func refresh() {
    do {
      runs = try loader.listRuns()
      if selectedRunID == nil {
        selectedRunID = runs.first?.id
      }
      loadSelectedRun()
    } catch {
      errorMessage = String(describing: error)
    }
  }

  func loadSelectedRun() {
    guard let selectedRunID,
          let summary = runs.first(where: { $0.id == selectedRunID })
    else {
      selectedRun = nil
      return
    }
    selectedRun = loader.loadRun(summary.runDir)
  }
}

struct WorkbenchRootView: View {
  @StateObject private var viewModel = WorkbenchViewModel()

  var body: some View {
    NavigationSplitView {
      RunListView(viewModel: viewModel)
        .navigationSplitViewColumnWidth(min: 260, ideal: 340)
    } content: {
      TimelineAndStreamView(run: viewModel.selectedRun)
        .navigationSplitViewColumnWidth(min: 420, ideal: 560)
    } detail: {
      DetailsView(run: viewModel.selectedRun)
    }
    .toolbar {
      ToolbarItem {
        Button {
          viewModel.refresh()
        } label: {
          Label("Refresh", systemImage: "arrow.clockwise")
        }
        .help("Reload local runtime artifacts only. No runtime action is executed.")
      }
    }
    .onChange(of: viewModel.selectedRunID) { _, _ in
      viewModel.loadSelectedRun()
    }
  }
}

struct RunListView: View {
  @ObservedObject var viewModel: WorkbenchViewModel

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("PI Agent Runs")
        .font(.headline)
        .padding(.horizontal)
        .padding(.top, 8)
      Text("Read-only observability")
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal)

      List(viewModel.runs, selection: $viewModel.selectedRunID) { run in
        VStack(alignment: .leading, spacing: 5) {
          Text(run.id)
            .font(.system(.caption, design: .monospaced))
            .lineLimit(2)
          HStack {
            StatusPill(text: run.status)
            StatusPill(text: run.taskType)
          }
          HStack(spacing: 10) {
            Label("\(run.streamEventCount)", systemImage: "waveform")
            Label("\(run.toolCallCount)", systemImage: "wrench.and.screwdriver")
            Label("\(run.contextPackCount)", systemImage: "shippingbox")
          }
          .font(.caption2)
          .foregroundStyle(.secondary)
          if !run.failureReasons.isEmpty {
            Text(run.failureReasons.map(\.rawValue).joined(separator: ", "))
              .font(.caption2)
              .foregroundStyle(.red)
              .lineLimit(2)
          }
        }
        .padding(.vertical, 4)
      }

      if let error = viewModel.errorMessage {
        Text(error)
          .font(.caption)
          .foregroundStyle(.red)
          .padding()
      }
    }
  }
}

struct TimelineAndStreamView: View {
  let run: RuntimeRun?

  var body: some View {
    if let run {
      TabView {
        List(run.timeline) { event in
          VStack(alignment: .leading, spacing: 4) {
            HStack {
              Text(event.name).font(.headline)
              Spacer()
              StatusPill(text: event.status)
            }
            if let at = event.at {
              Text(at).font(.caption).foregroundStyle(.secondary)
            }
            if let artifact = event.artifact {
              Text(artifact).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            Text(event.detail).font(.caption).textSelection(.enabled).lineLimit(6)
          }
          .padding(.vertical, 4)
        }
        .tabItem { Label("Stage Timeline", systemImage: "point.topleft.down.curvedto.point.bottomright.up") }

        List(run.streamEvents) { event in
          VStack(alignment: .leading, spacing: 5) {
            HStack {
              Text(event.event).font(.headline)
              Spacer()
              Text(event.provider ?? "-").foregroundStyle(.secondary)
            }
            HStack {
              if let model = event.model { Text(model) }
              if let at = event.at { Text(at) }
              if let context = event.contextPackId { Text(context) }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            if !event.sourceSegmentIds.isEmpty {
              Text("segments: \(event.sourceSegmentIds.prefix(8).joined(separator: ", "))")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            }
            Text(event.preview).font(.caption).textSelection(.enabled).lineLimit(8)
          }
          .padding(.vertical, 4)
        }
        .tabItem { Label("Model Stream", systemImage: "waveform.path.ecg") }

        List(run.toolCalls) { call in
          VStack(alignment: .leading, spacing: 5) {
            HStack {
              Text(call.toolName).font(.headline)
              Spacer()
              StatusPill(text: call.status)
            }
            HStack {
              if let start = call.startedAt { Text("start \(start)") }
              if let finish = call.finishedAt { Text("finish \(finish)") }
              if let duration = call.durationMs { Text("\(duration)ms") }
              if let exitCode = call.exitCode { Text("exit \(exitCode)") }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            if let stderrTail = call.stderrTail {
              Text(stderrTail).font(.caption).foregroundStyle(.orange).textSelection(.enabled)
            }
            Text(call.preview).font(.caption).textSelection(.enabled).lineLimit(8)
          }
          .padding(.vertical, 4)
        }
        .tabItem { Label("Tools", systemImage: "terminal") }
      }
    } else {
      ContentUnavailableView("No Run Selected", systemImage: "list.bullet.rectangle")
    }
  }
}

struct DetailsView: View {
  let run: RuntimeRun?

  var body: some View {
    if let run {
      TabView {
        RequiredFilesView(run: run)
          .tabItem { Label("Run Files", systemImage: "doc.text.magnifyingglass") }
        SourceContextView(context: run.sourceContext)
          .tabItem { Label("Context", systemImage: "shippingbox") }
        ArtifactListView(artifacts: run.artifacts)
          .tabItem { Label("Artifacts", systemImage: "folder") }
        SafetyStatusView(run: run)
          .tabItem { Label("QA/Policy/Publish", systemImage: "checkmark.shield") }
      }
      .padding(.top, 4)
    } else {
      ContentUnavailableView("Select a run", systemImage: "sidebar.left")
    }
  }
}

struct RequiredFilesView: View {
  let run: RuntimeRun

  var body: some View {
    List(run.requiredFiles) { file in
      VStack(alignment: .leading, spacing: 5) {
        HStack {
          Text(file.name).font(.headline)
          Spacer()
          StatusPill(text: file.present ? "present" : "missing")
        }
        Text(file.preview)
          .font(.system(.caption, design: .monospaced))
          .textSelection(.enabled)
          .lineLimit(12)
      }
      .padding(.vertical, 4)
    }
  }
}

struct SourceContextView: View {
  let context: SourceContextSummary

  var body: some View {
    List {
      Section("Context Manifest") {
        Text(context.manifestPreview)
          .font(.system(.caption, design: .monospaced))
          .textSelection(.enabled)
      }
      Section("Source Records") {
        ForEach(context.sourceRecords) { source in
          HStack {
            Text(source.id).font(.system(.caption, design: .monospaced))
            Text(source.sourceType)
            Spacer()
            StatusPill(text: source.status)
          }
        }
      }
      Section("Source Segments: bounded previews only") {
        ForEach(context.sourceSegments) { segment in
          VStack(alignment: .leading, spacing: 4) {
            HStack {
              Text(segment.id).font(.system(.caption, design: .monospaced))
              Spacer()
              Text(segment.sourceType).foregroundStyle(.secondary)
            }
            Text(segment.boundedPreview).font(.caption).lineLimit(4).textSelection(.enabled)
          }
        }
      }
      Section("Context Packs") {
        ForEach(context.contextPacks) { pack in
          VStack(alignment: .leading, spacing: 5) {
            HStack {
              Text(pack.id).font(.system(.caption, design: .monospaced))
              Spacer()
              Text(pack.docType)
            }
            Text("workUnit: \(pack.workUnitId)")
              .font(.caption)
              .foregroundStyle(.secondary)
            Text("segment refs: \(pack.sourceSegmentIds.prefix(12).joined(separator: ", "))")
              .font(.caption2)
              .foregroundStyle(.secondary)
              .lineLimit(3)
            ForEach(pack.boundedSegmentPreviews.prefix(4)) { preview in
              Text("\(preview.id): \(preview.boundedPreview)")
                .font(.caption2)
                .lineLimit(2)
            }
          }
          .padding(.vertical, 4)
        }
      }
    }
  }
}

struct ArtifactListView: View {
  let artifacts: [ArtifactPreview]

  var body: some View {
    List(artifacts) { artifact in
      VStack(alignment: .leading, spacing: 4) {
        HStack {
          Text(artifact.relativePath).font(.system(.caption, design: .monospaced))
          Spacer()
          StatusPill(text: artifact.kind)
        }
        Text("\(artifact.sizeBytes) bytes").font(.caption2).foregroundStyle(.secondary)
        Text(artifact.preview).font(.caption).textSelection(.enabled).lineLimit(6)
      }
    }
  }
}

struct SafetyStatusView: View {
  let run: RuntimeRun

  var body: some View {
    List {
      Section("Status") {
        LabeledContent("QA", value: run.qaStatus)
        LabeledContent("Policy", value: run.policyStatus)
        LabeledContent("Publish", value: run.publishStatus)
      }
      Section("Failure Classification") {
        if run.failureReasons.isEmpty {
          Text("No P0 tracked failure reason detected.")
        } else {
          ForEach(run.failureReasons) { reason in
            Text(reason.rawValue).foregroundStyle(.red)
          }
        }
      }
      Section("Read-only Boundary") {
        ForEach(run.safetyNotes, id: \.self) { note in
          Text(note)
        }
      }
    }
  }
}

struct StatusPill: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.caption2)
      .padding(.horizontal, 6)
      .padding(.vertical, 3)
      .background(.quaternary, in: Capsule())
  }
}
