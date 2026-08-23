# LifeSpace Console MVP

## Positioning

**LifeSpace Console = LifeSpace 平台运维与治理控制台。**

生产域名：

```text
https://lifespace.aisr.online
```

staging 域名：

```text
https://lifespace-staging.aisr.online
```

Console 管理的是 LifeSpace 平台本身：Application、Model、Identity、Space、平台凭证、审计和系统状态。

它不是：

- HomeMew 家庭管理后台；
- ALOHA 管理后台；
- 通用业务数据编辑器；
- Cloudflare/GitHub 运维后台；
- SQL/D1 控制台。

## Delivery status

Current branch: `feat/lifespace-console-admin-foundation` / PR #42.

### Slice 0A — control-plane foundation

Implemented in repository and covered by CI:

- explicit LifeSpace `platform_administrators` assignment state in Identity;
- dedicated <=5-minute `purpose=platform_admin_actor` human proof;
- dual human-actor + controlled-executor authorization;
- Identity formal Platform Admin Application management;
- Application credential rotation/revocation with one-time plaintext;
- Cloudflare Access audience management;
- cross-application Service Principal / `lsp_pat_*` management;
- global read-only User + Access-principal inspector;
- Core Application × Model Access administration;
- global read-only Space/member/Data Grant/model-record-count inspector;
- Identity/Core platform-admin audit;
- Console-aware actor attribution for Model publish/retire while retaining service automation compatibility;
- separate Identity/Core Platform Admin OpenAPI companion contracts `0.1.0`;
- contract sanity checks in normal repository CI;
- idempotent staging provisioning helper and read-only staging E2E verifier.

### Slice 0B — staging proving shell

Implemented and deployed to staging:

```text
apps/console
```

The proving shell exists because a real Cloudflare Access end-to-end test needs a real protected Console origin. It establishes the permanent Worker/BFF/deployment security boundary before the full UI dependency set is introduced.

Current implementation:

- Cloudflare Worker + Workers Static Assets;
- staging custom domain `lifespace-staging.aisr.online`;
- staging/production Service Binding isolation for Identity/Core transport;
- `/api/session` for raw Access assertion -> Identity -> LifeSpace user resolution;
- staging-only `/api/session/register` for explicit first-use registration through Identity's canonical Access registration flow;
- `/api/platform/probe` for server-side actor-proof issuance plus bounded read-only Identity/Core admin checks;
- no browser-visible `lsa_*`, `lsp_pat_*`, Access bearer, LifeSpace bearer or actor proof;
- no business-data mutation, model publish/retire, credential management or arbitrary upstream proxy;
- temporary static presentation only; BFF code/config is intended to remain for the React/Vite UI.

Real Stage A browser proving confirmed an important identity invariant: a valid Cloudflare Access login whose verified `(iss, sub)` is unknown to Identity returns `ACCESS_PRINCIPAL_UNLINKED`; it is not auto-created or merged from email. The proving shell therefore exposes the canonical explicit create-new-user path in staging only. The browser may supply only a display name and explicit confirmation; the Worker supplies the current Access assertion and server credential, Identity creates the new `usr_*` plus mapping atomically, and the returned LifeSpace bearer remains server-side. The registration write requires exact same-origin browser evidence plus a dedicated intent header and is unavailable in production.

If an operator already has a staging LifeSpace user, they must not create a second one. Existing-account linking remains the proof-backed Identity link-challenge flow, confirmed by an already authenticated LifeSpace user credential; the Console must not substitute a `userId` picker or email match.

### Slice 0 staging acceptance gate

Stage A infrastructure proving has passed:

- Identity staging migrated/deployed to schema v7;
- Core staging migrated/deployed to schema v26;
- `app_lifespace_console_staging` and the staging Access AUD are registered;
- Console session-only Worker is deployed behind Access;
- real Access login reaches the Console and the unlinked-principal path has been proved;
- Console 0.0.2 explicit staging registration flow has passed full repository checks and code-only staging redeploy;
- production resources were not touched.

Slice 0 remains accepted only after the remaining real staging steps:

1. explicitly resolve the current Access principal to one staging LifeSpace `usr_*` by either new-user registration or proof-backed existing-account linking;
2. bootstrap that exact `usr_*` as a staging platform administrator;
3. provision the Console exact-scope Core service executor;
4. prove real Access -> LifeSpace user -> actor proof -> Identity/Core platform-admin flow through the protected Console origin;
5. prove missing/wrong-purpose/wrong-application actor/executor denial and explicit unlinked-account handling;
6. prove existing service-only Model Admin automation still works;
7. remove temporary feature-branch proving triggers before PR Ready;
8. prove production LifeSpace/HomeMew services, credentials and data are untouched.

### Slice 1 — React/Vite Console shell

Starts after Slice 0 staging acceptance.

Keep the proving shell's Worker/BFF/security/deployment boundary and replace the temporary static presentation with:

- React;
- TypeScript;
- Vite;
- Cloudflare Vite plugin / Workers Static Assets;
- persistent Console navigation/layout/error states/environment banner;
- purpose-specific BFF client modules generated/thinly wrapped around the explicit control-plane contracts.

This separates a new frontend dependency/toolchain slice from the security/control-plane foundation while avoiding throwaway backend code.

### Slice 2 — MVP pages

Implement the six functional areas defined below: Overview, Applications, Models, Users, Spaces, Operations.

## Information architecture

```text
LifeSpace
├─ Overview
├─ Platform
│  ├─ Applications
│  ├─ Models
│  ├─ Users
│  └─ Spaces
└─ Operations
   ├─ Audit
   └─ System
```

## Overview

Purpose: answer“平台现在是否健康、关键控制面处于什么状态”。

MVP cards:

- current environment (`staging` / `production`) with strong production warning;
- Identity health + contract/schema status;
- Core health + Kernel/schema status;
- Identity/Core Platform Admin contract version;
- published model count + Registry revision;
- active `mct_*` Model Contract Revision;
- registered Application count;
- user count;
- Space count;
- warning area for unavailable service/contract mismatch.

Not MVP:

- Grafana replacement;
- detailed latency/CPU/request dashboards;
- log search platform.

## Applications

Applications is one of the primary MVP pages because it replaces platform setup currently done by scripts/curl.

### List

Show:

- application name;
- Application ID;
- client type;
- active/disabled state;
- trusted-backend flag;
- number of Access audiences;
- number of Service Principals;
- current model-access summary.

### General

Read/update bounded application policy:

- name;
- allowed scope ceiling;
- access-token TTL;
- status.

Display immutable classification:

- Application ID;
- client type;
- trusted-backend flag;
- created/updated time.

### Application credentials

- list only metadata/suffix/status/time;
- create replacement `lsa_*`;
- plaintext displayed exactly once;
- revoke old credential;
- never reveal stored plaintext/hash.

### Cloudflare Access

For Web applications:

- issuer;
- audience values;
- status;
- register/revoke audience.

No Access `aud` is treated as a user key.

### Application × Model Access

For each published model, show/configure maximum application access:

```text
none / read / write / manage
```

This is Core authorization state and is independent from Identity token scope ceiling.

### Service Principals

Within a target application:

- list/create service principals;
- display/update name/description/maxScopes/status;
- disable/re-enable principal;
- list opaque token metadata;
- create token with one-time plaintext;
- update label/expiry and reduce token scopes;
- revoke token.

OAuth credential UI may be added after opaque-token MVP unless a concrete operator need blocks deployment.

## Models

The Console manages the Model Registry; it does not become a free-form low-code IDE.

### Model list

Show:

- key;
- route;
- model version;
- publication state;
- schema hash;
- compatibility classification;
- declared access capabilities.

### Model detail

Structured inspection of the current published Model Definition:

- General;
- Fields;
- Relations;
- Access;
- Query;
- Lifecycle;
- Capabilities;
- Actions/workflow;
- Policy;
- raw definition.

### Validate / publish

MVP flow:

```text
edit or paste Model Definition
-> validate
-> show issues/schema hash
-> select/confirm compatibility classification
-> show affected definition summary
-> publish with explicit confirmation
```

Console-triggered publication sends the five-minute human actor proof in addition to the Core `models:manage` service executor, so audit distinguishes the human from backend execution.

### Retire

Retirement requires explicit destructive confirmation, preferably typing the model key.

History/contract inspection:

- active `mct_*` revision;
- immutable historical revision reads;
- manifest/OpenAPI/JSON Schema inspection.

Not MVP:

- drag-and-drop model designer;
- AI auto-publish;
- arbitrary code/SQL policy editor.

## Users

Users is initially a **read-only Identity troubleshooting inspector**.

### User list

- search by `usr_*` or display name;
- filter active/disabled;
- bounded page/result size.

### User detail

Show:

- global `usr_*`;
- display name;
- avatar;
- status;
- created/updated time;
- linked Cloudflare Access principals.

For each Access principal show only operational metadata:

- issuer;
- subject;
- email snapshot marked non-authoritative;
- status;
- linked/last-seen times.

Not MVP:

- edit `usr_*`;
- manual Access-subject editing;
- email-based merge;
- user impersonation;
- arbitrary account unlinking/recovery before lockout threat model exists.

## Spaces

Spaces is initially a **read-only Core troubleshooting inspector**. A platform administrator does not become a hidden member of every Space.

### Space list

Search/filter by:

- `spc_*` / name;
- kind (`personal` / `family` / `team`).

Show bounded summaries:

- owner/creator metadata where exposed;
- member count;
- active Grant count;
- ordinary record count.

### Space detail

Show:

- ID/name/kind/timezone/version;
- active members and linked Space Person display names;
- Data Grants including revoked/expiry state where returned;
- record counts grouped by model key.

Not MVP:

- edit arbitrary family/personal business records;
- force membership changes;
- arbitrary Data Grant mutation from the platform console;
- bypass Space authorization by impersonation.

## Audit

The Console must expose platform-control audit evidence, not only application logs.

Each privileged event should distinguish:

- human actor `usr_*`;
- actor application/token proof metadata;
- backend/service executor;
- operation;
- target type/ID;
- secret-free summary/before-after information;
- request ID;
- timestamp;
- result (`pending` / `success` / `failure` where applicable).

Identity and Core have separate authoritative audit stores because each service owns its state. The Console may aggregate them in the UI but must not create a third authoritative audit database.

MVP filters:

- service (`identity` / `core`);
- operation;
- actor user;
- target;
- result;
- recent time range.

Credential plaintext, credential hash and Authorization headers are never audit fields.

## System

Read-only deployment/control-plane status:

- environment;
- Identity URL/health/schema/application contract version/platform-admin contract version;
- Core URL/health/schema/Kernel version/platform-admin contract version;
- Registry revision;
- active Model Contract Revision;
- deployment/version metadata when already available from the platform runtime.

System is not a Cloudflare dashboard. Configuration changes to Workers/D1/R2/Queues/Access remain infrastructure/deployment workflows unless a future explicit requirement justifies bringing a bounded operation into LifeSpace.

## Security architecture

### 1. Cloudflare Access is the perimeter, not final admin authorization

```text
Browser
-> Cloudflare Access
-> Console BFF
-> LifeSpace Identity usr_* resolution
```

An Access email/session alone does not make the user a LifeSpace platform administrator.

### 2. Explicit administrator assignment

Identity owns `platform_administrators`. Initial assignment/recovery is bootstrap-only.

### 3. Purpose-bound human proof

A currently assigned administrator obtains:

```text
POST /api/v1/me/platform-admin-actor-token
```

The returned JWT is limited to:

```text
scope   = platform:admin
purpose = platform_admin_actor
TTL     = 300 seconds
azp     = Console application
```

It is not a normal reusable product user token.

### 4. Separate executor

Identity operations:

```text
Authorization: Bearer <Console lsa_*>
X-LifeSpace-Actor-Token: <actor proof>
```

Core operations:

```text
Authorization: Bearer <Console service executor>
X-LifeSpace-Actor-Token: <actor proof>
```

Actor and executor application context must match.

### 5. Bootstrap secret is break-glass only

The global bootstrap secret must never be stored in the normal Console Worker/BFF or browser. It remains for provisioning/recovery such as initial platform-administrator assignment.

## Contract model

The Console consumes privileged companion contracts rather than broadening product contracts:

```text
Identity application/user/service contract: 0.5.0
Identity Platform Admin contract:             0.1.0

Core Kernel contract:                         0.12.0
Core Platform Admin contract:                 0.1.0
Model Contract Revision:                      mct_<hash>
```

This separation allows HomeMew/ALOHA to retain their business contract pins when Console-only control-plane APIs evolve.

Canonical files:

```text
apps/identity/openapi.yaml
apps/identity/platform-admin.openapi.yaml
apps/core/openapi.yaml
apps/core/platform-admin.openapi.yaml
```

## Technical implementation

Current proving implementation:

```text
apps/console
  Cloudflare Worker/BFF
  Workers Static Assets
  temporary dependency-light proving page
```

The Worker reads `Cf-Access-Jwt-Assertion` only at the server boundary and forwards the original assertion to Identity. It never trusts browser-selected decoded Access identity fields. For staging/production, Service Bindings transport requests to the corresponding Identity/Core Workers, while explicit LifeSpace executor credentials remain the authorization boundary.

Cloudflare Static Assets uses Worker-first routing only for `/api/*`; static presentation files do not contain privileged data. The BFF exposes bounded purpose-specific routes instead of an arbitrary proxy.

Final UI stack after staging proving:

- React;
- TypeScript;
- Vite;
- Cloudflare Vite plugin / Worker Static Assets;
- one Worker deployment containing static UI + same-origin BFF.

Request topology:

```text
Browser
-> lifespace.aisr.online / lifespace-staging.aisr.online
-> Cloudflare Access
-> Console Worker/BFF
   -> Identity
   -> Core
```

Browser JavaScript never receives server executor credentials or Actor Proof.

Production and staging use separate:

- Access Applications/audiences;
- Console LifeSpace applications;
- executor credentials;
- Console Workers;
- Identity/Core Workers and data stores;
- administrator proving state as appropriate.

## MVP non-goals

- ordinary business-data editor;
- SQL/D1 console;
- Cloudflare configuration manager;
- GitHub CI/CD manager;
- HomeMew family administration;
- ALOHA product administration;
- user impersonation;
- email-based account merging;
- AI automatic model publication;
- drag-and-drop model designer;
- heavy observability dashboards;
- arbitrary Space membership/Grant mutation;
- arbitrary Swagger/API executor.

## Acceptance criteria

The MVP is accepted only when all of the following are true:

1. staging Access login reaches the Console application and resolves a LifeSpace `usr_*` through explicit Identity registration/linking where first-use resolution is required;
2. an assigned platform administrator can obtain the five-minute actor proof;
3. a non-assigned user cannot obtain/use platform-admin authority;
4. Identity and Core privileged calls require both human proof and the correct server executor;
5. cross-application actor/executor pairing is rejected;
6. Applications/Model Access/Service Principal operations are auditable with human + executor attribution;
7. User and Space inspector surfaces are read-only and do not create hidden authority;
8. Console-triggered Model publish/retire records actor-aware audit while existing service automation still works;
9. credential plaintext is one-time-only and never appears in list/audit responses;
10. production and staging are isolated and staging proving does not modify production LifeSpace/HomeMew data;
11. `apps/console` uses only the documented Platform Admin/business contracts and no bootstrap secret;
12. browser code never receives Access/LifeSpace/Actor/Executor bearer material from the Console BFF;
13. repository CI and staging E2E are green before production rollout.
