import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseDocumentWorkerResult } from "../dist/index.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const workspaceRuntimeRoot = fileURLToPath(new URL("../../runtime-runs/", import.meta.url));
const cli = fileURLToPath(new URL("../tools/runtime_tool_cli.mjs", import.meta.url));
let invocation = 0;

/** @param {unknown} value */
function asRecord(value) {
  assert(value && typeof value === "object" && !Array.isArray(value));
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value */
function asArray(value) {
  assert(Array.isArray(value));
  return value;
}

/** @param {string} root @param {string} tool @param {unknown} params @param {string} [profile] */
async function runTool(root, tool, params, profile = "") {
  invocation += 1;
  const paramsPath = join(root, `params-${invocation}.json`);
  await writeFile(paramsPath, `${JSON.stringify(params, null, 2)}\n`, "utf8");
  const args = [cli, "--tool", tool, "--params-file", paramsPath];
  if (profile) args.push("--profile", profile);
  const run = spawnSync(process.execPath, args, { cwd: packageDir, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return asRecord(JSON.parse(run.stdout));
}

/** @param {string} root @param {string} runId */
async function prepareSource(root, runId) {
  const result = await runTool(root, "source_context_prepare", {
    runId,
    outputRoot: root,
    taskPrompt: "请生成一份包含正文的测试文档，并保留来源证据。",
    requestedDocuments: ["document"],
    sectionsPerUnit: 1,
  }, "document_generation");
  assert.equal(result.status, "completed");
  assert.equal(asRecord(result.gate).status, "pass");
  return result;
}

/** @param {unknown} value */
function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

test("QA evaluation is fail-closed and QA write re-evaluates result integrity", async () => {
  const root = await mkdtemp(join(workspaceRuntimeRoot, "contract-qa-"));
  try {
    const malformed = await runTool(root, "qa_gate_evaluate", { checks: null, publishIntent: true });
    assert.equal(malformed.status, "blocked");
    assert.equal(malformed.publishAllowed, false);
    assert.equal(malformed.reason, "qa_checks_contract_invalid");

    const missingProfileChecks = await runTool(root, "qa_gate_evaluate", {
      profile: "source_pack",
      checks: { security: { rawSecretsReturned: false, secretsLeaked: false } },
      publishIntent: true,
    });
    assert.equal(missingProfileChecks.status, "blocked");
    assert.equal(missingProfileChecks.reason, "qa_source_pack_checks_required");

    const incompleteSourcePack = await runTool(root, "qa_gate_evaluate", {
      profile: "source_pack",
      checks: {
        security: { rawSecretsReturned: false, secretsLeaked: false },
        sourcePack: {
          required: true,
          completeTranscriptAvailable: false,
          failedChapterCount: 2,
          allClaimsHaveEvidence: false,
          partialResultsPublished: true,
          qualityDisclosureRequired: true,
          qualityDisclosed: false,
          provenancePath: null,
        },
      },
      publishIntent: true,
    });
    assert.equal(incompleteSourcePack.status, "blocked");
    assert.equal(incompleteSourcePack.publishAllowed, false);
    const issueCodes = new Set(asArray(incompleteSourcePack.issues).map((issue) => String(asRecord(issue).code)));
    for (const code of [
      "source_pack_complete_transcript_missing",
      "source_pack_chapter_analysis_incomplete",
      "source_pack_claim_provenance_missing",
      "source_pack_partial_result_published",
      "source_pack_transcript_quality_undisclosed",
      "source_pack_provenance_artifact_missing",
    ]) assert(issueCodes.has(code), `missing fail-closed QA issue: ${code}`);

    const valid = await runTool(root, "qa_gate_evaluate", {
      profile: "source_pack",
      checks: {
        security: { rawSecretsReturned: false, secretsLeaked: false },
        sourcePack: {
          required: true,
          completeTranscriptAvailable: true,
          failedChapterCount: 0,
          allClaimsHaveEvidence: true,
          partialResultsPublished: false,
          qualityDisclosureRequired: false,
          qualityDisclosed: true,
          provenancePath: "artifacts/provenance/evidence-index.json",
        },
      },
      publishIntent: true,
    });
    assert.equal(valid.status, "pass");
    assert.equal(valid.publishAllowed, true);
    assert.equal(valid.publishIntent, true);

    const forged = { ...valid, status: "blocked", publishAllowed: false, reason: "forged" };
    const writeResult = await runTool(root, "qa_gate_write", { runId: "qa-forged", outputRoot: root, gate: forged });
    assert.equal(writeResult.ok, false);
    assert.match(String(writeResult.reason), /qa_gate_result_integrity_mismatch/);

    const persisted = await runTool(root, "qa_gate_write", { runId: "qa-valid", outputRoot: root, gate: valid });
    assert.equal(persisted.ok, true);
    const stored = asRecord(JSON.parse(await readFile(String(persisted.qaGatePath), "utf8")));
    assert.equal(stored.evaluationId, valid.evaluationId);
    assert.equal(stored.inputHash, valid.inputHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Source Context rejects malformed input and recomputes artifact hashes", async () => {
  const root = await mkdtemp(join(workspaceRuntimeRoot, "contract-source-"));
  try {
    const malformed = await runTool(root, "source_context_build_pack", {
      docType: "document",
      sections: ["正文"],
      selectedSegments: [{}],
    }, "document_generation");
    assert.equal(malformed.status, "blocked");
    assert.equal(malformed.reason, "source_segment_contract_invalid");
    assert.match(String(malformed.fieldPath), /selectedSegments\[0\]/);
    assert.match(String(malformed.recovery), /重新解析来源/);

    const prepared = await prepareSource(root, "source-hash");
    const manifestPath = String(prepared.manifestPath);
    const cleanGate = await runTool(root, "source_context_gate", { manifestPath }, "document_generation");
    assert.equal(cleanGate.status, "pass");

    const manifest = asRecord(JSON.parse(await readFile(manifestPath, "utf8")));
    const segmentsPath = String(manifest.sourceSegmentsPath);
    await writeFile(segmentsPath, `${await readFile(segmentsPath, "utf8")}corrupt\n`, "utf8");
    const blocked = await runTool(root, "source_context_gate", { manifest }, "document_generation");
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.reason, "source_context_artifact_hash_mismatch");
    assert.equal(blocked.fieldPath, "artifactHashes.sourceSegments");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Source Context blocks cross-source and context-pack provenance drift even with recomputed hashes", async () => {
  const root = await mkdtemp(join(workspaceRuntimeRoot, "contract-provenance-"));
  try {
    const prepared = await prepareSource(root, "source-provenance");
    const manifestPath = String(prepared.manifestPath);
    const manifest = asRecord(JSON.parse(await readFile(manifestPath, "utf8")));
    const artifactHashes = asRecord(manifest.artifactHashes);
    const segmentsPath = String(manifest.sourceSegmentsPath);
    const rows = (await readFile(segmentsPath, "utf8")).trim().split(/\r?\n/).map((line) => asRecord(JSON.parse(line)));
    const firstRow = rows.at(0);
    assert.ok(firstRow);
    firstRow.sourceId = "unknown-source";
    const changedSegments = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    await writeFile(segmentsPath, changedSegments, "utf8");
    artifactHashes.sourceSegments = createHash("sha256").update(changedSegments).digest("hex");
    const crossSource = await runTool(root, "source_context_gate", { manifest }, "document_generation");
    assert.equal(crossSource.status, "blocked");
    assert.equal(crossSource.reason, "source_context_segment_source_invalid");

    const preparedPack = await prepareSource(root, "pack-provenance");
    const packManifest = asRecord(JSON.parse(await readFile(String(preparedPack.manifestPath), "utf8")));
    const workUnits = asArray(packManifest.workUnits);
    const unit = asRecord(workUnits[0]);
    const packPath = String(unit.contextPackRef);
    const pack = asRecord(JSON.parse(await readFile(packPath, "utf8")));
    const selected = asArray(pack.selectedSegments);
    asRecord(selected[0]).text = "tampered evidence";
    await writeFile(packPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
    unit.contextPackHash = stableHash(pack);
    const driftedPack = await runTool(root, "source_context_gate", { manifest: packManifest }, "document_generation");
    assert.equal(driftedPack.status, "blocked");
    assert.equal(driftedPack.reason, "context_pack_segment_provenance_mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Document worker rejects unknown statuses instead of treating them as completed", () => {
  assert.throws(() => parseDocumentWorkerResult({
    taskIndex: 0,
    docType: "document",
    status: "mystery",
    markdown: "# invalid",
    rawSecretsReturned: false,
  }), /document_worker_result_contract_invalid/);
});

test("A needs-fix upstream document cannot contaminate dependent generation", async () => {
  const root = await mkdtemp(join(workspaceRuntimeRoot, "contract-dependency-"));
  try {
    const runId = "dependency-needs-fix";
    const prepared = await prepareSource(root, runId);
    const baseUnit = asRecord(asArray(prepared.workUnits)[0]);
    const result = await runTool(root, "document_workers_run", {
      runId,
      outputRoot: root,
      mockProvider: true,
      mockResponse: "## 正文\n\n只满足下游章节。",
      maxRepairAttempts: 0,
      documentWorkItems: [
        {
          docType: "upstream",
          promptFile: "upstream.md",
          promptInstructions: "生成上游文档。",
          requiredSections: ["上游必须项"],
          workUnits: [{ ...baseUnit, docType: "upstream" }],
        },
        {
          docType: "downstream",
          promptFile: "downstream.md",
          promptInstructions: "仅在上游完成后生成。",
          requiredSections: ["正文"],
          dependsOn: ["upstream"],
          workUnits: [{ ...baseUnit, workUnitId: "downstream-unit", docType: "downstream" }],
        },
      ],
    }, "document_generation");
    const results = asArray(result.results).map(asRecord);
    const upstreamResult = results.at(0);
    const downstreamResult = results.at(1);
    assert.ok(upstreamResult);
    assert.ok(downstreamResult);
    assert.equal(upstreamResult.status, "needs_fix");
    assert.equal(downstreamResult.status, "blocked");
    assert.equal(downstreamResult.reason, "document_upstream_not_completed");
    assert.equal(downstreamResult.markdown, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Document checkpoint v2 reuses only matching intact artifacts and quarantines legacy or corrupt state", async () => {
  const root = await mkdtemp(join(workspaceRuntimeRoot, "contract-checkpoint-"));
  try {
    const runId = "checkpoint-reuse";
    const prepared = await prepareSource(root, runId);
    const workItem = {
      docType: "document",
      promptFile: "test.md",
      promptInstructions: "生成测试文档。",
      requiredSections: ["正文"],
      workUnits: prepared.workUnits,
    };
    const params = {
      runId,
      documentWorkItems: [workItem],
      mockProvider: true,
      mockResponse: "## 正文\n\n已完成。",
      sectionBatching: true,
      sectionsPerBatch: 1,
      workflowStrategy: "checkpointed",
      outputRoot: root,
    };
    const first = await runTool(root, "document_workers_run", params, "document_generation");
    assert.equal(first.status, "completed");
    const checkpointPath = String(asRecord(first.workflow).checkpointPath);
    const checkpoint = asRecord(JSON.parse(await readFile(checkpointPath, "utf8")));
    assert.equal(checkpoint.schemaVersion, "document-workflow-checkpoint-v2");
    assert.equal(checkpoint.publishPartial, false);

    const second = await runTool(root, "document_workers_run", params, "document_generation");
    assert.equal(second.status, "completed");
    assert.match(JSON.stringify(second), /checkpoint_reused/);

    const workflowRoot = dirname(checkpointPath);
    const runLockPath = join(workflowRoot, "run.lock");
    await writeFile(runLockPath, `${JSON.stringify({ schemaVersion: "document-workflow-run-lock-v1", runId, token: "other-process", acquiredAt: new Date().toISOString() })}\n`, "utf8");
    const concurrent = await runTool(root, "document_workers_run", params, "document_generation");
    assert.equal(concurrent.status, "blocked");
    assert.equal(concurrent.reason, "document_workflow_already_running");
    assert.match(String(concurrent.recovery), /同 runId/);
    await rm(runLockPath, { force: true });

    await writeFile(runLockPath, `${JSON.stringify({ schemaVersion: "document-workflow-run-lock-v1", runId, token: "interrupted-process", acquiredAt: "2020-01-01T00:00:00.000Z" })}\n`, "utf8");
    const staleAt = new Date(Date.now() - 9 * 60 * 60 * 1000);
    await utimes(runLockPath, staleAt, staleAt);
    const recoveredStaleLock = await runTool(root, "document_workers_run", params, "document_generation");
    assert.equal(recoveredStaleLock.status, "completed");
    assert((await readdir(workflowRoot)).some((name) => name.includes("run.lock.stale")));

    const docs = asRecord(checkpoint.docs);
    const firstDoc = asRecord(Object.values(docs)[0]);
    const sections = asRecord(firstDoc.sections);
    const firstSection = asRecord(Object.values(sections)[0]);
    await writeFile(String(firstSection.artifactPath), "corrupt section", "utf8");
    const recovered = await runTool(root, "document_workers_run", params, "document_generation");
    assert.equal(recovered.status, "completed");
    assert.doesNotMatch(JSON.stringify(asArray(recovered.results)[0]), /checkpoint_reused/);

    const legacyRunId = "checkpoint-legacy";
    const legacyPrepared = await prepareSource(root, legacyRunId);
    const legacyCheckpointPath = join(root, legacyRunId, "artifacts", "document-workflow", "checkpoint.json");
    await mkdir(dirname(legacyCheckpointPath), { recursive: true });
    await writeFile(legacyCheckpointPath, '{"schemaVersion":"document-workflow-checkpoint-v1","docs":{}}\n', "utf8");
    const legacyResult = await runTool(root, "document_workers_run", {
      ...params,
      runId: legacyRunId,
      documentWorkItems: [{ ...workItem, workUnits: legacyPrepared.workUnits }],
    }, "document_generation");
    assert.equal(legacyResult.status, "completed");
    const files = await readdir(dirname(legacyCheckpointPath));
    assert(files.some((name) => name.includes("legacy-or-invalid")));
    const current = asRecord(JSON.parse(await readFile(legacyCheckpointPath, "utf8")));
    assert.equal(current.schemaVersion, "document-workflow-checkpoint-v2");

    await writeFile(legacyCheckpointPath, '{"schemaVersion":"document-workflow-checkpoint-v2","docs":', "utf8");
    const truncatedResult = await runTool(root, "document_workers_run", {
      ...params,
      runId: legacyRunId,
      documentWorkItems: [{ ...workItem, workUnits: legacyPrepared.workUnits }],
    }, "document_generation");
    assert.equal(truncatedResult.status, "completed");
    const filesAfterTruncation = await readdir(dirname(legacyCheckpointPath));
    assert(filesAfterTruncation.some((name) => name.includes("unreadable")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Projection write failures are visible recoverable ledger events", async () => {
  const root = await mkdtemp(join(workspaceRuntimeRoot, "contract-projection-"));
  try {
    const runId = "projection-failure";
    const prepared = await prepareSource(root, runId);
    await writeFile(String(prepared.taskStatePath), "not-json", "utf8");
    const result = await runTool(root, "document_workers_run", {
      runId,
      documentWorkItems: [{
        docType: "document",
        promptFile: "test.md",
        promptInstructions: "生成测试文档。",
        requiredSections: ["正文"],
        workUnits: prepared.workUnits,
      }],
      mockProvider: true,
      mockResponse: "## 正文\n\n已完成。",
      outputRoot: root,
    }, "document_generation");
    assert.equal(result.status, "completed");
    const events = asArray(result.projectionEvents).map(asRecord);
    assert(events.length > 0);
    assert(events.every((event) => event.type === "projection_write_failed"));
    assert(events.every((event) => typeof event.reason === "string" && typeof event.recovery === "string"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
