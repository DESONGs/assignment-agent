import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../../", import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), "utf8");
}

test("parent system prompt positions Pi as a general Office Agent with hierarchical context", async () => {
  const system = await text(".pi/SYSTEM.md");
  assert.match(system, /主动型办公助手（Office Agent）/);
  assert.match(system, /控制面 \+ 数据面/);
  assert.match(system, /Dynamic Workflow/);
  assert.match(system, /姓名候选/);
  assert.match(system, /Adaptive Execution Ledger/);
  assert.match(system, /productDiscovery/);
  assert.match(system, /Todo 是执行账本的用户交互投影/);
  assert.doesNotMatch(system, /你是会议终结与文档撰写 Agent/);
});

test("meeting prompt supports evidence-backed identity candidates without assigning commitments", async () => {
  const prompt = await text("meeting-agent-pi-package/prompts/meeting-minutes.md");
  assert.match(prompt, /candidateName/);
  assert.match(prompt, /可能为张三，待确认/);
  assert.match(prompt, /姓名候选不得用于确定 owner/);
  assert.match(prompt, /事实：[\s\S]*推断：[\s\S]*建议：[\s\S]*待确认：/);
});

test("runtime uses context-pack-v2 task state and artifact indexes", async () => {
  const sourceContext = await text("meeting-agent-pi-package/extensions/source-context-runtime.ts");
  const worker = await text("meeting-agent-pi-package/extensions/document-worker-runtime.ts");
  assert.match(sourceContext, /context-pack-v2/);
  assert.match(sourceContext, /office-task-state-v2/);
  assert.match(sourceContext, /hierarchical_control_plane_and_work_unit_data_plane/);
  assert.match(sourceContext, /repeatedFullTranscriptInjection: false/);
  assert.match(worker, /artifactIndex/);
  assert.match(worker, /Work Unit Contract/);
  assert.match(worker, /updateDocumentTaskState/);
  assert.match(worker, /completedWorkUnits/);
});

test("product prompts consume discovery state and expose PRD readiness", async () => {
  const prd = await text("meeting-agent-pi-package/prompts/prd.md");
  const checklist = await text("meeting-agent-pi-package/prompts/customer-requirement-checklist.md");
  assert.match(prd, /productDiscovery/);
  assert.match(prd, /PRD 就绪度与客户澄清问题/);
  assert.match(checklist, /产品发现与需求缺口/);
  assert.match(checklist, /下一次沟通问题清单/);
});

test("legacy optional approval extension is removed", async () => {
  await assert.rejects(text("meeting-agent-pi-package/extensions/approval-gates.ts"));
});

test("document task state advances with completed work units", async () => {
  const temp = await mkdtemp(join(fileURLToPath(new URL("../../runtime-runs/", import.meta.url)), "office-agent-state-"));
  const taskStatePath = join(temp, "task-state.json");
  const contextPackPath = join(temp, "context-pack.json");
  const paramsPath = join(temp, "params.json");
  await writeFile(taskStatePath, JSON.stringify({
    schemaVersion: "office-task-state-v2",
    objective: "生成测试文档",
    completedWorkUnits: [],
    openQuestions: [],
  }));
  await writeFile(contextPackPath, JSON.stringify({
    schemaVersion: "context-pack-v2",
    contextPackId: "pack-1",
    workUnitId: "unit-1",
    sourceSegmentIds: ["request-01:seg-0001"],
    selectedSourceBlocks: [],
    taskState: { schemaVersion: "office-task-state-v2", objective: "生成测试文档" },
    artifactIndex: { taskState: taskStatePath },
    documentIdentity: { confidence: "medium" },
    outputContract: { outputContractVersion: "document-output-contract-v1" },
    modelContext: "测试上下文",
  }));
  await writeFile(paramsPath, JSON.stringify({
    runId: "office-state-test",
    documentWorkItems: [{
      docType: "document",
      promptFile: "test.md",
      promptInstructions: "生成测试文档。",
      requiredSections: ["正文"],
      workUnits: [{
        workUnitId: "unit-1",
        docType: "document",
        sections: ["正文"],
        contextPackRef: contextPackPath,
        contextPackId: "pack-1",
        contextPackHash: "hash-1",
        sourceSegmentIds: ["request-01:seg-0001"],
        sourceBlockIds: [],
        tableBlockCount: 0,
        promptBudgetChars: 24000,
        evidenceBudgetChars: 12000,
        retrievalReasons: ["test"],
        outputContractVersion: "document-output-contract-v1",
        documentIdentityConfidence: "medium",
        taskStateRef: taskStatePath,
      }],
    }],
    mockProvider: true,
    mockResponse: "## 正文\n\n已完成。",
    sectionBatching: true,
    sectionsPerBatch: 1,
    workflowStrategy: "single_pass",
    outputRoot: temp,
  }));
  const { spawnSync } = await import("node:child_process");
  const cli = fileURLToPath(new URL("../tools/runtime_tool_cli.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [cli, "--tool", "document_workers_run", "--params-file", paramsPath], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const state = JSON.parse(await readFile(taskStatePath, "utf8"));
  assert.equal(state.phase, "completed");
  assert.deepEqual(state.completedDocuments, ["document"]);
  assert.equal(state.completedWorkUnits[0].workUnitId, "unit-1");
  await rm(temp, { recursive: true, force: true });
});
