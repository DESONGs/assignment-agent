---
name: rokid-lingzhu-workflow
description: Use Rokid Lingzhu platform or official MCP capabilities to ingest smart-glasses meeting assets. Use when the meeting source is Rokid glasses, Lingzhu, exported audio, video, photos, or device metadata.
---

# Rokid Lingzhu Workflow Skill

Use Rokid through Lingzhu platform capabilities or official/exported assets.
Do not build a long-lived custom bridge unless official capabilities are
insufficient and the user explicitly approves that scope.

## MVP Input Modes

- Lingzhu platform MCP or custom-agent call result.
- Local export directory from Rokid or its companion app.
- User-provided media files from the glasses.

## Required Metadata

For every imported asset, preserve:

- Source platform or export path.
- Device/source label.
- Capture time if available.
- File hash.
- Media type.
- Privacy classification.

## Processing Rules

- Treat all raw media as sensitive.
- Do not upload raw assets unless the user has approved the target service.
- Pass normalized assets into the media evidence flow.
- Keep Lingzhu authentication and permission control outside the core agent.
