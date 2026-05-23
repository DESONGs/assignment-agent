# PI Provider Membership Blocks Feishu Live Generation

## Summary

Feishu SDK gateway, handler, local ASR, bot reply, and CLI user Markdown publish
are live, but real PI content generation is blocked by provider/account
permissions. The handler can receive a real Feishu task and create a run
artifact, but `pi` does not write `agent-output.json`.

## Evidence

- `PI_PROVIDER=deepseek`, `PI_MODEL=deepseek-v4-pro` returned 403
  `Request not allowed` during a real Feishu run.
- `PI_PROVIDER=deepseek`, `PI_MODEL=deepseek-chat` returned 402 membership
  verification failure in a direct smoke.
- `PI_REVIEW_PROVIDER=xiaomi-token-plan-sgp`, `PI_REVIEW_MODEL=mimo-v2.5-pro`
  also returned 402 membership/benefits failure.
- Handler fallback logic now retries the review provider when the primary PI
  provider is denied, but both configured providers are currently unavailable.

## Impact

- Feishu can accept tasks and reply with run/block status.
- Mock-agent live publish can create Feishu Markdown files through
  `FEISHU_AGENT_PUBLISH_AS=user`.
- Real generated meeting minutes / PRD / Ops / Architecture output cannot be
  produced until at least one PI provider is usable.

## Fix Plan

1. Restore active membership or valid API access for one PI provider.
2. Re-run a minimal smoke:
   `PI_PROVIDER=<provider> PI_MODEL=<model> pi --no-session -e ./meeting-agent-pi-package -p 'Return exactly: OK'`.
3. Restart `feishu_agent_task_handler.mjs` in `execute` mode.
4. Send a real Feishu task and verify `agent-output.json`, `publish.json`, and
   `reply.json` complete.

## Status

Open. Environment/provider entitlement issue, not a Feishu bridge code blocker.
