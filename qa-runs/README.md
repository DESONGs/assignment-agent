# QA Runs

This directory is a local evidence archive, not a production source of truth.

Rules for these runs:

- Treat existing run folders as legacy, non-production evidence.
- Do not feed raw transcript, raw Feishu stdout/stderr, model response JSON, or
  generated semantic drafts back into the main agent context.
- Use README or marker files for review notes; do not edit generated raw
  transcripts, raw Feishu JSON, response JSON, or schema JSON files.
- Production runs must offload full transcript/evidence payloads to
  `runtime-runs/{run_id}/offload/` and keep only artifact pointers, hashes,
  bounded previews, topic maps, QA gates, and open questions in context.
- Feishu auth/status evidence must be redacted before model exposure.
- ASR evidence is local-only; raw audio must not be uploaded to hosted models.
