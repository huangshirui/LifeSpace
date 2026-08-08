# Apps Agent Instructions

`apps/` contains independently deployable runtime services owned by LifeSpace.

## Rules

- Each app must own its runtime entry point, deployment configuration, canonical API contract, tests and service-owned migrations.
- Do not create cross-app database coupling. Core and Identity may share identifiers and contracts but must not reach directly into each other's D1 tables.
- Service-to-service trust must use explicit authenticated/bound interfaces such as Cloudflare Service Bindings and signed/scoped credentials; never import another app's persistence layer.
- Keep environment-specific resource names and secrets out of source code. Production and staging bindings must remain isolated.
- Before changing an app, read its nested `AGENTS.md` and the platform architecture/permission docs.
