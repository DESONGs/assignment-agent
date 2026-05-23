---
name: feishu-bot-gateway
description: Configure and operate the Feishu bot message event gateway for receiving im.message.receive_v1 events and replying from the meeting agent. Use when a Feishu bot can send via CLI/OpenAPI but does not respond to user messages.
---

# Feishu Bot Gateway Skill

Use this skill when a Feishu/Lark custom app bot is configured but cannot
respond to user messages in single chat or group chat.

## Key Distinction

- `feishu_cli` remains the active Feishu operation path for Docs, Drive, IM,
  Calendar, Tasks, Sheets, and other official CLI-supported actions.
- A bot that replies to users also needs an event receiver. The required event is
  `im.message.receive_v1`.
- MCP is not required for chat replies. MCP can expose Feishu APIs as tools for
  AI clients, but it does not by itself subscribe to Feishu message events.

## Recommended Mode

Prefer the CLI-first `feishu-agent-bridge` path for bidirectional Agent tasks.
Use the SDK long connection when `lark-cli event consume` is not sufficient or
when the Feishu app is already configured for SDK long connection:

```bash
npm install @larksuiteoapi/node-sdk@^1.24.0

FEISHU_APP_ID=cli_xxx \
FEISHU_APP_SECRET=... \
FEISHU_BOT_HANDLER_URL=http://127.0.0.1:8788/feishu/events \
node meeting-agent-pi-package/tools/feishu_bot_event_gateway.mjs
```

When `FEISHU_BOT_HANDLER_URL` points to a loopback handler, the gateway defaults
to HTTP handler mode; `FEISHU_BOT_REPLY_MODE=http` is optional. The gateway
converts handler fields such as `status`, `runId`, `documents`,
`publishStatus`, and `replyStatus` into a readable Feishu reply. Use
`FEISHU_AGENT_ASYNC=1` on the handler when the PI runtime path may exceed the
gateway timeout. The gateway remains only an event entrypoint; Planner,
attachment handling, document generation, QA/Policy, and Feishu publish live in
the bridge handler/PI runtime path.

## Feishu Console Checklist

1. Enable bot capability for the self-built app.
2. Configure Events & Callbacks to use long connection, or configure a public
   HTTPS callback URL if choosing HTTP callback mode.
3. Subscribe to `im.message.receive_v1`.
4. Request and publish message permissions:
   - `im:message`
   - `im:message:send_as_bot`
   - `im:message.p2p_msg`
   - `im:message.group_at_msg`
5. Publish the app version after changing permissions or events.
6. Make the app available to the target users and add the bot to target groups.
7. Check developer console event logs if messages still do not arrive.

## PI Tools

- `feishu_bot_gateway_plan`: returns the required console/runtime setup without
  reading secrets.
- `feishu_bot_gateway_check`: checks local environment readiness with redacted
  env status only.

## Security Rules

- Read `FEISHU_APP_ID` and `FEISHU_APP_SECRET` from environment variables only.
- Never write app secret, access tokens, refresh tokens, cookies, or SDK session
  state into the repo, wiki, trajectory, QA artifacts, or example logs.
- Do not send raw meeting media through the bot gateway.
- If the bot sends messages to third parties, follow the existing Feishu
  confirmation policy for IM/customer-visible actions.

## Failure Modes

- Bot can send but not receive: event subscription or long connection process is
  missing, not published, or not active.
- Bot receives events but cannot reply: missing send-as-bot/message permission,
  bot not in target group, app not available to the user, or group permissions
  prevent bot speech.
- Feishu console says the app has no long connection: start
  `feishu_bot_event_gateway.mjs` with valid env vars, then save/publish the event
  subscription.
