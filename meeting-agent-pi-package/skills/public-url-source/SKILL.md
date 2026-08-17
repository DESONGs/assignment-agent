---
name: public-url-source
description: Resolve a user-provided public YouTube, podcast/RSS, Xiaoyuzhou episode, or direct audio/video URL into a local timestamped transcript and knowledge source pack.
---

# Public URL Source

Use `public_url_source_ingest` when the user explicitly supplies a public media URL and asks to read, summarize, analyze, or prepare it for later knowledge-base ingestion.

- Prefer a publisher/platform-provided timestamped transcript.
- If none is reliable, acquire only the public media and use the existing DashScope file ASR path.
- Do not use cookies, browser sessions, login workarounds, paywall/DRM bypasses, playlists, live streams, or restricted media.
- Treat podcast/video content as a knowledge source, not as meeting minutes.
- A complete result must include source metadata, complete timestamped transcript, source pack and provenance index. Partial acquisition or ASR blocks the source pack.
- Return the local `sourcePackPath`; never write directly to an external Obsidian/business wiki.

Stable local invocation:

`node meeting-agent-pi-package/tools/public_url_source_cli.mjs --url "https://example.com/source"`

Use `--resolve-only` to validate source metadata and the transcript/ASR acquisition plan without downloading full media.
