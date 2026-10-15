# LifeSpace Console — Configuration & Publishing Center

Status: **MVP accepted in staging; Platform Admin authority convergence in PR #367**

The accepted read-only Console foundation remains documented in `docs/lifespace-console-mvp.md`. This document defines the current configuration/publishing center after the authority boundary was tightened: **LifeSpace Console is a pure Platform Admin Console**. Normal privileged operations never switch to ordinary User/Space authority merely because the target resource belongs to a Space.

## Target operator experience

```text
LifeSpace Console
  -> edit bounded platform/control-plane metadata
  -> validate against the authoritative Identity/Core contract
  -> review compatibility / impact / security boundary
  -> explicitly publish or apply
  -> authoritative Identity/Core state changes immediately
  -> runtime / Model Contract / authorized discovery reflect the new state
```

A model-only publication, application-policy change, Space Grant governance action or External configuration action must not require a Git commit, Worker deployment or handwritten business CRUD implementation when the underlying platform capability already exists.

Repository changes remain necessary when the **platform language/runtime/control plane itself** changes: for example a new Capability type, Kernel feature, authorization primitive or new Platform Admin governance capability.

## Source-of-truth boundaries

Console is always a client/BFF and never a persistence owner.

```text
Identity
  Applications
  application credentials
  Access audiences
  Service Principals
  Service API Tokens
  Agents / Agent credentials
  platform administrator assignment

Core
  Model Registry / Model Contract Revisions
  Application × Model Access
  Space / membership / Data Grant
  External Connection / binding metadata
  Event Subscription runtime
  platform audit

Provider Adapter
  Provider credential vault
  Provider-specific schema/runtime translation

Console
  Platform Admin operator workflow + presentation only
```

Console must not persist duplicate authoritative copies of any of these objects.

## Authority invariant for normal Console operations

```text
Cloudflare Access human
-> verified LifeSpace user identity
-> <=5 minute purpose=platform_admin_actor proof
+
controlled Identity/Core executor from the same Console application
-> one fixed Identity/Core Platform Admin operation
```

**Normal Console runtime does not borrow ordinary User/Space authority.** The LifeSpace user session obtained during Access exchange identifies and re-authorizes the human Platform Administrator; it is not used as a substitute for Space membership, `spaces:manage`, `grants:manage` or other ordinary business/runtime authority.

When the same canonical Core resource also supports downstream self-service, the two surfaces are explicit:

```text
Downstream application
User + current Space authority
-> ordinary /api/v1/spaces/* contract

LifeSpace Console
platform_admin_actor + controlled executor
-> /api/v1/platform-admin/* contract
```

They mutate the **same authoritative state**. There is no second Data Grant store, External Connection store or Model Registry.

Platform Admin governance of a Space relation does **not** grant the human operator or Console executor ordinary Space business-data authority. In particular, creating a Data Grant for `svc_*` changes that service's future Runtime authority; it does not make Console a hidden member or record reader/writer.

## Browser/BFF security boundary

Ordinary browser JavaScript never receives Access assertions, LifeSpace user bearer tokens, actor proofs, `lsa_*`, `lsp_svc_*`, legacy `lsp_pat_*`, `lsp_agt_*`, bootstrap secrets or upstream Authorization headers.

The only accepted target-credential exception is the dedicated operator reveal boundary in `docs/console-target-credential-reveal.md`: a newly created credential for another approved backend/service may be displayed only through a separately authenticated, short-lived, no-script/no-store reveal document. Console's own executors, actor/session credentials and bootstrap material are never revealable.

Every browser mutation is purpose-specific and requires exact same-origin / Fetch Metadata validation plus an operation-specific intent. Destructive or authority-changing actions additionally require server-validated target confirmation. Core/Identity remains responsible for canonical validation and audit.

## Current configuration/governance surfaces

### Model governance

Console model operations use the dedicated Core Platform Admin namespace:

```text
GET  /api/v1/platform-admin/models
POST /api/v1/platform-admin/models/validate
POST /api/v1/platform-admin/models
GET  /api/v1/platform-admin/models/{modelKey}
POST /api/v1/platform-admin/models/{modelKey}/retire
```

The independent `/api/v1/model-admin/*` contract remains for **non-interactive Service Automation / CI**. Console does not use it as its runtime administration namespace.

Model validation/publication still reuses the same canonical Model Definition validator, Registry implementation and Model Control Plane request/response schemas. There is never a second Console model format.

### Application policy

Console governs:

- Application create/update/status;
- allowed scopes and token TTL;
- Cloudflare Access audience registration/revocation;
- Application × Model Access atomic replacement.

Application × Model Access remains a platform policy ceiling and is Core-owned.

### Service / Agent identity and credentials

Console governs:

- Application credentials;
- Service Principals and Service API Tokens;
- Agent identity and Agent API credentials;
- one-time target credential reveal through the dedicated sealed reveal boundary.

The UI must continue to present service authority as an intersection rather than implying one token is unlimited:

```text
verified Service Principal / token scopes
∩ Application × Model Access
∩ current Space/Data Grant authority
∩ model capability/policy
```

### Space inspection and Data Grant governance

Platform Admin may inspect any Space's memberships, Grants and record counts through the Space Inspector without gaining ordinary Space membership.

Data Grant governance is now an explicit Platform Admin capability:

```text
POST   /api/v1/platform-admin/spaces/{spaceId}/grants
PATCH  /api/v1/platform-admin/spaces/{spaceId}/grants/{grantId}
DELETE /api/v1/platform-admin/spaces/{spaceId}/grants/{grantId}
```

These routes require `platform_admin_actor + Core executor` with the bounded `grants:manage` control-plane capability and mutate the same canonical `data_grants` rows used by Runtime authorization.

Downstream applications may still expose ordinary Space-owner/admin self-service through `/api/v1/spaces/{spaceId}/grants*` under User/Space authority. Console does not call that authority path.

### Space External governance

External setup also has one canonical Core state and two explicit authority surfaces.

Console uses:

```text
/api/v1/platform-admin/spaces/{spaceId}/external-providers
/api/v1/platform-admin/spaces/{spaceId}/external-model-definitions
/api/v1/platform-admin/spaces/{spaceId}/external-connections*
/api/v1/platform-admin/spaces/{spaceId}/external-models*
```

The Platform Admin routes reuse the public External Connection contract schemas, Core connection/binding implementation and the same private Provider Adapter vault. Console does not create a parallel External protocol or credential store.

Applications may continue using the ordinary `/api/v1/spaces/{spaceId}/external-*` contract under current User + Space manage authority. Console no longer exchanges a user token with `spaces:manage` to configure External data.

## Bounded Console executors

The Console Core executor is deliberately scoped to the explicit Platform Admin capabilities needed by current routes, including:

```text
applications:manage
models:manage
spaces:inspect
spaces:manage
grants:manage
audit:read
```

These are **control-plane executor capabilities**, not ordinary business-data permission. They become effective only on purpose-built Platform Admin routes together with a valid human actor proof.

Ordinary business/runtime APIs continue enforcing their own Principal type, Application policy, Membership/Data Grant, Delegation and Model Policy checks. A service executor having `grants:manage` does not make it eligible for the ordinary user-only Space Grant API.

## Audit semantics

Platform Admin mutations preserve the human/executor split:

```text
human actor: usr_*
executor: svc_*
operation
control-plane target
bounded secret-free summary
requestId
result
createdAt
```

For D1-local changes such as Data Grant create/update/revoke, authoritative mutation and audit evidence should be committed in the same D1 batch where semantics permit.

For operations crossing an External Provider boundary, a distributed transaction is impossible. Audit therefore uses `pending -> success | failure` around the Provider action rather than pretending the Provider call and Core metadata are atomic.

## Historical rollout slices

### Slice A — Model publishing + Application × Model Access

Status: **merged and staging transaction-proven**

PR: `#60 feat(console): add configuration and model publishing control plane`

The original JSON-first Model Definition editor proved the no-code publication path. After Platform Admin convergence, the same operator capability is exposed through `/api/v1/platform-admin/models*`; `/model-admin/*` is retained only for Service Automation.

### Slice B — Application configuration

Status: **merged, staging transaction-proven and authenticated browser-verified**

PR: `#65 feat(console): add application configuration control plane`

Application governance remains Identity Platform Admin state and keeps the same human actor + controlled executor boundary.

### Slice C — Credentials and external-system identities

Status: **transaction-proven, deployed to staging and authenticated browser-verified**

PR: `#66 feat(console): add credential and service identity governance`

The sealed target-credential reveal boundary remains unchanged. Plaintext is never returned in ordinary React JSON, browser storage, cookies, query parameters, logs or audit.

### Slice G — Platform Admin authority convergence + Space governance

Status: **Draft PR #367; CI/staging acceptance required before merge/rollout**

Scope:

- make Platform Admin authority the sole normal Console authority model;
- add Platform Admin Data Grant create/update/revoke;
- move Console Model governance from `/model-admin/*` to `/platform-admin/models*` while preserving the Service Automation contract;
- move Console External Connection/binding setup from ordinary User/Space authority to `/platform-admin/spaces/{spaceId}/external-*`;
- converge staging/production Console executor scope ceilings for `spaces:manage` and `grants:manage`;
- preserve no-hidden-Space-authority semantics and human/executor audit evidence.

No D1 schema migration is required because this slice adds control-plane authority paths over existing canonical state.

### Slice D — Visual Model Designer

A future structured designer may replace JSON-only authoring as the default experience for model identity, fields, constraints, relations, query declarations, access, lifecycle, Capabilities and bounded Policy/Workflow definitions.

Invariant:

```text
Visual Designer
-> canonical Model Definition
-> same Core validator
-> same Platform Admin publish endpoint
```

There is never a second visual-only schema format or direct DDL/SQL/JavaScript publication authority.

### Slice E — Impact, contract and discovery visibility

Console may consume stable Runtime Discovery information for impact review, including Registry revision, immutable `mct_*` revision, Application × Model Access, generated capability exposure and known downstream dependencies. Runtime Discovery remains Core-owned.

### Slice F — Publication governance hardening

Add only evidence-driven controls such as structured before/after diff, explicit breaking dependency gates, retire dependency gates, publication result identifiers, audit drill-down or two-step approval where real operating risk justifies them.

## What is deliberately not part of the platform Console

- arbitrary business-record editing;
- hidden Platform Admin impersonation of a Space member;
- automatic Platform Admin access to Space business data;
- downstream product-specific family/tenant business workflows and presentation settings;
- arbitrary webhook/API reverse proxying outside approved Platform Admin contracts;
- Cloudflare dashboard replacement;
- GitHub CI/CD dashboard;
- SQL/D1 console;
- arbitrary Swagger/API executor;
- AI autonomous publication without explicit operator action.

Data Grant and External configuration are **not** excluded simply because they are Space-scoped. They are allowed when LifeSpace defines an explicit Platform Admin governance route over canonical state with bounded scope, confirmation and audit.

## Parallel-work strategy

Console work should normally branch from `main` and consume merged contracts. If a required Core/Identity Platform Admin capability is missing, add the smallest explicit control-plane dependency rather than falling back to ordinary User authority or an arbitrary proxy.

Do not weaken authorization invariants merely to avoid touching Core. A new Console operation either has an approved Platform Admin contract or it does not exist in Console.

## Definition of target state

LifeSpace reaches the intended configuration-center experience when a Platform Administrator can:

1. define, validate, publish and retire normal models through Platform Admin Model governance;
2. create/configure Applications and Application × Model Access;
3. govern Access audiences, Service Principals, Service Tokens, Agents and Agent credentials;
4. inspect any Space control-plane state without becoming a hidden member;
5. create/update/revoke Space Data Grants through Platform Admin governance;
6. create/manage Space External Connections and Model bindings through Platform Admin governance;
7. inspect human/executor audit evidence for these changes;
8. perform model/policy/control-plane configuration changes without a code deployment when the platform capability already exists;
9. leave ordinary business-record authority entirely to the normal Runtime authorization model.

A downstream product may still require application code for bespoke UX or self-service administration. Agentic/dynamic clients continue to discover and use authorized runtime capability from platform metadata and contracts; Console itself is not a Runtime data client.
