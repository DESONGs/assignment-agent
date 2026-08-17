import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { resolveLedgerSelection } from "../tools/feishu_agent_task_handler.mjs";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(new URL("../tools/runtime_tool_cli.mjs", import.meta.url));

async function callTool(temp, tool, params, outputRoot = temp) {
  const paramsPath = join(temp, `${tool}-params.json`);
  await writeFile(paramsPath, JSON.stringify(params));
  const run = spawnSync(process.execPath, [cli, "--tool", tool, "--params-file", paramsPath], {
    cwd: packageDir,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  return { result, outputRoot };
}

test("execution ledger owns steps and derives interactive todo projection", async () => {
  const temp = await mkdtemp(join(fileURLToPath(new URL("../../runtime-runs/", import.meta.url)), "ledger-test-"));
  const runId = "ledger-meeting";
  const { result: ledger } = await callTool(temp, "planner_envelope_plan", {
    runId,
    goal: "生成会议纪要并让用户选择产品下一步",
    taskType: "meeting_minutes",
    requestedOutputs: ["meeting-minutes"],
    availableArtifacts: ["artifacts/meeting-intelligence/meeting-analysis.json"],
    successCriteria: ["会议纪要通过 QA"],
    meetingAnalysis: {
      suggestedFollowUpDocuments: ["prd", "customer-requirement-checklist"],
      productDiscoverySummary: {
        clarificationQuestions: [{ question: "首期验收指标是什么？", why: "影响 PRD 验收。", priority: "high", blocks: ["prd"] }],
      },
    },
  });
  assert.equal(ledger.schemaVersion, "adaptive-execution-ledger-v1");
  assert.equal(ledger.steps[0].status, "completed");
  assert.equal(ledger.steps.find((step) => step.stepId === "generate-meeting-minutes").status, "ready");
  assert.equal(ledger.userTodoProjection.awaitingUser, true);
  assert.ok(ledger.interactionItems.some((item) => item.label.includes("验收指标")));
  const nextStepDecision = ledger.interactionItems.find((item) => item.kind === "decision");
  assert.ok(nextStepDecision.options.includes("review-customer-questions"));
  assert.ok(nextStepDecision.options.includes("prd"));
  assert.ok(nextStepDecision.options.includes("keep-meeting-minutes-only"));

  const outputRoot = fileURLToPath(new URL("../../runtime-runs/", import.meta.url));
  await callTool(temp, "planner_envelope_write", { runId, envelope: ledger, outputRoot });
  const { result: blocked } = await callTool(temp, "execution_ledger_reconcile", {
    runId,
    outputRoot,
    expectedRevision: 1,
    stepUpdates: [{ stepId: "verify-deliverables", status: "completed", acceptancePassed: true }],
  });
  assert.match(blocked.reason, /dependency_not_ready/);

  const { result: completedDraft } = await callTool(temp, "execution_ledger_reconcile", {
    runId,
    outputRoot,
    expectedRevision: 1,
    operationId: "complete-minutes",
    stepUpdates: [{ stepId: "generate-meeting-minutes", status: "completed", resultRefs: ["artifacts/meeting-minutes.md"], acceptancePassed: true }],
  });
  assert.equal(completedDraft.revision, 2);
  assert.equal(completedDraft.steps.find((step) => step.stepId === "verify-deliverables").status, "ready");

  const { result: duplicate } = await callTool(temp, "execution_ledger_reconcile", {
    runId,
    outputRoot,
    expectedRevision: 1,
    operationId: "complete-minutes",
    stepUpdates: [{ stepId: "generate-meeting-minutes", status: "completed", resultRefs: ["artifacts/meeting-minutes.md"], acceptancePassed: true }],
  });
  assert.equal(duplicate.idempotentReplay, true);
  assert.equal(duplicate.revision, 2);

  const { result: projection } = await callTool(temp, "execution_ledger_todo", { runId, outputRoot });
  assert.equal(projection.revision, 2);
  assert.ok(projection.items.some((item) => item.interactive === true));
  await rm(join(outputRoot, runId), { recursive: true, force: true });
  await rm(temp, { recursive: true, force: true });
});

test("document worker blocks dependency cycles instead of executing them", async () => {
  const temp = await mkdtemp(join(fileURLToPath(new URL("../../runtime-runs/", import.meta.url)), "ledger-cycle-test-"));
  const taskStatePath = join(temp, "task-state.json");
  const packPath = join(temp, "context-pack.json");
  await writeFile(taskStatePath, JSON.stringify({ schemaVersion: "office-task-state-v2", objective: "cycle", operation: "create_document", requestedDocuments: ["a", "b"], completedWorkUnits: [], openQuestions: [] }));
  await writeFile(packPath, JSON.stringify({ schemaVersion: "context-pack-v2", contextPackId: "pack", workUnitId: "unit", sourceSegmentIds: ["request:1"], selectedSourceBlocks: [], artifactIndex: { taskState: taskStatePath }, documentIdentity: {}, outputContract: { outputContractVersion: "document-output-contract-v1" }, modelContext: "test" }));
  const unit = { workUnitId: "unit", contextPackRef: packPath, contextPackId: "pack", sourceSegmentIds: ["request:1"], taskStateRef: taskStatePath };
  const { result } = await callTool(temp, "document_workers_run", {
    runId: "cycle-run",
    outputRoot: fileURLToPath(new URL("../../runtime-runs/", import.meta.url)),
    mockProvider: true,
    documentWorkItems: [
      { docType: "a", promptFile: "a.md", promptInstructions: "a", requiredSections: ["A"], dependsOn: ["b"], workUnits: [unit] },
      { docType: "b", promptFile: "b.md", promptInstructions: "b", requiredSections: ["B"], dependsOn: ["a"], workUnits: [{ ...unit, workUnitId: "unit-b" }] },
    ],
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "document_dependency_cycle_blocked");
  const state = JSON.parse(await readFile(taskStatePath, "utf8"));
  assert.equal(state.phase, "blocked");
  await rm(temp, { recursive: true, force: true });
});

test("Feishu follow-up resolves a pending Todo choice into the next document task", () => {
  const selection = resolveLedgerSelection("下一步先生成 PRD，我来审阅", {
    runId: "source-meeting-run",
    planId: "plan-source-meeting-run",
    revision: 4,
    interactionItems: [
      {
        itemId: "choose-next-step",
        status: "pending",
        options: ["prd", "customer-requirement-checklist"],
        suggestedDocuments: ["prd", "customer-requirement-checklist"],
      },
    ],
  });

  assert.deepEqual(selection, {
    itemId: "choose-next-step",
    selectedOption: "prd",
    requestedDocuments: ["prd"],
    sourceRunId: "source-meeting-run",
    sourcePlanId: "plan-source-meeting-run",
    sourceRevision: 4,
  });
});

test("Feishu follow-up can choose question review without creating a document task", () => {
  const selection = resolveLedgerSelection("先看问题，然后我再决定", {
    runId: "source-meeting-run",
    planId: "plan-source-meeting-run",
    revision: 4,
    interactionItems: [
      {
        itemId: "choose-next-step",
        status: "pending",
        options: ["review-customer-questions", "prd", "keep-meeting-minutes-only"],
        suggestedDocuments: ["prd"],
      },
    ],
  });

  assert.equal(selection.selectedOption, "review-customer-questions");
  assert.deepEqual(selection.requestedDocuments, []);
});
