# Documentation Agent Instructions

This directory defines stable platform decisions. Documentation here is normative when explicitly identified by the root `AGENTS.md`.

## Rules

- Keep `north-star.md` distinct from current architecture: the North Star defines the evolving long-term direction and decision lens; `architecture.md` defines the current target architecture and normative implementation boundaries.
- Treat the North Star as deliberate but evolvable. Do not change it implicitly to justify a local implementation; when evidence changes the long-term direction, update it explicitly, describe consequences, and record the decision in the engineering log.
- Keep `model-definition-spec.md` as the normative human-readable specification for Model Definition / Policy / Workflow / Capability DSL semantics; validator/runtime/tests/generated Model Contract must change with it rather than allowing a second interpretation to drift.
- Keep architecture, permission, contract, and operational documents separate enough that each has one clear purpose.
- Record decisions, invariants, and boundaries; do not turn these files into transient task logs.
- Use platform terminology consistently: Identity, Space, Data Grant, principal, application scope, domain model, BFF, Core.
- Distinguish source-of-truth behavior from planned behavior. Mark planned sections explicitly.
- Do not document consumer-specific, personal-only, family-only, organization-only or other product assumptions as platform rules unless they have been generalized and intentionally approved.
- When changing a security or authorization rule, update `permissions.md` and the relevant service contract/tests in the same change.
- When changing service, Agent, automation, device, API-token, or OAuth machine authentication, update `service-authentication.md` and keep planned behavior visibly separate from deployed behavior.
- When changing runtime/service boundaries, update `architecture.md`.
- When changing contract publication/versioning rules, update `contracts.md`.
