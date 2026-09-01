# Agent-ready contract versioning note

Core Kernel `0.17.0` and Identity Application Contract `0.6.0` are additive platform contract revisions introduced by the Agent Delegation Foundation.

The previously accepted HomeMew integration tuple remains explicit compatibility evidence until M4 staging makes a deliberate downstream repin decision. It is not silently rewritten merely because the platform source has advanced. The handoff validator therefore allows the accepted tuple to remain pinned, while the handoff exporter refuses to package newer source OpenAPI under an older accepted version label.

This note is temporary release-context documentation for PR #86; the normative rule is maintained in `docs/contracts.md`.
