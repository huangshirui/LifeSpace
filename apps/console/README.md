# LifeSpace Console

LifeSpace Console is the LifeSpace **Platform Admin** operations, governance and configuration Web application for `lifespace.aisr.online`.

The permanent implementation is **React + TypeScript + Vite + Cloudflare Worker/BFF**. Console is not a downstream product administration UI and does not switch into ordinary User/Space authority. Normal privileged operations are always executed as:

```text
Cloudflare Access human
-> LifeSpace user identity resolution
-> <=5-minute purpose=platform_admin_actor proof
+
controlled Identity/Core executor
-> fixed Platform Admin control-plane operation
```

The browser never receives platform executor credentials, raw Access assertions, LifeSpace user bearer tokens or Platform Admin actor JWTs.

## Information architecture

```text
Overview
Platform
  Applications
  Models
  Users
  Spaces
Operations
  Audit
  System
```

The UI may govern platform-owned state from a Space detail page, but the authority remains Platform Admin authority rather than the current user's ordinary Space membership/Grant authority.

## Current governance surfaces

```text
Models
  List / inspect published Model Registry
  Validate canonical Model Definition
  Publish new model / model version
  Retire model

Applications
  Create / update Application
  Configure allowed scopes / token TTL / active-disabled state
  Register / revoke Cloudflare Access audience
  Replace Application × Model Access catalog

Identity credentials and actors
  Create / revoke Application credential
  Create / update / disable Service Principal
  Create / reduce / revoke Service API Token
  Create / list / reduce / revoke Agent API credential

Spaces
  Inspect memberships / Grants / record counts
  Create / update / revoke Data Grants
  Configure External Provider Connections
  Discover Provider resources
  Bind / inspect / refresh / disable External Models
```

All operations reuse authoritative Identity/Core state. Console does **not** add an independent model schema, credential database, Data Grant store, External Connection store, Core/Identity migration set, direct DDL/SQL execution path or hidden Space impersonation.

## Core Platform Admin namespace

Console-facing Core control-plane operations use `/api/v1/platform-admin/*`.

Examples:

```text
/api/v1/platform-admin/applications/{applicationId}/model-access
/api/v1/platform-admin/models
/api/v1/platform-admin/models/validate
/api/v1/platform-admin/models/{modelKey}/retire
/api/v1/platform-admin/spaces
/api/v1/platform-admin/spaces/{spaceId}
/api/v1/platform-admin/spaces/{spaceId}/grants
/api/v1/platform-admin/spaces/{spaceId}/external-connections
/api/v1/platform-admin/spaces/{spaceId}/external-models
/api/v1/platform-admin/audit
```

`/api/v1/model-admin/*` remains the independent non-interactive Service Automation Model Control Plane. Console does not use it as its runtime administration namespace.

Ordinary `/api/v1/spaces/*` management APIs remain available to downstream applications where a real user with current Space authority may self-manage a Space. Console does not borrow that user authority; when Console governs the same underlying resource, it uses a dedicated Platform Admin route over the same authoritative state.

## Data Grant governance

Platform Admin may create, update or revoke a Space Data Grant without becoming the target grantee and without receiving ordinary Space data authority.

```text
Platform Admin control plane
        |
        v
canonical Core data_grants state
        |
        v
subsequent Runtime authorization of the actual grantee
```

Console governance therefore changes **who may access the Space/model**, but does not make the human operator or Console executor a hidden Space member or record reader/writer.

## External governance

External Connection/binding configuration has one authoritative Core state and one private Adapter credential vault, with two legitimate authority surfaces:

```text
Downstream application
User + Space manage
-> /api/v1/spaces/{spaceId}/external-*

LifeSpace Console
Platform Admin actor + Core executor
-> /api/v1/platform-admin/spaces/{spaceId}/external-*
```

Both route families reuse the same Connection/binding implementation and Adapter vault. Provider credential plaintext is transiently forwarded to the private Adapter vault and is never persisted or returned by Core.

## Same-origin Console BFF

The browser calls only bounded same-origin `/api/*` endpoints such as:

```text
GET  /api/overview
GET  /api/applications
GET  /api/models
GET  /api/users
GET  /api/spaces
GET  /api/spaces/:spaceId
GET  /api/audit
GET  /api/system
```

Purpose-specific mutation routes include Application/credential governance, Model validation/publication/retirement, Space Data Grant governance and External Connection/binding governance.

The browser supplies only bounded operation input. It never supplies an upstream URL, upstream Authorization header or platform credential. Browser mutations additionally require exact Origin, `Sec-Fetch-Site: same-origin`, JSON Content-Type, an operation-specific `x-lifespace-console-intent`, and server-validated confirmation where the action is destructive or materially changes authority.

## Privileged security chain

Identity control-plane calls use the Console `lsa_*` application executor plus Platform Admin actor proof. Core control-plane calls use the dedicated Console `lsp_svc_*` service executor plus the same actor proof. Actor and executor must belong to the same Console application context.

The Console Core executor is intentionally bounded to the explicit Platform Admin scope set needed by current routes, including:

```text
applications:manage
models:manage
spaces:inspect
spaces:manage
grants:manage
audit:read
```

These executor scopes are **control-plane capabilities**. They do not themselves create ordinary Space membership, Data Grants or business-record authority.

## First-use Access identity

A valid Cloudflare Access principal may still be unknown to LifeSpace Identity. Access email is diagnostic metadata, never merge authority.

`POST /api/session/register` remains a staging-only bounded bootstrap flow for the **current verified Access principal**. It is not an alternate authority mode for Console management operations and is unavailable in production.

## Platform/application boundary

Console is a Platform Admin interface. It may govern canonical LifeSpace control-plane state, including Model Registry, Application policy, Service/Agent identity, Space Data Grants and External configuration.

Downstream applications still own product-specific workflows and policy such as family-specific presentation, business record editing, product-specific member journeys and app-specific integration UX. They may expose self-service management using ordinary User/Space authority where the canonical LifeSpace contract supports it.

The distinction is therefore **authority and product responsibility**, not duplicated data:

- Console: Platform Admin governance;
- application: user/product self-service;
- Core/Identity: single authoritative state.

## Runtime bindings and secrets

Committed non-secret vars:

```text
ENVIRONMENT
IDENTITY_BASE_URL
CORE_BASE_URL
```

Staging/production Service Bindings:

```text
IDENTITY -> matching Identity Worker
CORE     -> matching Core Worker
```

Worker secrets in full-admin mode:

```text
IDENTITY_APPLICATION_CREDENTIAL  # server-only Console lsa_*
CORE_EXECUTOR_BEARER             # dedicated Console lsp_svc_* executor
```

The global bootstrap secret is deliberately not a Console Worker secret.

## Deployment

Normal Console-only staging deployment uses:

```text
.github/workflows/lifespace-console-staging-deploy.yml
```

It deploys only Console and preserves existing secrets. It must not migrate/deploy Core or Identity or use bootstrap authority.

Platform/credential convergence uses:

```text
.github/workflows/lifespace-console-staging-provision.yml
```

Use it when Core/Identity Platform Admin contracts, Console Application scope ceilings, executor scopes or executor credentials intentionally change. This is required when adding new Platform Admin capabilities such as `spaces:manage` or `grants:manage` to the Console executor.

Production uses independent credentials/configuration and requires explicit production rollout approval.

## Verification gate

A Console governance change is incomplete until:

1. frozen workspace install and full checks pass;
2. React/Worker TypeScript and Vite build pass;
3. Platform Admin contract/boundary guards pass;
4. missing/unlinked/non-admin/wrong-application authority fails safely;
5. browser mutation Origin/Fetch Metadata/Content-Type/intent/confirmation checks pass;
6. Console runtime does not request ordinary User/Space management scopes to perform privileged configuration;
7. Model governance uses `/platform-admin/models*` while service automation retains `/model-admin/*`;
8. Data Grant governance proves create/update/revoke plus human/executor audit and no hidden membership;
9. External governance uses Platform Admin authority while ordinary application self-service remains functional;
10. staging/production provisioning converges the exact executor scope ceiling required by the Platform Admin routes;
11. isolated staging deployment remains isolated from Core/Identity deployment;
12. real staging acceptance and browser smoke cover newly introduced mutations before production rollout.
