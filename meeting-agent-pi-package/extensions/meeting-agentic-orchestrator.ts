import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMeetingOrchestrationPlan } from "../tools/meeting_workflow_helpers.mjs";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(extensionDir);
const workspaceDir = dirname(packageDir);

function isInside(parent: string, child: string) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function workspacePath(value: string | undefined, required = false) {
  if (!value) {
    if (required) throw new Error("meeting_analysis_path_required");
    return null;
  }
  const path = resolve(workspaceDir, value);
  if (!isInside(workspaceDir, path)) throw new Error("meeting_agentic_path_outside_workspace_blocked");
  return path;
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "meeting_agentic_plan",
    label: "Meeting Agentic Plan",
    description: "Choose direct parent reasoning, one fresh subagent, or a schema-validated dynamic workflow from the current Meeting Intelligence complexity. This tool plans delegation; the Pi parent remains the final authority.",
    parameters: Type.Object({
      meetingAnalysis: Type.Optional(Type.Any()),
      meetingAnalysisPath: Type.Optional(Type.String()),
      transcriptPath: Type.String(),
      participantMapPath: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      try {
        const analysisPath = workspacePath(params.meetingAnalysisPath, !params.meetingAnalysis);
        const transcriptPath = workspacePath(params.transcriptPath, true);
        const participantMapPath = workspacePath(params.participantMapPath);
        const analysis = params.meetingAnalysis ?? readJson(analysisPath as string);
        const details = buildMeetingOrchestrationPlan(analysis, {
          meetingAnalysisPath: analysisPath ?? "provided-inline",
          transcriptPath,
          participantMapPath,
        });
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const details = {
          status: "blocked",
          reason: error instanceof Error ? error.message : String(error),
          rawSecretsReturned: false,
        };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      }
    },
  });
}
