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
  RUNTIME_CONTRACT_SCHEMA_VERSION,
  RUNTIME_STORE_RESULT_STATUSES,
  RUNTIME_STORE_SCHEMA_VERSION,
} from "../dist/index.js";
import { KNOWN_EXECUTION_PROFILES } from "../tools/task_router.mjs";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeDir = join(packageDir, "runtime");

function readJson(name) {
  return JSON.parse(readFileSync(join(runtimeDir, name), "utf8"));
}

function assertSameValues(actual, expected, label) {
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${label} drifted from the canonical TypeScript contract`);
}

const feishuTask = readJson("feishu-task.schema.json");
const feishuRunState = readJson("feishu-run-state.schema.json");
const plannerEnvelope = readJson("planner-envelope.schema.json");
const executionProfiles = readJson("execution-profiles.json");
const contractManifest = readJson("contract-manifest.json");

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
