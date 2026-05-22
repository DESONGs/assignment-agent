# Non-Production Legacy QA Run

This folder contains local Qwen3-ASR development artifacts. It is not a
production transcript store.

Use it only as historical ASR smoke-test evidence. Current runs must call the
local ASR HTTP service, block with `local_asr_service_unavailable` if it is not
available, and avoid script or hosted-model ASR fallback.
