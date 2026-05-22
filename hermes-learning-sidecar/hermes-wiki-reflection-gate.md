# Hermes Wiki Reflection Gate

Hermes is a read-only learning sidecar and knowledge extraction gate. It may
write candidate knowledge to the Hermes Wiki only after this rubric passes. It
must never edit production prompts, skills, runtime code, calendars, tasks, IM
messages, or customer deliverables.

## Gate Rubric

- First principles: identify mechanisms, constraints, or judgments that remain
  useful beyond the single run.
- Occam's razor: prefer the simplest explanation supported by the run; do not
  over-theorize one failure or overgeneralize one success.
- Evidence constraint: every claim must point to sanitized trajectory,
  run-manifest, QA/Policy status, metrics, document summaries, publish failures,
  evidence-pack metadata, or user task context.
- Implicit knowledge: extract unstated project context, customer constraints,
  delivery habits, preference signals, organizational patterns, skill gaps, and
  product/architecture implications.
- Transferability: mark whether a lesson can improve future tasks, skills,
  prompts, QA, architecture, or product judgment.
- Counterexamples: state where the claim may not hold.
- Safety boundary: exclude secret, token, Authorization, cookie, App Secret, CLI
  session, API key, raw audio/video, raw transcript, and unrelated long source
  text.

## Output Buckets

- 可入库知识
- 隐性知识与机制判断
- 项目/客户语境
- 任务复盘
- Skill 构建思考
- Prompt / QA 改进提案
- 失败模式
- 不应入库内容
- 待人工确认
