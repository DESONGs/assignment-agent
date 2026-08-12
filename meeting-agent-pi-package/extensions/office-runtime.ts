import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(extensionDir);
const workspaceDir = dirname(packageDir);

const CHANNEL = Type.Union([Type.Literal("feishu"), Type.Literal("wechat"), Type.Literal("local")]);
const OBJECT_TYPE = Type.Union([
  Type.Literal("document"),
  Type.Literal("file"),
  Type.Literal("meeting"),
  Type.Literal("transcript_summary"),
  Type.Literal("task"),
  Type.Literal("calendar_event"),
  Type.Literal("contact"),
  Type.Literal("project"),
  Type.Literal("customer"),
  Type.Literal("preference"),
  Type.Literal("run"),
]);
const DOCUMENT_ACTION = Type.Union([
  Type.Literal("create"),
  Type.Literal("overwrite"),
  Type.Literal("revised"),
  Type.Literal("rewrite_section"),
  Type.Literal("section_rewritten"),
  Type.Literal("generate_diff"),
  Type.Literal("diff_generated"),
  Type.Literal("comment"),
  Type.Literal("merge"),
  Type.Literal("delete"),
  Type.Literal("clear"),
  Type.Literal("remove"),
  Type.Literal("destroy"),
]);

const DESTRUCTIVE_ACTIONS = new Set(["delete", "clear", "remove", "destroy"]);
const SECRET_KEY_PATTERN = /authorization|cookie|secret|token|session/i;
const SECRET_VALUE_PATTERN =
  /(app_secret|client_secret|refresh_token|access_token|authorization|cookie|session)\s*[:=]\s*["']?[^"',\s]+|bearer\s+[A-Za-z0-9._-]+/gi;

function nowIso() {
  return new Date().toISOString();
}

function defaultOutputRoot() {
  return join(workspaceDir, "runtime-runs");
}

function isInside(parent: string, child: string) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeSegment(input?: string, fallback = "item") {
  const value = input?.trim() || `${fallback}_${randomUUID().slice(0, 8)}`;
  const cleaned = value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === "..") throw new Error("unsafe_runtime_segment_blocked");
  return cleaned;
}

function runtimeRoot(outputRoot?: string) {
  const root = resolve(outputRoot ?? defaultOutputRoot());
  if (!isInside(workspaceDir, root)) throw new Error("office_runtime_output_root_outside_workspace_blocked");
  mkdirSync(root, { recursive: true });
  return root;
}

function runDir(runId: string, outputRoot?: string) {
  const root = runtimeRoot(outputRoot);
  const path = resolve(root, safeSegment(runId, "run"));
  if (!isInside(root, path)) throw new Error("office_runtime_run_dir_outside_root_blocked");
  mkdirSync(path, { recursive: true });
  return path;
}

function artifactPath(runId: string, name: string, outputRoot?: string) {
  const dir = runDir(runId, outputRoot);
  const path = resolve(dir, safeSegment(name, "artifact"));
  if (!isInside(dir, path)) throw new Error("office_runtime_artifact_path_outside_run_blocked");
  return path.endsWith(".json") ? path : `${path}.json`;
}

function redactString(value: string) {
  return value.replace(SECRET_VALUE_PATTERN, "[redacted]");
}

function hasSecretLikeValue(value: string) {
  SECRET_VALUE_PATTERN.lastIndex = 0;
  return SECRET_VALUE_PATTERN.test(value);
}

function sanitize(value: unknown): unknown {
  if (typeof value === "string") return redactString(value).slice(0, 20000);
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      if (/secret|cookie|session|authorization/i.test(key) && !/folderToken|fileToken|wikiToken/i.test(key)) {
        out[key] = "[redacted]";
      } else {
        out[key] = sanitize(entryValue);
      }
    }
    return out;
  }
  return value;
}

function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function boundedPreview(value?: string, max = 900) {
  return redactString(String(value ?? "").replace(/\s+/g, " ").trim()).slice(0, max);
}

function containsSecretRisk(value: unknown, path: string[] = []): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const nested = containsSecretRisk(value[index], [...path, String(index)]);
      if (nested) return nested;
    }
    return null;
  }
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    const joined = [...path, key].join(".");
    if (SECRET_KEY_PATTERN.test(key) && !/fileToken|folderToken|wikiToken|sourceRun|rawSecretsReturned/i.test(key)) {
      return joined;
    }
    if (typeof entryValue === "string" && hasSecretLikeValue(entryValue)) return joined;
    const nested = containsSecretRisk(entryValue, [...path, key]);
    if (nested) return nested;
  }
  return null;
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(sanitize(value), null, 2)}\n`, "utf8");
  return path;
}

function loadJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function defaultContext(params: any) {
  return {
    contextId: params.contextId ?? hashText([params.channel ?? "local", params.conversationId ?? "", params.actorId ?? ""].join(":")).slice(0, 24),
    actor: params.actor ?? { actorId: params.actorId ?? null },
    conversation: params.conversation ?? { conversationId: params.conversationId ?? null },
    workspace: params.workspace ?? { workspaceId: params.workspaceId ?? "local-runtime" },
    replyTarget: params.replyTarget ?? null,
    permissions: params.permissions ?? {},
  };
}

function defaultSourceRun(params: any) {
  return {
    runId: params.sourceRunId ?? params.runId,
    version: params.sourceRunVersion ?? "v1",
    artifactPointer: params.sourceArtifactPointer ?? null,
  };
}

function buildLifecyclePlan(params: any) {
  const action = String(params.action ?? "create");
  const destructive = DESTRUCTIVE_ACTIONS.has(action);
  const modifiesExisting = ["overwrite", "revised", "rewrite_section", "section_rewritten", "comment"].includes(action);
  const targetSpecified = Boolean(params.targetFileToken || params.targetArtifactPointer || params.generatedInCurrentConversation);
  const status = destructive ? "blocked" : modifiesExisting && !targetSpecified ? "needs_confirmation" : "ready";
  const reasons = [];
  if (destructive) reasons.push("destructive_document_action_blocked");
  if (modifiesExisting && !targetSpecified) reasons.push("document_modify_target_required");
  if (reasons.length === 0) reasons.push("document_lifecycle_action_ready");

  return {
    schemaVersion: "document-lifecycle-plan-v1",
    status,
    action,
    documentId: params.documentId ?? `doc_${randomUUID().slice(0, 8)}`,
    channel: params.channel ?? "local",
    target: {
      targetType: params.targetFileToken ? "explicit_file_token" : params.targetArtifactPointer ? "generated_artifact" : "none",
      fileToken: params.targetFileToken ?? null,
      artifactPointer: params.targetArtifactPointer ?? null,
      generatedInCurrentConversation: Boolean(params.generatedInCurrentConversation),
    },
    sourceRun: defaultSourceRun(params),
    nextVersion: params.nextVersion ?? "v1",
    reasons,
    requiredPolicyIntent: destructive ? "delete" : modifiesExisting || action === "create" ? "write_private" : "draft",
    destructiveActionsAllowed: false,
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };
}

function buildLifecycleArtifact(params: any, plan: any) {
  return {
    schemaVersion: "document-lifecycle-v1",
    version: plan.nextVersion ?? params.version ?? "v1",
    documentId: plan.documentId,
    channel: plan.channel,
    context: defaultContext(params),
    sourceRun: plan.sourceRun,
    currentState: plan.status === "blocked" ? "blocked" : params.currentState ?? "draft",
    target: plan.target,
    lifecycleEvents: [
      {
        eventId: `event_${randomUUID().slice(0, 8)}`,
        action:
          plan.action === "create"
            ? "created"
            : plan.action === "overwrite" || plan.action === "revised"
              ? "revised"
              : plan.action === "rewrite_section" || plan.action === "section_rewritten"
                ? "section_rewritten"
                : plan.action === "generate_diff" || plan.action === "diff_generated"
                  ? "diff_generated"
                  : plan.action === "merge"
                    ? "merged"
                    : plan.status === "blocked"
                      ? "blocked"
                      : "comment_added",
        sourceRun: plan.sourceRun,
        version: plan.nextVersion ?? "v1",
        artifactPointer: params.artifactPointer ?? params.targetArtifactPointer ?? "pending-artifact",
        diffPointer: params.diffPointer ?? null,
        summaryPointer: params.summaryPointer ?? null,
        requiresConfirmation: plan.status === "needs_confirmation",
        confirmationStatus: plan.status === "needs_confirmation" ? "pending" : "not_required",
      },
    ],
    destructiveActionsAllowed: false,
    rawSecretsReturned: false,
    rawMediaExternalUpload: false,
  };
}

function normalizeRetrievalEntry(params: any, entry: any, index: number) {
  return {
    entryId: entry.entryId ?? `entry_${hashText(JSON.stringify(entry)).slice(0, 12)}_${index}`,
    objectType: entry.objectType ?? "run",
    channel: entry.channel ?? params.channel ?? "local",
    context: entry.context ?? defaultContext(params),
    sourceRun: entry.sourceRun ?? defaultSourceRun(params),
    version: entry.version ?? "v1",
    title: boundedPreview(entry.title, 180),
    summary: boundedPreview(entry.summary, 1200),
    boundedPreview: boundedPreview(entry.boundedPreview ?? entry.preview, 900),
    tags: Array.isArray(entry.tags) ? entry.tags.map((tag: unknown) => String(tag).slice(0, 80)) : [],
    pointers: {
      artifactPointer: entry.pointers?.artifactPointer ?? entry.artifactPointer,
      summaryPointer: entry.pointers?.summaryPointer ?? entry.summaryPointer ?? null,
      metadataPointer: entry.pointers?.metadataPointer ?? entry.metadataPointer ?? null,
      embeddingPointer: entry.pointers?.embeddingPointer ?? null,
    },
    pointerOnly: true,
  };
}

function matchScore(entry: any, query: string) {
  const haystack = [entry.title, entry.summary, entry.boundedPreview, ...(entry.tags ?? [])].join(" ").toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "document_lifecycle_plan",
    label: "Document Lifecycle Plan",
    description: "Plan document create/overwrite/rewrite/diff actions with destructive actions blocked and explicit target checks.",
    parameters: Type.Object({
      runId: Type.String(),
      action: DOCUMENT_ACTION,
      channel: Type.Optional(CHANNEL),
      documentId: Type.Optional(Type.String()),
      targetFileToken: Type.Optional(Type.String()),
      targetArtifactPointer: Type.Optional(Type.String()),
      generatedInCurrentConversation: Type.Optional(Type.Boolean()),
      sourceRunId: Type.Optional(Type.String()),
      sourceRunVersion: Type.Optional(Type.String()),
      sourceArtifactPointer: Type.Optional(Type.String()),
      nextVersion: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const details = buildLifecyclePlan(params);
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "document_lifecycle_write",
    label: "Document Lifecycle Write",
    description: "Write a document-lifecycle.json artifact with sourceRun and version metadata.",
    parameters: Type.Object({
      runId: Type.String(),
      plan: Type.Optional(Type.Any()),
      action: Type.Optional(DOCUMENT_ACTION),
      channel: Type.Optional(CHANNEL),
      documentId: Type.Optional(Type.String()),
      artifactPointer: Type.Optional(Type.String()),
      diffPointer: Type.Optional(Type.String()),
      summaryPointer: Type.Optional(Type.String()),
      targetFileToken: Type.Optional(Type.String()),
      targetArtifactPointer: Type.Optional(Type.String()),
      generatedInCurrentConversation: Type.Optional(Type.Boolean()),
      contextId: Type.Optional(Type.String()),
      actor: Type.Optional(Type.Any()),
      conversation: Type.Optional(Type.Any()),
      workspace: Type.Optional(Type.Any()),
      sourceRunId: Type.Optional(Type.String()),
      outputRoot: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      try {
        const risk = containsSecretRisk(params);
        if (risk) throw new Error(`office_runtime_secret_payload_blocked:${risk}`);
        const plan = params.plan ?? buildLifecyclePlan({ ...params, action: params.action ?? "create" });
        const artifact = buildLifecycleArtifact(params, plan);
        const path = writeJson(artifactPath(params.runId, "document-lifecycle.json", params.outputRoot), artifact);
        const details = { ok: true, status: artifact.currentState, documentLifecyclePath: path, rawSecretsReturned: false, rawMediaExternalUpload: false };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const details = { ok: false, status: "blocked", reason: error instanceof Error ? error.message : String(error), rawSecretsReturned: false };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      }
    },
  });

  pi.registerTool({
    name: "office_object_write",
    label: "Office Object Write",
    description: "Write a pointer-only office-object.json reference for documents, tasks, calendar events, contacts, projects, preferences, or runs.",
    parameters: Type.Object({
      runId: Type.String(),
      objectId: Type.Optional(Type.String()),
      objectType: OBJECT_TYPE,
      title: Type.Optional(Type.String()),
      channel: Type.Optional(CHANNEL),
      visibility: Type.Optional(Type.Union([Type.Literal("private"), Type.Literal("conversation"), Type.Literal("workspace"), Type.Literal("customer_visible")])),
      artifactPointer: Type.Optional(Type.String()),
      summaryPointer: Type.Optional(Type.String()),
      metadataPointer: Type.Optional(Type.String()),
      sourcePointer: Type.Optional(Type.String()),
      contextId: Type.Optional(Type.String()),
      actor: Type.Optional(Type.Any()),
      conversation: Type.Optional(Type.Any()),
      workspace: Type.Optional(Type.Any()),
      sourceRunId: Type.Optional(Type.String()),
      outputRoot: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      try {
        const risk = containsSecretRisk(params);
        if (risk) throw new Error(`office_runtime_secret_payload_blocked:${risk}`);
        const object = {
          schemaVersion: "office-object-v1",
          version: "v1",
          objectId: params.objectId ?? `${params.objectType}_${randomUUID().slice(0, 8)}`,
          objectType: params.objectType,
          title: params.title ?? null,
          channel: params.channel ?? "local",
          context: defaultContext(params),
          sourceRun: defaultSourceRun(params),
          visibility: params.visibility ?? "private",
          pointers: {
            artifactPointer: params.artifactPointer ?? null,
            summaryPointer: params.summaryPointer ?? null,
            metadataPointer: params.metadataPointer ?? null,
            sourcePointer: params.sourcePointer ?? null,
          },
          rawSecretsReturned: false,
          rawMediaExternalUpload: false,
        };
        const path = writeJson(artifactPath(params.runId, `office-object-${object.objectId}.json`, params.outputRoot), object);
        const details = { ok: true, officeObjectPath: path, objectId: object.objectId, rawSecretsReturned: false };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const details = { ok: false, status: "blocked", reason: error instanceof Error ? error.message : String(error), rawSecretsReturned: false };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      }
    },
  });

  pi.registerTool({
    name: "retrieval_index_write",
    label: "Retrieval Index Write",
    description: "Write a compact retrieval-index.json artifact with pointers and bounded previews. Credentials and authentication state are blocked.",
    parameters: Type.Object({
      runId: Type.String(),
      indexId: Type.Optional(Type.String()),
      channel: Type.Optional(CHANNEL),
      contextId: Type.Optional(Type.String()),
      actor: Type.Optional(Type.Any()),
      conversation: Type.Optional(Type.Any()),
      workspace: Type.Optional(Type.Any()),
      sourceRunId: Type.Optional(Type.String()),
      sourceArtifactPointer: Type.Optional(Type.String()),
      entries: Type.Array(Type.Any()),
      outputRoot: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      try {
        const risk = containsSecretRisk(params);
        if (risk) throw new Error(`retrieval_index_secret_payload_blocked:${risk}`);
        const entries = params.entries.map((entry: unknown, index: number) => normalizeRetrievalEntry(params, entry, index));
        const missingPointer = entries.find((entry: any) => !entry.pointers.artifactPointer);
        if (missingPointer) throw new Error("retrieval_index_artifact_pointer_required");
        const index = {
          schemaVersion: "retrieval-index-v1",
          version: "v1",
          indexId: params.indexId ?? `index_${safeSegment(params.runId, "run")}`,
          generatedAt: nowIso(),
          channel: params.channel ?? "local",
          context: defaultContext(params),
          sourceRun: defaultSourceRun(params),
          pointerOnly: true,
          entries,
          rawSecretsReturned: false,
          rawMediaExternalUpload: false,
        };
        const path = writeJson(artifactPath(params.runId, "retrieval-index.json", params.outputRoot), index);
        const details = { ok: true, retrievalIndexPath: path, entryCount: entries.length, pointerOnly: true, rawSecretsReturned: false };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const details = { ok: false, status: "blocked", reason: error instanceof Error ? error.message : String(error), rawSecretsReturned: false };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      }
    },
  });

  pi.registerTool({
    name: "retrieval_index_search",
    label: "Retrieval Index Search",
    description: "Search a pointer-only retrieval index and return bounded previews plus artifact pointers.",
    parameters: Type.Object({
      indexPath: Type.String(),
      query: Type.String(),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params) {
      try {
        const path = resolve(params.indexPath);
        if (!isInside(workspaceDir, path)) throw new Error("retrieval_index_path_outside_workspace_blocked");
        if (!existsSync(path)) throw new Error("retrieval_index_missing");
        const index = loadJson(path);
        if (index.pointerOnly !== true) throw new Error("retrieval_index_pointer_only_required");
        const results = (index.entries ?? [])
          .map((entry: any) => ({ ...entry, score: matchScore(entry, params.query) }))
          .filter((entry: any) => entry.score > 0)
          .sort((a: any, b: any) => b.score - a.score)
          .slice(0, Math.max(1, Math.min(Number(params.limit ?? 5), 20)))
          .map((entry: any) => ({
            entryId: entry.entryId,
            objectType: entry.objectType,
            title: entry.title ?? null,
            summary: boundedPreview(entry.summary, 500),
            boundedPreview: boundedPreview(entry.boundedPreview, 300),
            pointers: entry.pointers,
            sourceRun: entry.sourceRun,
            score: entry.score,
            pointerOnly: true,
          }));
        const details = { ok: true, results, rawSecretsReturned: false, rawMediaExternalUpload: false };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      } catch (error) {
        const details = { ok: false, status: "blocked", reason: error instanceof Error ? error.message : String(error), rawSecretsReturned: false };
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      }
    },
  });

}
