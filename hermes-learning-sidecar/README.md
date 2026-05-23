# Hermes Learning Sidecar

This sidecar captures the useful parts of Hermes-style self-improvement without
giving Hermes direct control over production tools.

## Responsibilities

- Read sanitized PI trajectory artifacts.
- Summarize success and failure patterns.
- Propose long-term memory entries.
- Propose skill or prompt patches.
- Generate regression eval cases.

## Non-responsibilities

- No Feishu writes.
- No Rokid calls.
- No IM sending.
- No task assignment.
- No production skill edits.
- No token or secret access.

## Usage

```bash
python3 sidecar.py \
  --trajectory ../src/examples/sanitized-trajectory.example.json \
  --out /tmp/meeting-agent-sidecar-output
```

For a completed Feishu Agent run, Hermes can also ingest the run directory. The
sidecar reads `run-manifest.json`, `state.json`, `agent-output.json`,
`publish.json`, and `reply.json`, builds or validates `sanitized-trajectory.json`,
then produces the same proposal files:

```bash
python3 sidecar.py \
  --run-dir ../runtime-runs/feishu-agent/runs/<runId> \
  --out /tmp/meeting-agent-sidecar-output
```

The output directory will contain:

- `retrospective.md`
- `memory-proposals.json`
- `skill-patch-proposals.md`
- `eval-cases.json`
- `hermes-wiki-candidate.json`
- `hermes-wiki-reflection-gate.json`
- `hermes-wiki-publish.json`

Hermes defaults to attempting Wiki publication after the reflection gate passes.
It requires a separate target, configured with `HERMES_WIKI_SPACE_ID` or
`HERMES_WIKI_ROOT_NODE_TOKEN`. If neither is present, `hermes-wiki-publish.json`
records `hermes_wiki_publish_blocked_missing_target`; Hermes never writes
candidate knowledge to the user deliverables Wiki.
