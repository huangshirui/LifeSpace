# Documentation Agent Instructions

This directory defines stable platform decisions. Documentation here is normative when explicitly identified by the root `AGENTS.md`.

## Rules

- Keep architecture, permission, contract, and migration documents separate enough that each has one clear purpose.
- Record decisions, invariants, and boundaries; do not turn these files into transient task logs.
- Use platform terminology consistently: Identity, Space, Data Grant, principal, application scope, domain model, BFF, Core.
- Distinguish source-of-truth behavior from planned behavior. Mark planned sections explicitly.
- Do not document HomeMew-specific assumptions as platform rules unless they have been generalized and intentionally approved.
- When changing a security or authorization rule, update `permissions.md` and the relevant service contract/tests in the same change.
- When changing service, Agent, automation, device, API-token, or OAuth machine authentication, update `service-authentication.md` and keep planned behavior visibly separate from deployed behavior.
- When changing runtime/service boundaries, update `architecture.md`.
- When changing contract publication/versioning rules, update `contracts.md`.
- When changing the extraction path from HomeMew, update `migration-plan.md` without rewriting already-completed migration history.
