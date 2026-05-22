# Non-Production Legacy QA Run

This folder contains local Qwen3-ASR MLX 4-bit benchmark and QA artifacts. It
is not a production transcript store.

Use reports and marker files for review. Do not copy full transcript/evidence
payloads into agent context; current production-style runs must offload raw
transcript/full evidence and keep pointer-only summaries in context.
