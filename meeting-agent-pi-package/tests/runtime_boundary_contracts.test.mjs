import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  RUNTIME_CONTRACT_SCHEMA_VERSION,
  assertCloudAsrSummary,
  assertFeishuEvent,
  assertFeishuRunState,
  assertFeishuTask,
  assertModelGenerationResult,
  parseModelProviderRegistry,
} from "../dist/index.js";
import { addStep } from "../tools/feishu_agent_task_handler.mjs";

const packageDir = new URL("..", import.meta.url);

function feishuEvent() {
  return {
    schemaVersion: "feishu-event-v1",
    eventId: "event-1",
    eventType: "im.message.receive_v1",
    source: "handler-direct",
    receivedAt: "2026-08-17T00:00:00Z",
    message: { messageId: "message-1", chatId: "chat-1", msgType: "text", text: "hello", attachments: [] },
    rawSecretsReturned: false,
  };
}

test("real provider registry is runtime-validated instead of cast", async () => {
  const value = JSON.parse(await readFile(new URL("../runtime/model-providers.json", import.meta.url), "utf8"));
  const registry = parseModelProviderRegistry(value);
  assert.deepEqual(registry.providers.map((provider) => provider.provider), ["deepseek", "xiaomi", "mock"]);
  assert.throws(() => parseModelProviderRegistry({ ...value, providers: [{ ...value.providers[0], protocol: "mystery" }] }), /model_provider_record_invalid/);
});

test("model result contract separates complete content from recoverable block", () => {
  assert.equal(assertModelGenerationResult({
    status: "completed",
    provider: "mock",
    model: "mock-document-worker",
    content: "ok",
    usage: null,
    rawSecretsReturned: false,
    requestBodyReturned: false,
  }).status, "completed");
  assert.equal(assertModelGenerationResult({
    status: "blocked",
    reason: "model_provider_unavailable",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    rawSecretsReturned: false,
    requestBodyReturned: false,
  }).status, "blocked");
  assert.throws(() => assertModelGenerationResult({ status: "completed", provider: "mock", model: "mock", content: "", rawSecretsReturned: false, requestBodyReturned: false }), /content_invalid/);
});

test("cloud ASR complete status cannot coexist with partial or failed chunks", () => {
  const complete = {
    status: "complete",
    meetingId: "meeting-1",
    provider: "aliyun_dashscope_paraformer",
    model: "fun-asr",
    inputModes: ["file"],
    sourceCount: 1,
    transcriptSegments: 4,
    failedChunks: 0,
    partial: false,
    rawMediaExternalUpload: true,
    outputs: {
      sources: "sources.json",
      transcript: "transcript.full.json",
      readableTranscript: "transcript.readable.md",
      evidenceIndex: "evidence-index.json",
      summary: "summary.json",
    },
  };
  assert.equal(assertCloudAsrSummary(complete).status, "complete");
  assert.throws(() => assertCloudAsrSummary({ ...complete, failedChunks: 1 }), /completeness_conflict/);
  assert.throws(() => assertCloudAsrSummary({ ...complete, status: "needs_review" }), /completeness_conflict/);
});

test("Feishu event, task and run-state share canonical status contracts", () => {
  const event = assertFeishuEvent(feishuEvent());
  const task = assertFeishuTask({
    schemaVersion: "feishu-task-v1",
    runId: "run-1",
    status: "running",
    sourceEvent: event,
    taskIntent: {
      schemaVersion: "task-intent-v1",
      taskType: "knowledge_source",
      requestedDocuments: [],
      executionProfile: "url_source_pack",
      reasoningDepth: "deep",
    },
    rawSecretsReturned: false,
  });
  assert.equal(task.taskIntent.executionProfile, "url_source_pack");
  assert.equal(assertFeishuRunState({
    schemaVersion: "feishu-run-state-v1",
    runId: "run-1",
    status: "running",
    updatedAt: "2026-08-17T00:00:01Z",
    steps: [{ name: "event_normalized", status: "completed", at: "2026-08-17T00:00:01Z" }],
    rawSecretsReturned: false,
  }).status, "running");
  assert.throws(() => assertFeishuTask({ ...task, taskIntent: { ...task.taskIntent, executionProfile: "direct_answer" } }), /feishu_task_contract_invalid/);
  assert.throws(() => assertFeishuRunState({ schemaVersion: "feishu-run-state-v1", runId: "run-1", status: "mystery", updatedAt: "now", steps: [], rawSecretsReturned: false }), /feishu_run_state_contract_invalid/);
});

test("Feishu step details cannot override canonical timeline fields", () => {
  const state = assertFeishuRunState({
    schemaVersion: "feishu-run-state-v1",
    runId: "run-1",
    status: "running",
    updatedAt: "2026-08-17T00:00:00Z",
    steps: [],
    rawSecretsReturned: false,
  });
  addStep(state, "source_gate", "completed", {
    name: "wrong_name",
    status: "pass",
    at: "wrong_time",
    reason: "source_gate_passed",
  });
  const step = state.steps.at(0);
  assert.ok(step);
  assert.equal(step.name, "source_gate");
  assert.equal(step.status, "completed");
  assert.notEqual(step.at, "wrong_time");
  assert.equal(step.reason, "source_gate_passed");
});

test("language-neutral manifest is generated from the TypeScript contract", async () => {
  const manifest = JSON.parse(await readFile(new URL("../runtime/contract-manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.schemaVersion, RUNTIME_CONTRACT_SCHEMA_VERSION);
  assert(manifest.runtimeStore.resultStatuses.includes("indexed"));
  assert(manifest.feishu.executionProfiles.includes("url_source_pack"));
});

test("Python runtime store consumes the same contract manifest", () => {
  const script = [
    "import importlib.util,pathlib",
    "p=pathlib.Path('tools/runtime_store_cli.py')",
    "s=importlib.util.spec_from_file_location('runtime_store_cli',p)",
    "m=importlib.util.module_from_spec(s)",
    "s.loader.exec_module(m)",
    "assert m.load_runtime_contract_manifest()['schemaVersion']=='assignment-agent-runtime-contracts-v1'",
    "assert m.validate_runtime_store_result({'schemaVersion':'runtime-store-v1','status':'indexed'})['status']=='indexed'",
  ].join(";");
  const result = spawnSync("python3", ["-c", script], { cwd: packageDir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
