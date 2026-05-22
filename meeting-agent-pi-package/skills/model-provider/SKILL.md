---
name: model-provider
description: Check DeepSeek/Xiaomi/mock provider readiness and generate text through a redacted provider adapter.
---

# Model Provider Skill

Use this skill only after `model_route_plan` has selected a configured provider/model.

## Tools

- `model_provider_check(provider?)`
- `model_generate_text(provider, model, prompt, modelRoute?, systemPrompt?, temperature?, maxTokens?, timeoutMs?, mockResponse?)`

## Rules

- DeepSeek uses `DEEPSEEK_API_KEY` and defaults to `https://api.deepseek.com`.
- Xiaomi uses `XIAOMI_TOKEN_PLAN_SGP_API_KEY` and requires `XIAOMI_BASE_URL`; do not invent an endpoint.
- Provider readiness exposes `supportsFileInput` and `supportsTextFallback`.
  Current OpenAI-compatible chat providers use text fallback for Feishu
  file-context unless a future provider explicitly supports native file input.
- Model Router is the only place that chooses model names. Ordinary short
  drafting uses `deepseek/deepseek-v4-flash`; `meeting_minutes`, PRD,
  architecture, complex ops/checklist, and explicit deep-thinking requests use
  `deepseek/deepseek-v4-pro`.
- Production calls must pass the selected `modelRoute` from `model_route_plan` into `model_generate_text`, then persist the final route with `model_route_record`.
- Never return API keys, Authorization headers, raw request bodies, cookies, CLI sessions, or App Secret values.
- Block prompts that contain secret-like values or raw transcript/media keys.
