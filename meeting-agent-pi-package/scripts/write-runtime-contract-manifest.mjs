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
  QA_GATE_SCHEMA_VERSION,
  QA_GATE_STATUSES,
  QA_PROFILES,
  SOURCE_CONTEXT_SCHEMA_VERSION,
  SOURCE_CONTEXT_GATE_STATUSES,
  DOCUMENT_CHECKPOINT_SCHEMA_VERSION,
  DOCUMENT_CHECKPOINT_STATUSES,
  DOCUMENT_WORKER_STATUSES,
  QaGateResultSchema,
  SourceContextManifestSchema,
  DocumentWorkflowCheckpointSchema,
  DocumentLifecycleSchema,
  OfficeObjectSchema,
  RetrievalIndexSchema,
  OFFICE_CHANNELS,
  OFFICE_OBJECT_TYPES,
} from "../dist/index.js";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outputPath = join(packageDir, "runtime", "contract-manifest.json");
/** @type {Array<[string, object]>} */
const generatedSchemas = [
  ["qa-gate.schema.json", QaGateResultSchema],
  ["source-context.schema.json", SourceContextManifestSchema],
  ["document-workflow-checkpoint.schema.json", DocumentWorkflowCheckpointSchema],
  ["document-lifecycle.schema.json", DocumentLifecycleSchema],
  ["office-object.schema.json", OfficeObjectSchema],
  ["retrieval-index.schema.json", RetrievalIndexSchema],
];
const manifest = {
  schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION,
  generatedFrom: [
    "src/contracts/task-contracts.ts",
    "src/contracts/runtime-boundary-contracts.ts",
    "src/contracts/qa-contracts.ts",
    "src/contracts/source-context-contracts.ts",
    "src/contracts/document-runtime-contracts.ts",
    "src/contracts/office-artifact-contracts.ts",
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
  qa: {
    schemaVersion: QA_GATE_SCHEMA_VERSION,
    profiles: QA_PROFILES,
    statuses: QA_GATE_STATUSES,
  },
  sourceContext: {
    schemaVersion: SOURCE_CONTEXT_SCHEMA_VERSION,
    gateStatuses: SOURCE_CONTEXT_GATE_STATUSES,
  },
  documentRuntime: {
    checkpointSchemaVersion: DOCUMENT_CHECKPOINT_SCHEMA_VERSION,
    checkpointStatuses: DOCUMENT_CHECKPOINT_STATUSES,
    workerStatuses: DOCUMENT_WORKER_STATUSES,
  },
  officeArtifacts: {
    channels: OFFICE_CHANNELS,
    objectTypes: OFFICE_OBJECT_TYPES,
    retrievalIndexSchemaVersion: "retrieval-index-v1",
    documentLifecycleSchemaVersion: "document-lifecycle-v1",
    officeObjectSchemaVersion: "office-object-v1",
  },
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
for (const [name, schema] of generatedSchemas) {
  writeFileSync(join(packageDir, "runtime", name), `${JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", ...schema }, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify({ status: "written", outputPath, schemaVersion: manifest.schemaVersion }));
