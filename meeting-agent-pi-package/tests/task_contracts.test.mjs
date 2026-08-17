import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  TASK_EXECUTION_PROFILES,
  TASK_REASONING_DEPTHS,
  isTaskExecutionProfile,
  isTaskReasoningDepth,
} from "../dist/index.js";
import { KNOWN_EXECUTION_PROFILES, classifyTaskIntent } from "../tools/task_router.mjs";

test("published task contracts match the real router and Feishu schema", async () => {
  const schema = JSON.parse(await readFile(new URL("../runtime/feishu-task.schema.json", import.meta.url), "utf8"));
  assert.deepEqual([...KNOWN_EXECUTION_PROFILES].sort(), [...TASK_EXECUTION_PROFILES].sort());
  assert.deepEqual([...schema.properties.taskIntent.properties.executionProfile.enum].sort(), [...TASK_EXECUTION_PROFILES].sort());
  assert.deepEqual([...schema.properties.taskIntent.properties.reasoningDepth.enum].sort(), [...TASK_REASONING_DEPTHS].sort());

  const intent = classifyTaskIntent({ message: { text: "请处理 https://www.youtube.com/watch?v=fixture" } }, [], { contexts: [] }, {});
  assert.equal(intent.executionProfile, "url_source_pack");
  assert.equal(isTaskExecutionProfile(intent.executionProfile), true);
  assert.equal(isTaskReasoningDepth(intent.reasoningDepth), true);
  assert.equal(isTaskExecutionProfile("direct_answer"), false);
  assert.equal(isTaskReasoningDepth("shallow"), false);
});
