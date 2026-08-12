---
name: meeting-minutes
description: Generate evidence-grounded Chinese meeting minutes from transcripts, local media evidence, Feishu context, or Rokid meeting assets. Use when summarizing meetings into conclusions, action items, risks, and open questions.
---

# Meeting Minutes Skill

Use this skill when the user asks for meeting minutes, meeting conclusion,
meeting summary, or a reference-style document similar to the Terry video agent
meeting note.

## Inputs

Collect or request only the missing inputs needed for the task:

- Transcript segments with timestamps.
- Meeting metadata: title, date, participants, source files, Feishu links.
- Related Feishu context and historical project notes.
- Rokid/Lingzhu media metadata when available.
- Optional reference PDF or historical note for structure/style only.

## Output Structure

Write in Chinese unless the user asks otherwise.

Consume the runtime `Meeting Intelligence` artifacts before drafting:
`meeting-profile.json`, `participant-map.json`, `topic-map.json`,
`evidence-map.json`, and `agent-plan.json`. `meetingProfile` must include
`meetingType`, `allowedRoles`, `allowedTopics`, `allowedTerms`,
`ambiguousTerms`, and `siblingForbiddenTerms`. User-facing roles, organizations,
table names, project names, and action-item owners must be supported by the
current transcript or this profile.

If these artifacts are unavailable, build a clearly marked fallback analysis;
do not silently pretend the full analysis ran. Each topic should track its
title, time range,
evidence density, core judgment, decisions, actions, risks, and open questions.
Treat any topic with sustained discussion across multiple transcript segments,
clear judgment, follow-up action, or risk/open question as a candidate macro
topic.

Generate runtime metadata with these fields. Keep it in the run artifact or a
separate machine-readable envelope. Do not include this metadata
block in the final user-facing Feishu Markdown:

```json
{
  "meetingTitle": "...",
  "titleBasis": {
    "participants": "...",
    "topic": "...",
    "arrangement": "...",
    "conclusion": "..."
  },
  "sourceFile": "...",
  "feishuFileName": "...",
  "evidenceCoverage": "..."
}
```

The final user-facing Markdown must start directly with an H1 equal to
`meetingTitle`. Choose the remaining structure from the internal `topicMap`:

- Use the stable H2 shell from Prompt Registry: 会议概况, 核心结论, 主要议题,
  决策与分歧, 行动项, 风险与待确认事项.
- Under 主要议题, generate dynamic H3 headings from `topicMap` and
  `agentPlan.narrativeMode`.
- In complex meetings, prefer action checklists grouped by macro topic over a
  single flat table, unless a table is clearer.

## Topic Expansion Rules

The Terry-style reference note is a guide to topic-level synthesis, not a fixed
directory template. Use reference PDFs or historical notes only for hierarchy,
heading density, and expression style.

- Do not compress any sustained, decision-relevant topic into one bullet. Topic
  importance comes from the current evidence density, speaker positions,
  decisions, actions, risks, and open questions—not from a fixed industry list.
- For each macro topic, capture the background/problem, key judgment, boundary
  or proposed approach, next actions, and open questions when evidence exists.
- Let Meeting Intelligence decide which dimensions matter for each topic. Do not
  add a product, business, organization, or technical checklist unless the
  current meeting actually discusses it.
- `omittedMacroTopics` is a quality defect. If the reviewer finds an important
  sustained topic missing or collapsed into a single sentence, revise before
  publication.

## Title Rules

- Generate `meetingTitle` from meeting content, prioritizing participants/roles,
  meeting topic, meeting arrangements, and meeting conclusions.
- Use format: `会议纪要｜{参与方/角色}｜{核心主题}｜{关键安排或结论}`.
- If participant names are unclear, use roles or organizations, such as
  `候选人与面试方`, `客户与供应商`, or `项目方与财务沟通`.
- If arrangements or conclusions are unclear, write `安排待确认` or `结论待确认`.
- `feishuFileName` must be derived from `meetingTitle` as `{meetingTitle}.md`,
  with `/ \ : * ? " < > |` removed.
- Feishu Markdown/document names must use `feishuFileName`, not the raw audio
  filename.

## Evidence Rules

- Every important conclusion should reference a timestamp, source document, or
  explicit user-provided fact.
- Inspect `ASR Speaker Evidence` and each transcript segment's `speaker` and
  `channel` labels before attribution. Preserve materially different positions
  under stable anonymous labels such as `说话人 1` and `说话人 2`; never merge
  evidence from different labels into one person's view.
- A provider `speaker_id` is an anonymous within-recording cluster, not a name,
  role, or action-item owner. Keep the stable alias. The model may attach an
  evidence-backed `candidateName` from self-introduction, explicit address,
  context relation, or an enrolled voiceprint; include basis, segment evidence,
  and confidence, and render it as `参会人 A（可能为张三，待确认）` until confirmed.
- When no identity mapping exists, use stable aliases from `participant-map.json`
  such as `参会人 A`, `参会人 B`, and `参会人 C`. Participant-name resolution is
  optional and non-blocking; accept explicit mappings such as `参会人 A=张三`.
- When diarization is disabled, labels are unavailable, or status is
  `unsupported_realtime_endpoint`, do not manufacture speaker turns from tone.
  Context can support a clearly marked identity candidate only when a specific
  utterance or relation is cited; attribution and owners otherwise remain
  `待确认`.
- Speaker diarization is not source separation. Simultaneous same-channel
  speech, semantic jumps, or unstable speaker labels are best-effort evidence;
  mark them as `重叠发言/归属待确认` instead of repairing them into certain facts.
- For a single mixed recording, inspect `singleMix` metadata and source segments
  marked `quality=needs_review`. The primary transcript remains the readable
  baseline, while independent-model alternatives are review evidence only.
  Never silently combine competing word hypotheses, and do not use an
  unresolved review window as the sole support for a decision, owner, amount,
  date, or commitment.
- Reject unsupported entities: if a role, organization, table name, project
  name, or owner is not supported by the current `meetingProfile` or transcript,
  mark it as `待确认` or block publication.
- Do not expand ambiguous words such as "表", "问题", or "材料" into specific
  business nouns unless the current transcript says so. Use neutral wording such
  as `需求表`, `问题表`, or `待确认材料`.
- `siblingForbiddenTerms` from other meetings are hard blockers in user-facing
  output.
- Raw evidence ids, chunk ids, source audio filenames, `transcriptSegments`,
  model QA notes, `Evidence Notes`, and HTML QA comments are internal testing
  artifacts only and must not appear in user-facing Feishu Markdown.
- Keep model context bounded for performance. Use the structured meeting
  analysis plus the evidence relevant to the current work unit instead of
  repeatedly copying the entire timeline into every section prompt.
- Mark uncertain content as `待确认`.
- Do not invent participant intent, budgets, or deadlines.
- Separate confirmed facts from inference.
- Model roles come from Model Router. A fallback model is not automatically an
  independent reviewer; only a recorded review pass may claim review coverage.

## Style Rules

- Keep the tone direct, structured, and decision-oriented.
- Prefer action verbs and owner/deadline fields for todos.
- Do not include raw private transcript unless explicitly requested.
- If a reference PDF is provided, use only its document style and structure.
  Learn its hierarchy, heading density, topic expansion logic, and expression
  style. Do not treat its facts, owners, dates, or decisions as evidence for the
  current meeting.
