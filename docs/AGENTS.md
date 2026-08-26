# Documentation Agent Instructions

This directory defines stable platform decisions. Documentation here is normative when explicitly identified by the root `AGENTS.md`.

## Rules

- Keep `north-star.md` distinct from current architecture: the North Star defines the evolving long-term direction and decision lens; `architecture.md` defines the current target architecture and normative implementation boundaries.
- Treat the North Star as deliberate but evolvable. Do not change it implicitly to justify a local implementation; when evidence changes the long-term direction, update it explicitly, describe consequences, and record the decision in the engineering log.
- Keep architecture, permission, contract, and migration documents separate enough that each has one clear purpose.
- Record decisions, invariants, and boundaries; do not turn these files into transient task logs.
- Use platform terminology consistently: Shared Reality, Shared World, Shared Knowledge, Identity, Space, Data Grant, Authority, Change, principal, actor and application context.
- Keep entity type and operation role distinct: `User / Agent / Application / Service` are identity-capable entity concepts; `principal / actor / application context` are roles or context within an operation. Do not document `Principal` as the universal parent type of those entities.
- Preserve the distinction between operation attribution (`principal`, `actor`, application context) and information provenance (`source`, `sourceRef`, `derivedFrom`) even when one audit/history envelope records both.
- Distinguish source-of-truth behavior from planned behavior. Mark planned sections explicitly.
- Do not document HomeMew-specific, ALOHA-specific, personal-only, family-only, organization-only or other product-specific assumptions as platform rules unless they have been generalized and intentionally approved.
- When changing a security or authorization rule, update `permissions.md` and the relevant service contract/tests in the same change.
- When a North Star terminology refinement does **not** change deployed authorization behavior, do not manufacture contract/code changes merely to make implementation vocabulary mirror the long-term ontology; instead state current versus future semantics explicitly.
- When changing service, Agent, automation, device, API-token, or OAuth machine authentication, update `service-authentication.md` and keep planned behavior visibly separate from deployed behavior.
- When changing runtime/service boundaries, update `architecture.md`.
- When changing contract publication/versioning rules, update `contracts.md`.
- When changing the extraction path from HomeMew, update `migration-plan.md` without rewriting already-completed migration history.
