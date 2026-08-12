# Hermes Learning Sidecar

更新时间：2026-08-12。

Hermes 是 Meeting Agent 的事后学习侧车。它可以读取完成学习任务所需的会议 trajectory、证据和交付状态，生成可审阅的改进建议；它不持有生产凭证，也不能直接改变生产能力。

## 产出

- `retrospective.md`
- `memory-proposals.json`
- `skill-patch-proposals.md`
- `eval-cases.json`
- `hermes-wiki-candidate.json`
- `hermes-wiki-reflection-gate.json`
- `hermes-wiki-publish.json`

## 边界

- 可以读取当前学习任务需要的会议内容与运行轨迹，不再要求所有输入先缩减成“仅脱敏摘要”。
- 不读取 API Key、Token、Cookie、Authorization、App Secret、OSS 签名或 CLI session。
- 不执行飞书用户交付发布、IM 通知、任务分派、日历修改或生产 skill/prompt 编辑。
- Proposal 必须经过 review 与回归验证，不能自动合入生产。
- Local Docker `hermes-worker` 固定 `HERMES_WIKI_AUTO_PUBLISH=0`。
- 独立 sidecar 只有在显式配置专用 Hermes Wiki target 时才可尝试发布，不能写入用户交付 Wiki。

## 使用

读取现有 trajectory：

```bash
python3 sidecar.py \
  --trajectory ../src/examples/sanitized-trajectory.example.json \
  --out /tmp/meeting-agent-sidecar-output
```

读取完整 run：

```bash
python3 sidecar.py \
  --run-dir ../runtime-runs/feishu-agent/runs/<runId> \
  --out /tmp/meeting-agent-sidecar-output
```

Sidecar 会验证 run manifest/state/output/publish/reply，并在可用时读取 Meeting Intelligence 与 agentic/QA 结果。输出中不得包含凭证或原始认证命令响应。
