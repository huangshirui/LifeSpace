# LifeSpace Core

Shared Cloudflare Worker business platform for Space-owned life data.

## Current architecture

LifeSpace Core owns the business-facing Kernel plus the metadata-driven ordinary-model Runtime. Ordinary models are published Model Definitions interpreted by one Generic Runtime; adding a normal model must not require a handwritten router/service/table implementation.

Core currently provides:

- verified RS256 user/service principals and opaque `lsp_pat_*` Service API Token authentication;
- Space ownership, memberships and linked Space People;
- current Data Grant authorization and Application × Model Access;
- Model Registry, immutable Model Contract Revisions and deterministic typed model persistence;
- generic CRUD/query/action execution for published ordinary models;
- effective-authority Runtime Discovery for integrations and Agents;
- Registry-driven Creation Draft orchestration;
- model-agnostic Domain Events, subscriptions, signed Webhook delivery and diagnostics;
- explicit Platform Admin control-plane routes separate from the ordinary Kernel contract;
- standard request tracing and success/error envelopes.

## Contract layers

The business-facing Kernel contract is:

```text
apps/core/openapi.yaml
Kernel version: 0.15.0
```

Ordinary model CRUD/query/action syntax is not duplicated in the Kernel OpenAPI. Each published Registry state activates an immutable generated Model Contract Revision:

```text
mct_<sha256>
```

The privileged LifeSpace Console control plane is a separate canonical contract:

```text
apps/core/platform-admin.openapi.yaml
```

See `docs/contracts.md` for pinning and compatibility rules.

## Authorized Runtime Discovery

Integrations such as the official LifeSpace n8n Community Nodes use:

```http
GET /api/v1/spaces/{spaceId}/_discovery
```

The response contains only bounded model metadata that the current credential can actually use in that Space. Effective access is intersected from:

```text
credential resources:* scopes
∩ Application × Model Access
∩ current Space membership / Data Grant
∩ published model access
∩ applicable model/Capability restrictions
```

Discovery exposes model key/route/version/schema hash, display metadata, field metadata, query capabilities, currently callable actions and capability names. It does **not** expose the privileged full Model Definition or immutable Model Contract payload.

For application-managed external integrations, the application Web UI may expose a Space-bound Connection Base URL such as:

```text
https://core.aisr.online/api/v1/spaces/spc_...
```

along with the one-time Service API Token. The URL is routing context only; all authorization remains current credential/application/Grant/model authority.

## Generic ordinary-model routes

Published ordinary models receive concrete routes backed by the Generic Runtime:

```text
GET    /api/v1/spaces/{spaceId}/{modelRoute}
POST   /api/v1/spaces/{spaceId}/{modelRoute}
GET    /api/v1/spaces/{spaceId}/{modelRoute}/{recordId}
PATCH  /api/v1/spaces/{spaceId}/{modelRoute}/{recordId}
DELETE /api/v1/spaces/{spaceId}/{modelRoute}/{recordId}
POST   /api/v1/spaces/{spaceId}/{modelRoute}/{recordId}/actions/{actionKey}
```

The concrete model contract is generated from the published Registry and registered Capabilities. The Kernel OpenAPI intentionally does not contain generic `{modelRoute}` templates or hard-coded Event/Task/Day Record/Wish schemas.

## HomeMew migration transforms

The following scripts deliberately remain even though runtime compatibility has been retired. They convert the frozen HomeMew schema-v11 snapshot into native LifeSpace records and mapping/audit artifacts.

### Family / membership / invite transform

```sh
node scripts/homemew-family-transform.mjs \
  --input homemew-family-snapshot.json \
  --out-dir migration-output
```

The normalized snapshot includes `users`, `families`, `familyMembers`, `familyInvites`, and `inviteRedemptions`, plus `source.schemaVersion: "11"` and an RFC 3339 UTC `exportedAt`. The transform writes deterministic `identity.sql`, `core.sql`, `mapping-manifest.json`, and `migration-report.json`.

### Events

```sh
node scripts/homemew-event-transform.mjs \
  --input homemew-event-snapshot.json \
  --family-manifest migration-output/mapping-manifest.json \
  --out-dir migration-output
```

Preserves `evt_*`, versions, audit timestamps, soft deletion and time semantics; attendee user relations become exact Space Person relations.

### Tasks

```sh
node scripts/homemew-task-transform.mjs \
  --input homemew-task-snapshot.json \
  --family-manifest migration-output/mapping-manifest.json \
  --out-dir migration-output
```

Preserves `tsk_*`, lifecycle, date-only due dates, completion/audit actors and soft deletion; assignee user relations become exact Space Person relations.

### Day Records

```sh
node scripts/homemew-day-record-transform.mjs \
  --input homemew-day-record-snapshot.json \
  --family-manifest migration-output/mapping-manifest.json \
  --out-dir migration-output
```

Preserves `day_*` / `dyo_*`, kind rules, anchors, cycle due dates, attention settings, status, versions, soft deletion and occurrence history. Historical `subjectUserId` values become mapped Space Person references.

### Wishes

```sh
node scripts/homemew-wish-transform.mjs \
  --input homemew-wish-snapshot.json \
  --family-manifest migration-output/mapping-manifest.json \
  --out-dir migration-output
```

Preserves `wsh_*`, lifecycle, desired dates, actors, versions and historical owner/claimant/fulfiller relations as Space Person references.

Canonical Kernel request/response syntax lives in `openapi.yaml`. D1 Kernel migrations live in `migrations/`. Ordinary model contracts are generated from published Model Definitions rather than maintained in this README.

## Verification

`pnpm --filter @lifespace/core check` runs Wrangler binding drift checks, canonical OpenAPI checks, Workers-runtime D1 integration tests, migration-transform tests, TypeScript checking and Wrangler dry-run build. Runtime authorization changes require positive and deny-path coverage, and mutable Grant/Application access must remain current-state rather than long-lived cached authority.
