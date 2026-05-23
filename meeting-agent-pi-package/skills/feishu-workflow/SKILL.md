---
name: feishu-workflow
description: Use the official lark-cli directly from PI for Feishu/Lark Docs, Drive, IM, Calendar, Tasks, Meetings, Sheets, Base, and other CLI-supported capabilities.
---

# Feishu Workflow Skill

Use Feishu through the official `lark-cli` only. Do not build a custom Feishu
adapter, action enum, approval store, or command mapping. PI exposes one generic
tool:

```text
feishu_cli(args: string[], stdin?: string, timeoutMs?: number, parseJson?: boolean, redactionPolicy?: "none" | "auth-status-summary" | "secret-scan")
```

The tool runs:

```text
lark-cli ...args
```

## Operating Rules

- Treat `lark-cli` as the single source of Feishu capability.
- Pass official CLI arguments directly through `feishu_cli`.
- Use the user's current Feishu/Lark login state and scopes.
- Do not write Feishu credentials, session files, tokens, cookies, or app
  secrets into this repository.
- Raw `lark-cli auth status` output is L4 restricted data. It may contain
  account, tenant, user, or app metadata and must not be returned to an external
  model.
- Use `redactionPolicy: "auth-status-summary"` for `["auth", "status",
  "--verify"]`. Only the sanitized summary may be shown to the model.
- Default Feishu model exposure is redacted. For any non-auth `lark-cli` output
  that may be summarized, logged, or passed to a model, use
  `redactionPolicy: "secret-scan"` so secret-like stdout/stderr is withheld.
- Do not reimplement `read_doc`, `create_doc`, `send_im`, `move_doc`, or similar
  wrappers in PI.
- Do not add a dry-run default unless the user explicitly asks for a preview.
- Markdown/document create, move, and update are allowed by default when they
  match the user's requested workflow.
- Use optional human confirmation only when the user asks for it, or for IM,
  calendar, task assignment, customer-visible publishing, or scope expansion.
  It is not a default Feishu execution gate.
- When uploading meeting minutes, use the generated `feishuFileName` from the
  meeting-minutes metadata. Do not use the raw audio filename as the Feishu
  document name unless it is only appended to resolve a title collision.

## Capability Discovery

When unsure which official command to use, inspect help directly:

```json
{"args": ["--help"]}
{"args": ["docs", "--help"]}
{"args": ["drive", "--help"]}
{"args": ["im", "--help"]}
{"args": ["calendar", "--help"]}
{"args": ["tasks", "--help"]}
{"args": ["meetings", "--help"]}
{"args": ["sheets", "--help"]}
{"args": ["base", "--help"]}
```

## Common Workflows

- Docs/Wiki: read, create, update, export, or publish with the relevant official
  `docs`, `wiki`, or `drive` subcommand.
- Drive: search, move, organize, upload, and manage cloud-space files with the
  official `drive` subcommands.
- IM: send or reply through the official `im` subcommands.
- Calendar: read or mutate events through the official `calendar` subcommands.
- Tasks: create, update, assign, or inspect tasks through official task
  commands.
- Meetings: read meeting records and metadata through official meeting commands.
- Sheets/Base: use official spreadsheet or Base commands for structured data.

## Error Handling

If `lark-cli` is missing, `feishu_cli(["--help"])` returns a clear `lark-cli not
found` error. Ask the user to install and authenticate the official CLI before
real Feishu operations.

## Auth Status Redaction

Do not call:

```json
{"args": ["auth", "status", "--verify"]}
```

Use:

```json
{"args": ["auth", "status", "--verify"], "redactionPolicy": "auth-status-summary"}
```

The allowed summary fields are limited to CLI availability, verification
success, login state, exit code, timestamp, `rawOutputReturned: false`, and
`identityRedacted: true`. Email, phone, tenant, app, user/open id, token, cookie,
session, and raw stdout/stderr are forbidden.

For all other commands whose output enters agent context, prefer:

```json
{"args": ["docs", "--help"], "redactionPolicy": "secret-scan"}
```

Only keep unredacted CLI stdout/stderr in local operator terminals or bounded
debug artifacts that are not sent to model context.
