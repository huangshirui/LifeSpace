# LifeSpace Console MVP

- Decision status: **Accepted for MVP planning**
- Runtime status: **Planned; not implemented or deployed**
- Decision date: 2026-08-22
- Production hostname: `https://lifespace.aisr.online`
- Planned staging hostname: `https://lifespace-staging.aisr.online`

## Purpose

LifeSpace Console is the platform operations and governance console for LifeSpace itself.

It is not a HomeMew administration site, an ALOHA administration site, or a generic business-data editor. Application-specific product administration remains in the owning application repository. The Console manages and inspects LifeSpace platform concepts such as registered Applications, Model Registry state, Model Contract revisions, global users/platform Web principals, Spaces/Data Grants, service principals, credentials, platform health and audit evidence.

The MVP should make routine platform governance possible without depending on ad-hoc `curl`, direct D1 SQL, or bootstrap/provisioning scripts, while preserving LifeSpace's existing Identity, Space/Data Grant and Model Admin security boundaries.

## Product boundary

The MVP owns these platform views:

```text
LifeSpace Console

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

The Console must not become a second source of truth. Identity remains authoritative for users, Access platform principals, applications and credentials. Core remains authoritative for Spaces, Data Grants, Model Registry, Application × Model Access, Generic Runtime and business authorization.

## Deployment and authentication boundary

The Console is an owner-controlled LifeSpace Web application and follows the accepted Cloudflare Access architecture:

```text
Browser
  -> Cloudflare Access
  -> LifeSpace Console Worker / same-origin BFF
  -> LifeSpace Identity independently verifies the Access assertion
  -> (iss, sub) -> global usr_*
  -> Console Access aud -> registered LifeSpace Console application
  -> approved admin execution boundary
  -> Identity Admin APIs / Core Admin APIs
```

Production and staging are isolated applications and deployments:

```text
production
  lifespace.aisr.online

staging
  lifespace-staging.aisr.online
```

They must use separate Cloudflare Access applications/audiences, LifeSpace application registrations, credentials and service principals. Staging must never point at production D1/R2/Queue/credential state.

### Bootstrap secret is not a Console credential

`LIFESPACE_*_BOOTSTRAP_SECRET` and `/bootstrap/v1/*` remain infrastructure bootstrap / provisioning / recovery authority. The Console must never place a bootstrap secret in browser JavaScript, an App Session, or its normal runtime management path.

The existing bootstrap routes may be used during initial Console provisioning only. Routine application/credential/audience administration requires a formal non-bootstrap platform-admin contract before the corresponding Console write UI is enabled.

### Human actor and service executor

Existing Model Admin deliberately requires a service principal even when a user token contains `models:manage`. The Console must preserve that service-only execution boundary while still attributing every human-triggered change to the verified LifeSpace user behind Cloudflare Access.

A privileged Console mutation therefore has two distinct identities:

- **actor** — verified LifeSpace `usr_*` reached through Access -> Identity resolution;
- **executor** — narrowly scoped Console platform-admin service/application principal used for the privileged backend operation.

The implementation must not trust a browser- or BFF-supplied arbitrary `actorUserId`. Before privileged Console writes are implemented, Identity/Core must define an approved delegation/admin-call contract that cryptographically or server-side binds the verified actor to the privileged execution request. Audit records must preserve both identities.

The exact dual-identity transport is an implementation prerequisite, not something the UI may approximate with an unsigned header.

## MVP modules

## 1. Overview

Purpose: answer "is the LifeSpace platform healthy and what is active now?"

Show at minimum:

- selected environment (`production` or `staging`);
- Identity health and contract version;
- Core health and Kernel contract version;
- current Model Registry revision;
- active immutable `mct_*` Model Contract revision;
- published model count;
- registered/active application count;
- user count;
- Space count;
- critical configuration/contract mismatch warnings.

MVP does not need infrastructure metrics dashboards. Request latency, CPU, D1 query analytics and Cloudflare time-series charts are later observability work.

## 2. Applications

Purpose: make LifeSpace application trust and authorization visible and manageable from one platform surface.

Application list/detail should expose:

- application id and display name;
- client type;
- trusted-backend classification;
- status;
- allowed Identity scope ceiling;
- access-token TTL policy;
- Cloudflare Access audience registrations for Web applications;
- trusted application credential metadata and rotation/revocation state;
- service principals and their credential metadata;
- Application × Model Access entries.

MVP writes:

- update bounded mutable application policy;
- register/revoke Access audience;
- create replacement application credential and show plaintext exactly once;
- revoke application credential;
- create/update/disable service principal;
- create/rotate/revoke Service API Token with plaintext shown exactly once;
- set/remove Application × Model Access.

All secret views must preserve existing one-time-plaintext and hash-redaction rules.

## 3. Models

Purpose: productize the existing service-only Model Admin capability without weakening it.

Model list/detail should expose:

- key and route;
- published version/state;
- schema hash;
- fields/relations/query/lifecycle/access metadata;
- Capabilities/actions/policy metadata;
- raw validated Model Definition;
- active Model Contract membership.

MVP writes:

```text
edit/provide Model Definition
  -> validate
  -> show validation + compatibility result
  -> show affected version/schema/contract summary
  -> explicit publish confirmation
  -> new immutable Model Contract revision
```

Retirement is supported only with a strong confirmation step and dependency evidence. The UI must not provide arbitrary SQL, JavaScript, shell execution or direct D1 editing.

AI Model Designer is outside the MVP. AI may be added later as a proposal layer only; publication must still use the canonical validator/compatibility/audit path.

## 4. Users

Purpose: inspect global LifeSpace identity state and diagnose Web principal resolution.

MVP is read-only except for future explicitly designed recovery operations.

User detail should expose:

- global `usr_*` id;
- profile/display metadata and status;
- created/updated timestamps;
- linked Cloudflare Access platform principals;
- principal issuer, subject, email snapshot, status, linked/last-seen timestamps;
- Space memberships summary;
- application usage evidence when safely available.

MVP must not allow:

- editing `usr_*` ids;
- merging by email/display name;
- manually rewriting `(iss, sub)`;
- arbitrary Access-principal reassignment;
- impersonation.

Principal unlinking/recovery remains deferred until its lockout/recovery threat model is explicitly designed.

## 5. Spaces

Purpose: inspect ownership/authorization state when debugging platform behavior.

MVP is a platform Inspector, not a second business-data editor.

Space list/detail should expose:

- Space id, name, kind, timezone and lifecycle state;
- owner/creator summary;
- memberships and roles;
- Space People linkage summary;
- Data Grants and grant state;
- per-model record counts where they can be produced without N+1 scans;
- relevant application/model authorization diagnostics when useful.

The MVP does not allow the platform administrator to edit ordinary business records. Existing user-facing Space membership and Grant mutation APIs remain product/user operations, not a reason to expose unrestricted mutations in the platform Console.

## 6. Audit

Purpose: make privileged Console actions accountable and diagnosable.

At minimum capture:

- timestamp;
- environment;
- verified human actor `usr_*`;
- privileged executor principal/application;
- operation;
- target type/id;
- bounded before/after or change summary without secrets;
- request/trace id;
- result/status;
- relevant contract/model version evidence.

Audit data must redact credentials, hashes, Access assertions and other secret-bearing payloads.

The initial audit requirement applies at least to Console/platform-admin mutations. It is not necessary for the MVP to turn every ordinary business CRUD request into a globally browsable event log.

## 7. System

Purpose: expose authoritative deployed platform state without becoming a Cloudflare control plane.

Show:

- Identity URL/health/contract/schema version when available;
- Core URL/health/Kernel version/schema version when available;
- Model Registry revision;
- active Model Contract revision;
- deployment/environment identifiers that are already safe to expose;
- warning state when expected contract/environment invariants drift.

MVP does not manage Cloudflare DNS, Workers, D1, R2, Queues, GitHub Actions or arbitrary environment variables.

## Current API coverage and required gaps

The Console should reuse canonical service contracts where they already have the correct security semantics. It must not build hidden direct-D1 admin behavior to avoid adding an API.

| Console area | Current platform capability | MVP assessment |
| --- | --- | --- |
| Identity/Core health | `/health`, `/api/v1/status` exist | Reuse; add a Console aggregation endpoint/view if needed |
| Model list/get/validate/publish/retire | Core `/api/v1/model-admin/*` exists and is service-principal-only | **Reusable** |
| Active/historical Model Contract | Core Model Admin contract reads exist | **Reusable** |
| Application create/get/update | Identity bootstrap-admin routes exist; no normal platform-admin list contract | **Gap: formal non-bootstrap Admin API + list** |
| Application credentials | Identity bootstrap-admin credential lifecycle exists | **Gap: expose equivalent formal platform-admin contract; do not use bootstrap secret at runtime** |
| Access audiences | Identity bootstrap-admin audience lifecycle exists | **Gap: formal platform-admin contract** |
| Service principals/tokens | Existing APIs are scoped to the calling trusted application's own context | **Gap: cross-application platform-admin inspection/management contract** |
| Application × Model Access | Core table/runtime enforcement exists | **Gap: explicit platform-admin CRUD/list API** |
| Global users | Profile/self/internal creation and Access resolution/linking exist | **Gap: read-only platform-admin list/detail/search API** |
| Access principals | Identity persistence/resolution exists; user-facing listing/unlink is deferred | **Gap: read-only platform-admin inspector API** |
| Spaces | User/principal-scoped Space/member/Grant APIs exist | **Gap: platform-admin global list/detail inspector without pretending admin is a Space member** |
| Record counts | Generic Runtime owns data; no Console aggregation contract defined | **Gap: bounded batch count/summary API if needed** |
| Audit | No canonical Console/platform-admin audit surface is currently defined | **Gap: audit persistence + read API + mutation integration** |
| System summary | Individual status/version sources exist | Partial; aggregate safely in Console BFF or explicit read API |

## Required platform API design before write-capable Console

The first implementation slice is contract/security work, not UI.

### Identity

Add a formal platform-admin surface that can support, at minimum:

- list/get applications;
- bounded application policy mutation;
- application credential metadata/create/revoke;
- Access audience metadata/create/revoke;
- cross-application service-principal and credential inspection/management;
- global user read-only list/detail/search;
- Access principal read-only inspection.

These endpoints must use a dedicated privileged service/admin authorization boundary and must not accept `x-bootstrap-secret` as the normal Console credential.

### Core

Add platform-admin surfaces for:

- Application × Model Access list/upsert/delete;
- global Space read-only list/detail/member/Grant inspection;
- bounded per-Space model counts/summary if required for the MVP;
- platform-admin audit reads/writes or an approved shared audit boundary.

Existing service-only Model Admin remains authoritative and should be reused rather than duplicated.

### Authorization scopes

Do not grant the Console one unbounded hidden superuser bypass. Platform-admin authority should stay explicit and revocable. Exact new scope names are to be frozen with the Admin API contract, but they should remain capability-oriented (for example application administration, identity inspection, Space inspection, audit read) while preserving existing `models:manage` for Model Admin.

A platform-admin service credential still does not become a Space member and must not silently bypass ordinary business authorization on Generic Runtime routes.

## MVP non-goals

The first release explicitly excludes:

- ordinary business-record CRUD/editor;
- direct SQL/D1 console;
- Cloudflare control-plane management;
- GitHub CI/CD controls;
- HomeMew family product administration;
- ALOHA product administration;
- user impersonation;
- automatic user merge by email;
- arbitrary Access-principal reassignment;
- visual drag-and-drop Model Designer;
- AI auto-publication;
- arbitrary API/Swagger executor;
- infrastructure metrics dashboards;
- unrestricted Space/Grant mutation from a hidden platform superuser.

## Planned repository shape

After the Admin contract/security prerequisite is accepted and implemented, add:

```text
apps/
  core/
  identity/
  console/
```

`apps/console` should own the LifeSpace Console Web UI and same-origin Worker/BFF. It must not contain an independent business-data store or an independent Access-subject -> `usr_*` mapping.

The browser should call only the Console's same-origin BFF. Long-lived application/service credentials remain Worker secrets and are never delivered to browser JavaScript.

## Delivery slices

### Slice 0 — Admin contract and audit foundation

1. Define privileged admin scopes/authorization and verified actor attribution.
2. Add formal Identity platform-admin routes replacing bootstrap-only runtime needs.
3. Add Core Application × Model Access Admin API.
4. Add Core global Space Inspector API.
5. Add read-only Identity User/Access Principal Inspector API.
6. Add platform-admin audit persistence/read surface.
7. Add contract tests and deny-path tests proving ordinary user/application credentials cannot call these APIs.

### Slice 1 — Console shell and authentication

1. Add `apps/console` with repository-local `AGENTS.md`.
2. Register staging Console Web application and Access audience.
3. Implement Access -> Identity resolution and same-origin session/BFF boundary.
4. Implement Overview/System read views.
5. Prove staging/production configuration isolation.

### Slice 2 — Applications

Implement application, Access audience, application credential, service-principal/token and Application × Model Access views and allowed mutations.

### Slice 3 — Models

Implement Model Registry/Contract inspector plus validate/publish/retire flows using the existing service-only Model Admin boundary.

### Slice 4 — Users and Spaces

Implement read-only global user/Access-principal and Space/member/Grant inspectors, including bounded record-count summaries where available.

### Slice 5 — Audit and production rollout

Complete privileged-action audit UX, destructive-action confirmations, staging E2E, production Access application/audience provisioning and production deployment gates.

## MVP acceptance criteria

The MVP is complete when:

1. `lifespace.aisr.online` is protected by its own Cloudflare Access application and registered LifeSpace Access audience.
2. The same verified LifeSpace user can access the Console without introducing a separate LifeSpace Web IdP or parent-domain shared cookie.
3. The Console runtime contains no bootstrap secret in its normal management path.
4. Browser JavaScript contains no `lsa_*`, `lsp_pat_*`, bootstrap secret, signing key or other long-lived backend credential.
5. Applications, Access audiences, credentials/service principals and Application × Model Access can be managed through formal audited Admin APIs.
6. Model validate/publish/retire uses the canonical existing Model Admin validator/Registry/Contract path.
7. Global users/Access principals and Spaces/Grants can be inspected without direct D1 access and without treating the platform admin as an implicit Space member.
8. Every privileged Console mutation records the verified human actor and privileged executor without logging secret material.
9. Staging and production Console/Access/application credentials are fully isolated.
10. `pnpm check` and relevant Admin/Console integration tests prove allow and deny behavior before deployment.
