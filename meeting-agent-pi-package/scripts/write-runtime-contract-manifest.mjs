import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLOUD_ASR_INPUT_MODES,
  CLOUD_ASR_SUMMARY_STATUSES,
  FEISHU_EVENT_SOURCES,
  LEDGER_STATUSES,
  LEDGER_STEP_STATUSES,
  MODEL_GENERATION_STATUSES,
  MODEL_PROVIDER_PROTOCOLS,
  MODEL_ROUTE_STATUSES,
  RUNTIME_CONTRACT_SCHEMA_VERSION,
  RUNTIME_STORE_RESULT_STATUSES,
  RUNTIME_STORE_SCHEMA_VERSION,
  TASK_EXECUTION_PROFILES,
  TASK_REASONING_DEPTHS,
  TASK_RUN_STATUSES,
  TASK_RUN_STEP_STATUSES,
  TASK_TYPES,
} from "../dist/index.js";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outputPath = join(packageDir, "runtime", "contract-manifest.json");
const manifest = {
  schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION,
  generatedFrom: [
    "src/contracts/task-contracts.ts",
    "src/contracts/runtime-boundary-contracts.ts",
  ],
  task: {
    taskTypes: TASK_TYPES,
    executionProfiles: TASK_EXECUTION_PROFILES,
    reasoningDepths: TASK_REASONING_DEPTHS,
    runStatuses: TASK_RUN_STATUSES,
    runStepStatuses: TASK_RUN_STEP_STATUSES,
    ledgerStatuses: LEDGER_STATUSES,
    ledgerStepStatuses: LEDGER_STEP_STATUSES,
  },
  modelProvider: {
    protocols: MODEL_PROVIDER_PROTOCOLS,
    generationStatuses: MODEL_GENERATION_STATUSES,
    routeStatuses: MODEL_ROUTE_STATUSES,
  },
  cloudAsr: {
    provider: "aliyun_dashscope_paraformer",
    summaryStatuses: CLOUD_ASR_SUMMARY_STATUSES,
    inputModes: CLOUD_ASR_INPUT_MODES,
  },
  feishu: {
    eventSources: FEISHU_EVENT_SOURCES,
    runStatuses: TASK_RUN_STATUSES,
    runStepStatuses: TASK_RUN_STEP_STATUSES,
    executionProfiles: TASK_EXECUTION_PROFILES,
    reasoningDepths: TASK_REASONING_DEPTHS,
  },
  runtimeStore: {
    schemaVersion: RUNTIME_STORE_SCHEMA_VERSION,
    resultStatuses: RUNTIME_STORE_RESULT_STATUSES,
  },
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: "written", outputPath, schemaVersion: manifest.schemaVersion }));
