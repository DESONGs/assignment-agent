---
name: meeting-agentic-orchestration
description: Dynamically choose parent reasoning, one fresh Pi subagent, or a schema-validated Pi Dynamic Workflow from Meeting Intelligence. Use after meeting transcription and Meeting Intelligence exist and before evidence-sensitive minutes QA.
---

# Meeting Agentic Orchestration

Use this skill only after `meeting-analysis.json`, `participant-map.json` and the full transcript artifact exist.

1. Call `meeting_agentic_plan` with the Meeting Intelligence path, transcript path and participant-map path.
2. Follow the returned mode:
   - `direct`: keep the task in the parent Agent. Do not delegate merely to display multi-agent behavior.
   - `single_subagent`: call the installed `subagent` tool with the returned `request`. The request follows the 0.46 contract: `workflowScript` launches one `runs.run(...)` child, `context=fresh`, `async=false`, `mission=false`, and a structured `outputSchema`. Do not rewrite it as the removed top-level `{agent, task}` launch form.
   - `dynamic_workflow`: call the installed `workflow` tool with the returned `script`, `args`, `concurrency`, `maxAgents`, `agentRetries` and `background=false`.
3. The parent Agent must validate every returned segment id against the transcript before updating Meeting Intelligence or QA findings.
4. Preserve disagreements and missing evidence. A child result is review evidence, not a new source of meeting facts.
5. If a delegated run is unavailable or fails, record the failure and continue with explicit parent-only review. Never report that subagent review occurred when it did not.
6. Participant-name questions remain non-blocking. Stable aliases are valid final identifiers unless the user supplies an explicit name mapping.

Meeting content may be used by the selected models and child Agents. Credentials, signed URLs, cookies, tokens and authorization state must not enter prompts or results.
