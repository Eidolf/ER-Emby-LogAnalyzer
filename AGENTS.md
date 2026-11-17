---
title: "Agent instructions: ER-Emby-LogAnalyzer"
schema_version: "1.0"
version: "0.1.0"
last_updated: "2026-11-16T15:00:38Z"
tier: 3
ai_usage: "allowed"
status: "draft"
---

# Agent instructions

- [Project README](README.md)
- [Project profile](https://github.com/Eidolf/ER-KnowledgeBase/blob/main/Projects/ER-Emby-LogAnalyzer/README.md) (private; AI use requires explicit approval)
- [Knowledge-Platform](https://github.com/Eidolf/Knowledge-Platform)

Keep the application autonomous. The KnowledgeBase is documentation only: do not add runtime dependencies, network access, or a database for KB integration.

Preserve the existing desktop/CLI architecture and release rules:

- Stable tags are the source of truth for Stable versions.
- Nightly releases never increment the next Stable version.
- Set `latest` only for Stable releases.

When project facts change, update the KnowledgeBase profile and its affected inventory/catalog views when access and approval permit; otherwise report the pending update. Do not create a new ADR for documentation-only changes.
