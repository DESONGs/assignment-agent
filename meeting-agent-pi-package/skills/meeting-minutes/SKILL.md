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

Build or consume a `meetingProfile` before drafting. It must include
`meetingType`, `allowedRoles`, `allowedTopics`, `allowedTerms`,
`ambiguousTerms`, and `siblingForbiddenTerms`. User-facing roles, organizations,
table names, project names, and action-item owners must be supported by the
current transcript or this profile.

Before drafting, build an internal `topicMap`. Do not expose it in the
user-facing Markdown. Each topic should track `macroTopic`, time range,
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

- Simple execution meetings may use: 会议主题, 核心结论, 关键讨论与需求拆解,
  决策与分歧, 行动项, 风险与开放问题, 最终判断.
- Multi-topic or strategic meetings should use: 会议主题, 核心结论, multiple
  macro-topic sections, 代办事项, 风险与开放问题, 最终判断.
- In complex meetings, prefer action checklists grouped by macro topic over a
  single flat table, unless a table is clearer.

## Topic Expansion Rules

The Terry-style reference note is a guide to topic-level synthesis, not a fixed
directory template. Use reference PDFs or historical notes only for hierarchy,
heading density, and expression style.

- Do not compress strategic topics into one bullet when the transcript contains
  sustained evidence. Business model, pricing/fee structure, "超级个体",
  channel cooperation, organization model, and financing/development judgments
  should become independent sections when discussed materially.
- For each macro topic, capture the background/problem, key judgment, boundary
  or proposed approach, next actions, and open questions when evidence exists.
- Product topics should cover MVP boundary, data safety, deployment
  environment, functional scope, and confirmation gaps.
- Business topics should cover positioning, fee model, delivery model,
  cooperation structure, and near-term strategy.
- Organization topics should cover role split, knowledge/reusable assets, and
  front-stage/back-stage collaboration.
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
  role, or action-item owner. Map it to identity only when the current transcript
  explicitly self-identifies the speaker or the `meetingProfile` contains a
  direct evidence-backed mapping.
- When diarization is disabled, labels are unavailable, or status is
  `unsupported_realtime_endpoint`, do not infer speaker turns from tone or
  context. Keep attribution and owners as `待确认`.
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
- Long or raw transcript/full evidence payloads must be offloaded through
  `context_offload_write`; the drafting context keeps pointer-only artifacts,
  topicMap, evidence map, QA gate, and open questions.
- Mark uncertain content as `待确认`.
- Do not invent participant intent, budgets, or deadlines.
- Separate confirmed facts from inference.
- DeepSeek is the primary drafter. Xiaomi MiMo review suggestions may be merged
  only when backed by the current meeting evidence.
- Xiaomi MiMo review must check `omittedMacroTopics`: sustained topics across
  multiple transcript segments, business model/pricing/super-individual/
  cooperation/organization topics compressed into one sentence, and action items
  that fail to cover all macro topics.
- Raw audio/video must not be sent to external models. Transcript/evidence text
  is the default allowed semantic input for DeepSeek and Xiaomi.

## Style Rules

- Keep the tone direct, structured, and decision-oriented.
- Prefer action verbs and owner/deadline fields for todos.
- Do not include raw private transcript unless explicitly requested.
- If a reference PDF is provided, use only its document style and structure.
  Learn its hierarchy, heading density, topic expansion logic, and expression
  style. Do not treat its facts, owners, dates, or decisions as evidence for the
  current meeting.
