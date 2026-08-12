import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type PromptRecord = {
  docType: string;
  promptFile: string;
  aliases: string[];
  parallelizable: boolean;
  dependsOn?: string[];
  audience?: string;
  operationOverlays?: Record<string, string>;
  requiredSections: string[];
};

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(extensionDir);
const workspaceDir = dirname(packageDir);
const promptsDir = join(packageDir, "prompts");
const promptRegistryPath = join(packageDir, "runtime", "document-prompt-registry.json");

const SECRET_PATTERNS = [
  /(app_secret|client_secret|refresh_token|access_token|authorization|cookie|session)\s*[:=]\s*["']?[A-Za-z0-9._\-]{8,}/i,
  /bearer\s+[A-Za-z0-9._\-]{8,}/i,
  /\b(FEISHU_APP_SECRET|DEEPSEEK_API_KEY|XIAOMI_TOKEN_PLAN_SGP_API_KEY)\b/i,
];

function isInside(parent: string, child: string) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function loadPromptRegistry() {
  return JSON.parse(readFileSync(promptRegistryPath, "utf8")) as { version: string; documents: PromptRecord[] };
}

function safePromptPath(promptFile: string) {
  const file = promptFile.trim().endsWith(".md") ? promptFile.trim() : `${promptFile.trim()}.md`;
  if (!/^[A-Za-z0-9_.-]+\.md$/.test(file)) {
    throw new Error("unsafe_prompt_file_blocked");
  }
  const path = resolve(promptsDir, file);
  if (!isInside(promptsDir, path)) {
    throw new Error("prompt_path_outside_prompts_dir_blocked");
  }
  return path;
}

function safeWorkspacePath(path?: string | null) {
  if (!path) return null;
  const resolved = resolve(path);
  if (!isInside(workspaceDir, resolved)) return null;
  return resolved;
}

function readContextManifestSummary(contextEnvelopeRef: string) {
  const resolved = safeWorkspacePath(contextEnvelopeRef);
  if (!resolved || !existsSync(resolved)) return null;
  try {
    const manifest = JSON.parse(readFileSync(resolved, "utf8"));
    return {
      schemaVersion: manifest.schemaVersion ?? null,
      documentIdentity: manifest.documentIdentity
        ? {
            projectName: manifest.documentIdentity.projectName ?? null,
            subject: manifest.documentIdentity.subject ?? null,
            sourceTitle: manifest.documentIdentity.sourceTitle ?? null,
            normalizedTitleBase: manifest.documentIdentity.normalizedTitleBase ?? null,
            confidence: manifest.documentIdentity.confidence ?? null,
            basis: manifest.documentIdentity.basis ?? [],
            warnings: manifest.documentIdentity.warnings ?? [],
            titleByDocType: manifest.documentIdentity.titleByDocType ?? {},
          }
        : null,
      sourceStructurePath: manifest.sourceStructurePath ?? null,
      taskStatePath: manifest.taskStatePath ?? null,
      sourceStructureSummary: manifest.sourceStructureSummary ?? null,
      meetingIntelligence: manifest.meetingIntelligence ?? null,
      outputContract: manifest.outputContract ?? null,
      contextStrategy: manifest.budgetPolicy?.contextStrategy ?? null,
      fullContentAvailableByArtifact: true,
    };
  } catch {
    return null;
  }
}

function promptRecordFor(value: string) {
  const registry = loadPromptRegistry();
  const normalized = value.trim().toLowerCase();
  return registry.documents.find((record) =>
    record.docType === normalized ||
    record.promptFile === normalized ||
    record.aliases.some((alias) => alias.toLowerCase() === normalized),
  );
}

function promptRecordForFile(promptFile: string) {
  const registry = loadPromptRegistry();
  const normalized = promptFile.trim().toLowerCase();
  return registry.documents.find((record) => record.promptFile.toLowerCase() === normalized);
}

function inputPlaceholderCount(template: string) {
  return (template.match(/\{\{input\}\}/g) ?? []).length;
}

function overlayTextFor(record: PromptRecord, operation?: string) {
  if (!operation) return null;
  const overlayFile = record.operationOverlays?.[operation];
  if (!overlayFile) return null;
  const overlayPath = safePromptPath(overlayFile);
  const overlay = readFileSync(overlayPath, "utf8");
  if (overlay.includes("{{input}}")) {
    throw new Error("document_prompt_overlay_placeholder_blocked");
  }
  return { overlayFile, overlayPath, overlay };
}

function listPromptCatalog(includeTemplate = false) {
  const registry = loadPromptRegistry();
  return registry.documents.map((record) => {
    const path = safePromptPath(record.promptFile);
    const template = readFileSync(path, "utf8");
    return {
      docType: record.docType,
      promptFile: record.promptFile,
      promptPath: path,
      aliases: record.aliases,
      parallelizable: record.parallelizable,
      dependsOn: record.dependsOn ?? [],
      audience: record.audience ?? null,
      requiredSections: record.requiredSections,
      operationOverlays: record.operationOverlays ?? {},
      inputPlaceholderCount: inputPlaceholderCount(template),
      hasInputPlaceholder: template.includes("{{input}}"),
      firstLine: template.split(/\r?\n/, 1)[0] ?? "",
      template: includeTemplate ? template : undefined,
    };
  });
}

function normalizeContextBrief(params: {
  routerConclusion?: unknown;
  evidenceSummary?: unknown;
  upstreamDocuments?: unknown;
  reviewContext?: unknown;
  contextEnvelopeRef: string;
  workUnits: unknown[];
}) {
  const blocks: string[] = [];
  blocks.push(
    [
      "## Runtime Context Plane",
      "",
      "Use the attached work unit context pack as the task data plane. It contains the current task contract, selected evidence, semantic state, artifact index, and output contract.",
      "The parent control plane may retrieve additional evidence from indexed artifacts and rebuild the work unit when needed; never assume unselected source content was read.",
      "",
      `contextEnvelopeRef: ${params.contextEnvelopeRef}`,
      `workUnitCount: ${params.workUnits.length}`,
    ].join("\n"),
  );
  const manifestSummary = readContextManifestSummary(params.contextEnvelopeRef);
  if (manifestSummary) {
    blocks.push(`## Document Output Contract\n\n${toMarkdownish(manifestSummary)}`);
  }
  if (params.routerConclusion !== undefined) {
    blocks.push(`## Document Router Conclusion\n\n${toMarkdownish(params.routerConclusion)}`);
  }
  if (params.evidenceSummary !== undefined) {
    blocks.push(`## Evidence Summary\n\n${toMarkdownish(params.evidenceSummary)}`);
  }
  if (params.upstreamDocuments !== undefined) {
    blocks.push(`## Generated Upstream Documents\n\n${toMarkdownish(params.upstreamDocuments)}`);
  }
  if (params.reviewContext !== undefined) {
    blocks.push(`## Review Context\n\n${toMarkdownish(params.reviewContext)}`);
  }
  return blocks.join("\n\n");
}

function toMarkdownish(value: unknown) {
  if (typeof value === "string") return value;
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function containsSecretLikeValue(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function renderWorkItem(params: {
  docType?: string;
  promptFile?: string;
  input?: unknown;
  routerConclusion?: unknown;
  evidenceSummary?: unknown;
  upstreamDocuments?: unknown;
  operation?: string;
  reviewContext?: unknown;
  contextEnvelopeRef?: string;
  workUnits?: unknown[];
}) {
  if (
    containsSecretLikeValue(params.input) ||
    containsSecretLikeValue(params.routerConclusion) ||
    containsSecretLikeValue(params.evidenceSummary) ||
    containsSecretLikeValue(params.upstreamDocuments) ||
    containsSecretLikeValue(params.reviewContext)
  ) {
    throw new Error("document_prompt_secret_like_input_blocked");
  }
  const record = params.promptFile ? promptRecordForFile(params.promptFile) : promptRecordFor(params.docType ?? "");
  if (!record) {
    throw new Error("document_prompt_not_found");
  }
  if (!params.contextEnvelopeRef) {
    throw new Error("context_plane_required");
  }
  const path = safePromptPath(record.promptFile);
  const template = readFileSync(path, "utf8");
  const placeholderCount = inputPlaceholderCount(template);
  if (placeholderCount !== 1) {
    throw new Error("document_prompt_input_placeholder_count_invalid");
  }
  const workUnits = Array.isArray(params.workUnits)
    ? params.workUnits.filter((unit: any) => String(unit?.docType ?? "").toLowerCase() === record.docType)
    : [];
  if (workUnits.length === 0) {
    throw new Error("context_work_units_required");
  }
  const contextBrief = normalizeContextBrief({
    routerConclusion: params.routerConclusion,
    evidenceSummary: params.evidenceSummary,
    upstreamDocuments: params.upstreamDocuments,
    reviewContext: params.reviewContext,
    contextEnvelopeRef: params.contextEnvelopeRef,
    workUnits,
  });
  const overlay = overlayTextFor(record, params.operation);
  const promptBase = template.split("{{input}}").join(contextBrief);
  const promptInstructions = overlay ? `${promptBase}\n\n${overlay.overlay}` : promptBase;
  return {
    docType: record.docType,
    promptFile: record.promptFile,
    promptPath: path,
    aliases: record.aliases,
    parallelizable: record.parallelizable,
    dependsOn: record.dependsOn ?? [],
    audience: record.audience ?? null,
    requiredSections: record.requiredSections,
    operation: params.operation ?? null,
    operationOverlayFile: overlay?.overlayFile ?? null,
    reviewContext: params.reviewContext !== undefined ? params.reviewContext : null,
    contextPlane: params.contextEnvelopeRef
      ? {
          enabled: true,
          contextEnvelopeRef: params.contextEnvelopeRef,
          workUnitCount: workUnits.length,
          promptMode: "hierarchical_work_unit_context_pack",
          fullContentAvailableByArtifact: true,
        }
      : null,
    workUnits,
    promptInstructions,
    promptInstructionChars: promptInstructions.length,
    inputPlaceholderReplaced: true,
    promptLoadMode: "document-prompt-registry",
    promptRegistryPath,
    rawSecretsReturned: false,
  };
}

function selectPrompts(params: { routerDocuments?: string[]; requestedOutputs?: string[]; taskDescription?: string }) {
  const registry = loadPromptRegistry();
  const hints = [...(params.routerDocuments ?? []), ...(params.requestedOutputs ?? [])];
  const taskDescription = params.taskDescription ?? "";
  if (hints.length === 0 && taskDescription.trim()) {
    hints.push(taskDescription);
  }

  const selected = new Map<string, PromptRecord>();
  const unmappedDocuments: string[] = [];
  for (const hint of hints) {
    const normalized = hint.toLowerCase();
    const matches = registry.documents.filter((record) => {
      const terms = [record.docType, record.promptFile, ...record.aliases].map((item) => item.toLowerCase());
      return terms.some((term) => normalized === term || normalized.includes(term));
    });
    if (matches.length === 0 && (params.routerDocuments ?? []).includes(hint)) {
      unmappedDocuments.push(hint);
    }
    for (const record of matches) {
      selected.set(record.docType, record);
    }
  }

  return {
    selectedPrompts: [...selected.values()].map((record) => ({
      docType: record.docType,
      promptFile: record.promptFile,
      aliases: record.aliases,
      dependsOn: record.dependsOn ?? [],
      audience: record.audience ?? null,
      requiredSections: record.requiredSections,
      renderTool: "document_prompt_render",
      parallelizable: record.parallelizable,
    })),
    unmappedDocuments,
    hardcodedDocumentScaffoldUsed: false,
    promptRegistryPath,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "document_prompt_catalog",
    label: "Document Prompt Catalog",
    description: "List document prompt templates exposed by the document-prompt-registry.",
    parameters: Type.Object({
      includeTemplate: Type.Optional(Type.Boolean({ description: "Return full prompt template content." })),
    }),
    async execute(_toolCallId, params) {
      try {
        const details = {
          promptsDir,
          promptRegistryPath,
          prompts: listPromptCatalog(params.includeTemplate === true),
          loadMode: "document-prompt-registry plus explicit local prompt loader",
          rawSecretsReturned: false,
        };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const blocked = { status: "blocked", reason: error instanceof Error ? error.message : String(error) };
        return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
      }
    },
  });

  pi.registerTool({
    name: "document_prompt_select",
    label: "Document Prompt Select",
    description: "Select document prompt templates from router outputs or requested document names.",
    parameters: Type.Object({
      routerDocuments: Type.Optional(Type.Array(Type.String())),
      requestedOutputs: Type.Optional(Type.Array(Type.String())),
      taskDescription: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const details = {
        ...selectPrompts(params),
        selectionMode: "router-or-request-driven",
      };
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "document_prompt_render",
    label: "Document Prompt Render",
    description: "Load a document prompt file from registry and bind it to runtime context-plane work units.",
    parameters: Type.Object({
      docType: Type.Optional(Type.String()),
      promptFile: Type.Optional(Type.String()),
      input: Type.Optional(Type.Any()),
      routerConclusion: Type.Optional(Type.Any()),
      evidenceSummary: Type.Optional(Type.Any()),
      upstreamDocuments: Type.Optional(Type.Any()),
      operation: Type.Optional(Type.String()),
      reviewContext: Type.Optional(Type.Any()),
      contextEnvelopeRef: Type.Optional(Type.String()),
      workUnits: Type.Optional(Type.Array(Type.Any())),
    }),
    async execute(_toolCallId, params) {
      try {
        const details = renderWorkItem(params);
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const blocked = {
          status: "blocked",
          reason: error instanceof Error ? error.message : String(error),
          rawSecretsReturned: false,
        };
        return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
      }
    },
  });

  pi.registerTool({
    name: "document_prompt_render_batch",
    label: "Document Prompt Render Batch",
    description: "Create context-plane document work items from selected prompt templates.",
    parameters: Type.Object({
      documents: Type.Array(Type.String()),
      input: Type.Optional(Type.Any()),
      routerConclusion: Type.Optional(Type.Any()),
      evidenceSummary: Type.Optional(Type.Any()),
      upstreamDocuments: Type.Optional(Type.Any()),
      operation: Type.Optional(Type.String()),
      reviewContext: Type.Optional(Type.Any()),
      contextEnvelopeRef: Type.Optional(Type.String()),
      workUnits: Type.Optional(Type.Array(Type.Any())),
    }),
    async execute(_toolCallId, params) {
      try {
        const documentWorkItems = params.documents.map((docType) =>
          renderWorkItem({
            docType,
            input: params.input,
            routerConclusion: params.routerConclusion,
            evidenceSummary: params.evidenceSummary,
            upstreamDocuments: params.upstreamDocuments,
            operation: params.operation,
            reviewContext: params.reviewContext,
            contextEnvelopeRef: params.contextEnvelopeRef,
            workUnits: params.workUnits,
          }),
        );
        const details = {
          documentWorkItems,
          hardcodedDocumentScaffoldUsed: false,
          promptRegistryPath,
          rawSecretsReturned: false,
        };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const blocked = {
          status: "blocked",
          reason: error instanceof Error ? error.message : String(error),
          rawSecretsReturned: false,
        };
        return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
      }
    },
  });
}
