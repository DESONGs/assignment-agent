# Feishu Audio Format Normalization Gap

Date: 2026-05-20
Status: fixed

## Problem

Feishu and meeting tools commonly upload audio as WAV, MP3, M4A, AAC, FLAC, or OGG with different sample rates, channel counts, and sample widths. The earlier ASR MVP exposed the local ASR model input constraint as a product input restriction by only allowing WAV at the runner boundary.

This caused valid user audio to be rejected before transcription, even though the runtime should normalize audio locally before sending it to local ASR.

## Root Cause

- `task_execution_runner.mjs` had a product-level `.wav` gate before ASR.
- The local ASR service correctly expects normalized WAV, but the normalization step did not exist.
- State and metrics did not distinguish `audio_downloaded`, `audio_normalized`, and `local_asr_started`, making the failure look like an unsupported user request instead of an input-preparation gap.

## Fix

- Added `audio_normalize_helpers.mjs`.
- Supported input extensions: `.wav`, `.mp3`, `.m4a`, `.aac`, `.flac`, `.ogg`.
- Normalize locally to `16-bit PCM WAV / mono / 16kHz`.
- Prefer `ffmpeg`; fallback to macOS `afconvert`.
- Verify the normalized WAV header before local ASR.
- Send only normalized WAV paths to local ASR.
- Record `audio-normalize.json`, `audio_downloaded`, `audio_normalized`, `local_asr_started`, and `local_asr_completed`.

## Product Contract

Users may upload common audio formats. The runtime owns conversion to the local ASR input format.

If no local transcoder is available or conversion fails, user-facing reply is:

`目前音频格式暂不支持自动转码。`

Raw audio is not sent to external LLM providers.

## Regression Checks

- 24-bit stereo WAV normalizes to 16k mono s16 WAV.
- M4A normalizes to 16k mono s16 WAV.
- No-transcoder path returns `audio_transcoder_unavailable`.
- ASR request payload uses normalized WAV paths only.
- Videos and images remain unsupported.
