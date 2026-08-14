# Phase 6 — LifeSpace Production Platform Bring-up

Updated: 2026-08-14

## Goal

Bring up an empty, isolated LifeSpace production platform before any HomeMew production migration or traffic cutover.

Phase 6 must not migrate HomeMew durable production data and must not route HomeMew production traffic to LifeSpace.

## Status

**Complete on 2026-08-14.**

Accepted production deployment evidence:

```text
Workflow: Deploy production
Run:      31776861588 / run #4
SHA:      52c988898ea2fbfaf95d7b35f43124c6580091f0
Result:   success
Inputs:   phase6_bringup=true / provision=false / confirmation=DEPLOY_PRODUCTION
```

The successful run repeated the first-bring-up deployment/verification path against the already-created production resources, converged both production Workers, and passed every Phase 6 acceptance gate. HomeMew durable production data was not migrated and HomeMew production traffic was not switched.

## Accepted production platform

### Workers and domains

- `lifespace-identity` -> `auth.aisr.online`
- `lifespace-core` -> `core.aisr.online`
- Identity Worker deployed with production D1/R2 bindings.
- Core Worker deployed with production D1/R2, Identity Service Binding, Queue producer/consumer and production rate-limit bindings.
- Custom-domain ownership and staging isolation verified.

### Production storage and Queue

- Identity D1 `lifespace-identity`: `a5707433-5cc1-4bce-8645-8da5d3064bb3`
- Core D1 `lifespace-core`: `8f08b671-abf0-4624-b88e-9918908073a2`
- R2 `lifespace-assets`
- Queue `lifespace-creation-drafts`
- Queue producer and Worker consumer attachment to `lifespace-core` verified.
- Production resources do not reuse the staging D1/R2/Queue identities.

### Runtime and contracts

```text
Core Kernel Contract: 0.12.0
Core D1 schema:        24
Identity Contract:    0.4.0
Identity D1 schema:   4
Model Contract:       mct_9a3d9588da8591ab376ef000e5e661f670a64dd8b1ebc14fd146580f0ed1fa45
```

Production HTTP convergence verified the exact production service/environment/schema/contract values.

Runtime-secret initialization synchronized the production bootstrap secret while preserving the already-complete RS256 signing material and Core↔Identity shared authentication secret. Secret values were not exposed.

The disposable Model Admin probe verified `lsp_pat_* -> Core -> Identity introspection`, the Model Admin service boundary, and the accepted active Model Contract. The production proving models were verified against the pinned definitions in `infra/scripts/production-expectations.mjs`:

- Task v2
- Wish v3
- Day Record v1
- Event v2

The probe authority was removed after verification.

## HomeMew production application boundary

The registered production application is:

```text
productionId: homemew-miniprogram
trustedBackend: true
accessTokenTtlSeconds: 900
```

Accepted scopes:

- `profile:read`
- `profile:write`
- `spaces:read`
- `spaces:write`
- `spaces:manage`
- `resources:read`
- `resources:write`
- `creation-drafts:read`
- `creation-drafts:write`

`models:manage` was explicitly rejected for the HomeMew application boundary. Identity JWT verification and Core JWT verification both passed.

The temporary verification credential was revoked/removed. **No final HomeMew cutover credential was issued in Phase 6.** Final active HomeMew production application credential count at the exit gate: **0**.

## Empty-platform exit gate

Final production database verification reported:

```text
coreSchemaVersion:        24
identitySchemaVersion:    4
activeModelContract:      mct_9a3d9588da8591ab376ef000e5e661f670a64dd8b1ebc14fd146580f0ed1fa45
homemewApplicationId:     homemew-miniprogram
homemewActiveCredentials: 0
businessState:            empty
probeAuthorityResiduals:  0
```

The strict Phase 6 gate therefore proves that production contains the required platform metadata/registrations but no migrated HomeMew business state and no residual disposable verification authority.

## Implementation/fix history

- PR #25 introduced the guarded production platform bring-up and verification path.
- PR #26 stabilized Queue attachment convergence checks.
- PR #27 aligned Queue Worker-consumer verification with Wrangler's current `script` / `service` response fields while retaining compatibility with `script_name`.
- PR #28 bounded disposable Model Admin probe labels to Identity validation limits.
- `Deploy production` run `31776861588` on `52c988898ea2fbfaf95d7b35f43124c6580091f0` is the accepted final Phase 6 production evidence.

## Safety invariants — passed

- No HomeMew production durable data migration was invoked.
- No HomeMew production traffic cutover was performed.
- No staging resource was rebound or reused by production.
- Production provisioning remained create-if-missing and non-destructive.
- Production credentials/secrets were not written to repository files or workflow artifacts.
- Existing complete signing/shared-secret material was preserved rather than rotated by deployment.
- Disposable Model Admin/HomeMew verification authority was cleaned before the final database gate.
- `homemew-miniprogram` remains registered but has zero active cutover credentials.

## Exit gate

**Passed. Phase 6 is complete.**

LifeSpace now has an isolated, empty production platform at the accepted contracts with Identity/Core D1, R2, Queue, runtime signing/authentication, Model Registry/Contract and the HomeMew production application boundary ready for a later controlled cutover.

This completion does **not** authorize Phase 7. Phase 7 remains a separate planned operation requiring the redesigned HomeMew application to be release-ready, its staging E2E to pass, an explicit production write-freeze/cutover decision, and fresh production credentials issued through the approved cutover lifecycle.
