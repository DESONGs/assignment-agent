# Non-Production Legacy QA Run

This run predates the current local-only ASR and pointer-only context rules. It
is retained only as historical evidence for debugging and regression analysis.

Do not use raw transcript, audio-smoke, endpoint-check, model response, or
semantic output files from this folder as production context. Current runs must
use local ASR, raw transcript offload, Feishu redaction, model-route recording,
and QA gate checks before any Feishu publication.
