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

## Production documentation

`docs/production/` is the human-readable source for **what the current production deployment actually provides**. It must not drift into a description of main, staging, planned architecture or work in progress.

- `docs/production/capability-guide.md` is the primary human-readable Production Capability Guide.
- `docs/production/feature-matrix.md` is the quick-search feature inventory.
- `docs/production/changelog.md` records only successfully deployed production changes.
- A capability may be marked `✅ Production` only after the exact candidate SHA has completed the production deployment workflow successfully. Merge, main, PR completion or staging success are insufficient.
- After every successful `Deploy LifeSpace platform production` run, update release SHA/date, capability changes, Feature Matrix status, known limitations and Changelog. Even a release with no user-visible capability change must update release metadata and explicitly record that fact.
- If production deployment succeeds but `docs/production/` has not been synchronized to that deployment, the release is not considered fully closed out from an engineering-process perspective.
- Development-only or planned capabilities may be listed for clarity only when explicitly marked `🚧 In development` or `🧭 Planned`; do not let them read as deployed facts.
- When historical production evidence is insufficient to bind a claim to a release, use `❓ Needs verification` rather than guessing.
