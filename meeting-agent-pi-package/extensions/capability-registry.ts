import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Capability = {
  capabilityId: string;
  status: string;
  description?: string;
  defaultLoad?: boolean;
  contextCost?: string;
  toolPackage?: string;
  toolIntents?: string[];
  policy?: string[];
  observability?: string[];
  installState?: string;
  securityReview?: {
    status?: string;
    summary?: string;
    requiredBeforeEnable?: string[];
    auditArtifactRequired?: boolean;
  };
  triggers?: string[];
  env?: string[];
  optionalEnv?: string[];
  commands?: string[];
  permissions?: string[];
  candidatePackages?: string[];
  testCommand?: string;
  guardrails?: string[];
};

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(extensionDir);
const registryPath = join(packageDir, "runtime", "capability-registry.json");

function loadRegistry() {
  return JSON.parse(readFileSync(registryPath, "utf8")) as {
    version: string;
    defaults: { alwaysOn?: string[]; loadPolicy?: string };
    capabilities: Capability[];
  };
}

function normalized(value: string) {
  return value.toLowerCase();
}

function matchesTask(capability: Capability, taskDescription: string) {
  const task = normalized(taskDescription);
  const searchable = [
    capability.capabilityId,
    capability.description ?? "",
    ...(capability.triggers ?? []),
    ...(capability.toolIntents ?? []),
    ...(capability.policy ?? []),
  ];
  return searchable.some((value) => value && task.includes(normalized(value)));
}

function envStatus(names: string[] = []) {
  return names.map((name) => ({
    name,
    present: Boolean(process.env[name]?.trim()),
  }));
}

function isSupportedCommandName(command: string) {
  return /^[A-Za-z0-9._-]+$/.test(command) && !command.includes("/") && !command.includes("\\");
}

function findExecutableOnPath(command: string) {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = join(entry, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue checking PATH entries without executing candidate commands.
    }
  }
  return null;
}

function commandStatus(commands: string[] = []) {
  return commands.map((command) => {
    if (!command || !isSupportedCommandName(command)) {
      return {
        command,
        available: false,
        reason: "unsupported_command_probe",
        probe: "path_lookup_only",
      };
    }
    const resolvedPath = findExecutableOnPath(command);
    return {
      command,
      available: Boolean(resolvedPath),
      reason: resolvedPath ? "found_on_path" : "not_found_on_path",
      probe: "path_lookup_only",
    };
  });
}

function capabilityCheck(capability: Capability) {
  const env = envStatus(capability.env);
  const optionalEnv = envStatus(capability.optionalEnv);
  const commands = commandStatus(capability.commands);
  const missingEnv = env.filter((item) => !item.present).map((item) => item.name);
  const missingCommands = commands.filter((item) => !item.available).map((item) => item.command);
  const ready =
    capability.status === "available" &&
    missingEnv.length === 0 &&
    missingCommands.length === 0;

  return {
    capabilityId: capability.capabilityId,
    status: capability.status,
    description: capability.description ?? "",
    ready,
    defaultLoad: capability.defaultLoad === true,
    contextCost: capability.contextCost ?? "unknown",
    toolPackage: capability.toolPackage ?? "unknown",
    toolIntents: capability.toolIntents ?? [],
    policy: capability.policy ?? [],
    observability: capability.observability ?? [],
    installState: capability.installState ?? "unknown",
    securityReview: capability.securityReview ?? { status: "missing", summary: "security review metadata not recorded" },
    env,
    optionalEnv,
    missingEnv,
    commands,
    missingCommands,
    permissions: capability.permissions ?? [],
    candidatePackages: capability.candidatePackages ?? [],
    testCommand: capability.testCommand ?? null,
    guardrails: capability.guardrails ?? [],
    rawSecretsReturned: false,
  };
}

function needsSecurityReview(capability: Capability) {
  const thirdParty = capability.toolPackage === "third-party" || capability.toolPackage === "third-party-or-mcp";
  const reviewStatus = capability.securityReview?.status ?? "missing";
  return thirdParty && reviewStatus !== "passed";
}

function planCapabilities(taskDescription: string) {
  const registry = loadRegistry();
  const alwaysOn = registry.capabilities.filter((capability) =>
    (registry.defaults.alwaysOn ?? []).includes(capability.capabilityId),
  );
  const matched = registry.capabilities.filter((capability) => matchesTask(capability, taskDescription));
  const merged = new Map<string, Capability>();
  for (const capability of [...alwaysOn, ...matched]) {
    merged.set(capability.capabilityId, capability);
  }

  const recommended = [...merged.values()].map((capability) => ({
    ...capabilityCheck(capability),
    reason: (registry.defaults.alwaysOn ?? []).includes(capability.capabilityId)
      ? "always_on_minimal_kernel"
      : "matched_task_trigger",
    plannerSelectable: true,
  }));
  const skipped = registry.capabilities
    .filter((capability) => !merged.has(capability.capabilityId))
    .map((capability) => ({
      capabilityId: capability.capabilityId,
      status: capability.status,
      reason: capability.defaultLoad ? "not_matched_for_task" : "lazy_not_requested",
      contextCost: capability.contextCost ?? "unknown",
      installState: capability.installState ?? "unknown",
      securityReview: capability.securityReview ?? { status: "missing", summary: "security review metadata not recorded" },
    }));

  return {
    registryVersion: registry.version,
    loadPolicy: registry.defaults.loadPolicy,
    taskDescription,
    recommended,
    skipped,
    rawSecretsReturned: false,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "capability_registry_list",
    label: "Capability Registry List",
    description: "List PI runtime capabilities and their lazy-load status without loading optional integrations.",
    parameters: Type.Object({
      taskType: Type.Optional(Type.String({ description: "Optional task hint used only for filtering recommendations." })),
    }),
    async execute(_toolCallId, params) {
      const registry = loadRegistry();
      const capabilities = registry.capabilities.map((capability) => ({
        capabilityId: capability.capabilityId,
        status: capability.status,
        description: capability.description ?? "",
        defaultLoad: capability.defaultLoad === true,
        contextCost: capability.contextCost ?? "unknown",
        toolPackage: capability.toolPackage ?? "unknown",
        toolIntents: capability.toolIntents ?? [],
        policy: capability.policy ?? [],
        observability: capability.observability ?? [],
        installState: capability.installState ?? "unknown",
        securityReview: capability.securityReview ?? { status: "missing", summary: "security review metadata not recorded" },
        triggers: capability.triggers ?? [],
        env: capability.env ?? [],
        optionalEnv: capability.optionalEnv ?? [],
        guardrails: capability.guardrails ?? [],
        candidatePackages: capability.candidatePackages ?? [],
        recommendedForTask: params.taskType ? matchesTask(capability, params.taskType) : capability.defaultLoad === true,
      }));
      const details = {
        registryVersion: registry.version,
        loadPolicy: registry.defaults.loadPolicy,
        alwaysOn: registry.defaults.alwaysOn ?? [],
        capabilities,
        registryPath,
      };
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "capability_registry_plan",
    label: "Capability Registry Plan",
    description: "Plan which lazy PI capabilities should be enabled for a concrete task.",
    parameters: Type.Object({
      taskDescription: Type.String({ description: "User task or runtime task summary." }),
    }),
    async execute(_toolCallId, params) {
      const details = planCapabilities(params.taskDescription);
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "capability_registry_check",
    label: "Capability Registry Check",
    description: "Check one capability's local readiness. Secret values are not returned.",
    parameters: Type.Object({
      capabilityId: Type.String(),
    }),
    async execute(_toolCallId, params) {
      const registry = loadRegistry();
      const capability = registry.capabilities.find((item) => item.capabilityId === params.capabilityId);
      if (!capability) {
        const blocked = {
          status: "blocked",
          reason: "capability_not_found",
          capabilityId: params.capabilityId,
          availableCapabilityIds: registry.capabilities.map((item) => item.capabilityId),
        };
        return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
      }
      const details = capabilityCheck(capability);
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });

  pi.registerTool({
    name: "capability_registry_enable",
    label: "Capability Registry Enable Plan",
    description: "Return an enablement plan for a capability. This does not install packages or mutate config.",
    parameters: Type.Object({
      capabilityId: Type.String(),
      reason: Type.String({ description: "Why this capability is needed for the current task." }),
    }),
    async execute(_toolCallId, params) {
      const registry = loadRegistry();
      const capability = registry.capabilities.find((item) => item.capabilityId === params.capabilityId);
      if (!capability) {
        const blocked = { status: "blocked", reason: "capability_not_found", capabilityId: params.capabilityId };
        return { content: [{ type: "text", text: JSON.stringify(blocked, null, 2) }], details: blocked };
      }
      const check = capabilityCheck(capability);
      const securityReviewRequired = needsSecurityReview(capability);
      const details = {
        status: securityReviewRequired ? "needs_security_review" : check.ready ? "ready_to_enable" : "needs_setup",
        reason: params.reason,
        capability: check,
        mutationPerformed: false,
        packageInstallRequired:
          capability.toolPackage === "third-party" || capability.toolPackage === "third-party-or-mcp"
            ? capability.candidatePackages ?? []
            : [],
        nextSteps: [
          check.missingEnv.length ? `Set required env: ${check.missingEnv.join(", ")}` : null,
          check.missingCommands.length ? `Install or configure command: ${check.missingCommands.join(", ")}` : null,
          capability.testCommand ? `Run smoke test: ${capability.testCommand}` : null,
          securityReviewRequired ? "Record package-audit artifact before install or enable." : null,
          securityReviewRequired ? "Keep defaultLoad=false until security review and smoke test pass." : null,
        ].filter(Boolean),
      };
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    },
  });
}
