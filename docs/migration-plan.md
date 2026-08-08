# HomeMew Core -> LifeSpace Migration Plan

## Goal

Extract proven shared backend behavior from HomeMew into LifeSpace while preserving working application behavior and removing assumptions that business data always belongs to a family.

## Principles

- Migrate by capability, not by copying directories wholesale.
- Keep HomeMew production functional until LifeSpace provides the required deployed contract.
- Prefer backward-compatible transition steps; do not make HomeMew depend on an undeployed LifeSpace endpoint.
- Preserve data meaning, IDs and audit history where practical, but explicitly document any approved reset while the system still has no production data that must be retained.
- Separate Identity migration from Core domain migration so authentication and business authorization boundaries remain clear.

## Planned sequence

1. Establish LifeSpace repository rules, architecture, permissions, contracts and CI skeleton.
2. Define canonical Identity, Space, membership and Data Grant models.
3. Define Core API v1 conventions and a minimal `/health`, `/api/v1/status`, `/api/v1/me`, Space and Grant contract.
4. Port proven Core infrastructure patterns from HomeMew: Hono/Workers setup, request IDs, response envelopes, D1 migration discipline, contract checks and test setup.
5. Generalize HomeMew `family` authorization to Space ownership/membership without changing event/task semantics unnecessarily.
6. Migrate shared domains incrementally, beginning with events and tasks, then day records, wishes and anniversaries before adding new domains.
7. Add `/me` aggregate queries and cross-Space read/share semantics.
8. Publish versioned contracts/client artifacts and update HomeMew to consume a fixed LifeSpace contract version.
9. Move HomeMew runtime traffic to LifeSpace Core, keeping the previous API hostname only as a temporary compatibility alias if needed.
10. Remove migrated business Core code, migrations and deployment ownership from HomeMew only after the application no longer depends on them.

## HomeMew behavior to preserve or re-evaluate

Preserve where still valid:

- Hono on Cloudflare Workers.
- D1 migration/version checks.
- Standard `{ "data": ... }` and `{ "error": { "code", "message", "requestId" } }` envelopes.
- `x-request-id` tracing.
- Explicit UTC instant versus date-only semantics.
- Optimistic concurrency and soft deletion for mutable business records.
- OpenAPI contract checks and complete `contract/test/typecheck/build` verification.
- Queue-backed async AI draft handling and privacy boundaries when the feature is migrated.

Re-evaluate/generalize:

- `family_id` -> source `space_id`.
- Family membership checks -> Space membership + Data Grant + domain authorization.
- HomeMew user IDs -> global LifeSpace user identity.
- Family-specific timezone assumptions -> explicit Space/domain date semantics.
- HomeMew integration scopes -> platform application/service scope vocabulary.
- HomeMew-specific AI draft kinds and prompts -> domain-capability-based participation.

## Not part of the scaffold phase

This initial repository scaffold does not move production data, deploy Workers, create Cloudflare resources, publish packages, or change HomeMew clients.
