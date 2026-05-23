# Feishu Lark CLI Keychain Auth Blocks Live Smoke

## Summary

Feishu Agent bridge code and fixture/mock QA can run locally, but live Feishu
event/publish smoke is blocked because `lark-cli auth status --verify` currently
fails with a keychain/profile initialization error.

## Trigger Scenario

Running a real Feishu smoke test requires `lark-cli` to consume events, download
message resources, create Drive folders/Markdown files, and reply to messages.
Those actions depend on a verified local CLI auth profile.

## Impact

- Fixture tests can validate runner, handler, artifacts, QA/Policy boundaries,
  and dry-run publish plans.
- Live Feishu publish/reply cannot be trusted until CLI auth is repaired.
- The handler must keep live publish blocked or dry-run until auth and app
  permissions are verified.

## Evidence

- `which lark-cli` resolves to the local Node installation.
- `lark-cli --help`, `event consume --help`, `im +messages-reply --help`,
  `im +messages-resources-download --help`, `markdown +create --help`, and
  `drive +create-folder/+upload --help` are available.
- `lark-cli auth status --verify` returns a config/keychain error:
  keychain master key is not initialized.

## Root Cause

The local `lark-cli` profile/keychain is not initialized or not accessible from
the current runtime environment.

## Fix Plan

1. Run `lark-cli config init` or the official CLI login flow in the user shell
   where the keychain is available.
2. Re-run `lark-cli auth status --verify` and only expose the redacted
   `auth-status-summary` to model context.
3. Confirm `FEISHU_EVENT_KEY` and bot permissions in the Feishu developer
   console.
4. Run live smoke: text event -> handler -> PI execute -> QA/Policy -> Markdown
   create -> message reply.

## Verification Plan

- `lark-cli auth status --verify` exits 0.
- `lark-cli event list` and `lark-cli event schema <EventKey>` work.
- `lark-cli event consume <EventKey> --max-events 1` receives a test bot
  message.
- Handler live mode creates a folder/Markdown document and replies in Feishu.

## Status

Open. Environment/auth issue, not a code path blocker for fixture QA.
