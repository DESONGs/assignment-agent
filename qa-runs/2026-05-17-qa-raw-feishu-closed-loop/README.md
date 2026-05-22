# Non-Production Legacy QA Run

This folder contains raw Feishu closed-loop evidence and model artifacts from a
QA investigation. It is retained only for audit and regression comparison.

Do not edit or reuse raw Feishu JSON, transcript JSON, response JSON, or
generated raw semantic drafts as production input. Current Feishu checks must
use default redaction guidance, including `auth-status-summary` for auth status
and `secret-scan` before CLI output is exposed to model context.
