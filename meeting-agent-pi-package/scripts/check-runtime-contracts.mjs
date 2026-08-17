import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INTERACTION_KINDS,
  INTERACTION_PRIORITIES,
  INTERACTION_STATUSES,
  LEDGER_STATUSES,
  LEDGER_STEP_STATUSES,
  RUNNER_EXECUTION_PROFILES,
  TASK_EXECUTION_PROFILES,
  TASK_REASONING_DEPTHS,
  TASK_RUN_STATUSES,
  TASK_RUN_STEP_STATUSES,
  TASK_TYPES,
  CLOUD_ASR_INPUT_MODES,
  CLOUD_ASR_SUMMARY_STATUSES,
  FEISHU_EVENT_SOURCES,
  MODEL_PROVIDER_PROTOCOLS,
  DOCUMENT_CHECKPOINT_SCHEMA_VERSION,
  DOCUMENT_CHECKPOINT_STATUSES,
  DOCUMENT_WORKER_STATUSES,
  OFFICE_CHANNELS,
  OFFICE_OBJECT_TYPES,
  QA_GATE_SCHEMA_VERSION,
  QA_GATE_STATUSES,
  QA_PROFILES,
  RUNTIME_CONTRACT_SCHEMA_VERSION,
  RUNTIME_STORE_RESULT_STATUSES,
  RUNTIME_STORE_SCHEMA_VERSION,
  SOURCE_CONTEXT_GATE_STATUSES,
  SOURCE_CONTEXT_SCHEMA_VERSION,
} from "../dist/index.js";
import { KNOWN_EXECUTION_PROFILES } from "../tools/task_router.mjs";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeDir = join(packageDir, "runtime");

/** @param {string} name */
function readJson(name) {
  return JSON.parse(readFileSync(join(runtimeDir, name), "utf8"));
}

/** @param {Iterable<string>} actual @param {Iterable<string>} expected @param {string} label */
function assertSameValues(actual, expected, label) {
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${label} drifted from the canonical TypeScript contract`);
}

const feishuTask = readJson("feishu-task.schema.json");
const feishuRunState = readJson("feishu-run-state.schema.json");
const plannerEnvelope = readJson("planner-envelope.schema.json");
const executionProfiles = readJson("execution-profiles.json");
const contractManifest = readJson("contract-manifest.json");
const qaGateSchema = readJson("qa-gate.schema.json");
const sourceContextSchema = readJson("source-context.schema.json");
const checkpointSchema = readJson("document-workflow-checkpoint.schema.json");
const officeObjectSchema = readJson("office-object.schema.json");

assertSameValues(feishuTask.properties.taskIntent.properties.executionProfile.enum, TASK_EXECUTION_PROFILES, "feishu task executionProfile");
assertSameValues(feishuTask.properties.taskIntent.properties.reasoningDepth.enum, TASK_REASONING_DEPTHS, "feishu task reasoningDepth");
assertSameValues(feishuTask.properties.status.enum, TASK_RUN_STATUSES, "feishu task status");
assertSameValues(feishuRunState.properties.status.enum, TASK_RUN_STATUSES, "feishu run status");
assertSameValues(feishuRunState.properties.steps.items.properties.status.enum, TASK_RUN_STEP_STATUSES, "feishu run step status");

assertSameValues(plannerEnvelope.properties.taskType.enum, TASK_TYPES, "ledger taskType");
assertSameValues(plannerEnvelope.properties.status.enum, LEDGER_STATUSES, "ledger status");
assertSameValues(plannerEnvelope.$defs.step.properties.status.enum, LEDGER_STEP_STATUSES, "ledger step status");
assertSameValues(plannerEnvelope.$defs.interaction.properties.kind.enum, INTERACTION_KINDS, "ledger interaction kind");
assertSameValues(plannerEnvelope.$defs.interaction.properties.status.enum, INTERACTION_STATUSES, "ledger interaction status");
assertSameValues(plannerEnvelope.$defs.interaction.properties.priority.enum, INTERACTION_PRIORITIES, "ledger interaction priority");

assertSameValues(Object.keys(executionProfiles.profiles), TASK_EXECUTION_PROFILES, "execution profile registry");
assertSameValues(KNOWN_EXECUTION_PROFILES, TASK_EXECUTION_PROFILES, "task router execution profiles");
assert.equal(contractManifest.schemaVersion, RUNTIME_CONTRACT_SCHEMA_VERSION);
assertSameValues(contractManifest.task.taskTypes, TASK_TYPES, "contract manifest task types");
assertSameValues(contractManifest.task.executionProfiles, TASK_EXECUTION_PROFILES, "contract manifest execution profiles");
assertSameValues(contractManifest.feishu.eventSources, FEISHU_EVENT_SOURCES, "contract manifest Feishu event sources");
assertSameValues(contractManifest.modelProvider.protocols, MODEL_PROVIDER_PROTOCOLS, "contract manifest provider protocols");
assertSameValues(contractManifest.cloudAsr.summaryStatuses, CLOUD_ASR_SUMMARY_STATUSES, "contract manifest ASR statuses");
assertSameValues(contractManifest.cloudAsr.inputModes, CLOUD_ASR_INPUT_MODES, "contract manifest ASR input modes");
assert.equal(contractManifest.runtimeStore.schemaVersion, RUNTIME_STORE_SCHEMA_VERSION);
assertSameValues(contractManifest.runtimeStore.resultStatuses, RUNTIME_STORE_RESULT_STATUSES, "contract manifest runtime store statuses");
assert.equal(contractManifest.qa.schemaVersion, QA_GATE_SCHEMA_VERSION);
assertSameValues(contractManifest.qa.profiles, QA_PROFILES, "contract manifest QA profiles");
assertSameValues(contractManifest.qa.statuses, QA_GATE_STATUSES, "contract manifest QA statuses");
assert.equal(contractManifest.sourceContext.schemaVersion, SOURCE_CONTEXT_SCHEMA_VERSION);
assertSameValues(contractManifest.sourceContext.gateStatuses, SOURCE_CONTEXT_GATE_STATUSES, "contract manifest Source Context gate statuses");
assert.equal(contractManifest.documentRuntime.checkpointSchemaVersion, DOCUMENT_CHECKPOINT_SCHEMA_VERSION);
assertSameValues(contractManifest.documentRuntime.checkpointStatuses, DOCUMENT_CHECKPOINT_STATUSES, "contract manifest checkpoint statuses");
assertSameValues(contractManifest.documentRuntime.workerStatuses, DOCUMENT_WORKER_STATUSES, "contract manifest document worker statuses");
assertSameValues(contractManifest.officeArtifacts.channels, OFFICE_CHANNELS, "contract manifest office channels");
assertSameValues(contractManifest.officeArtifacts.objectTypes, OFFICE_OBJECT_TYPES, "contract manifest office object types");
assert.equal(qaGateSchema.properties.schemaVersion.const, QA_GATE_SCHEMA_VERSION);
assert.equal(sourceContextSchema.properties.schemaVersion.const, SOURCE_CONTEXT_SCHEMA_VERSION);
assert.equal(checkpointSchema.properties.schemaVersion.const, DOCUMENT_CHECKPOINT_SCHEMA_VERSION);
assert.equal(officeObjectSchema.properties.schemaVersion.const, "office-object-v1");
assertSameValues(
  Object.entries(executionProfiles.profiles).filter(([, profile]) => profile.runnerEligible === true).map(([profileId]) => profileId),
  RUNNER_EXECUTION_PROFILES,
  "runner-eligible execution profiles",
);

for (const [profileId, profile] of Object.entries(executionProfiles.profiles)) {
  if (profile.reasoningDepth !== undefined) {
    assert(TASK_REASONING_DEPTHS.includes(profile.reasoningDepth), `${profileId} has an unknown reasoningDepth`);
  }
}

const handlerSource = readFileSync(join(packageDir, "tools", "feishu_agent_task_handler.mjs"), "utf8");
assert(!/executionProfile\s*=\s*["']direct_answer["']/.test(handlerSource), "Feishu handler must use fast_answer, not the responseMode literal direct_answer");
assert(!/reasoningDepth\s*=\s*["']shallow["']/.test(handlerSource), "Feishu handler must use the canonical fast/deep reasoning contract");

console.log(JSON.stringify({
  status: "passed",
  contract: "task-contracts-v1",
  executionProfileCount: TASK_EXECUTION_PROFILES.length,
  ledgerStepStatusCount: LEDGER_STEP_STATUSES.length,
}));
