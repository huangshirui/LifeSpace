# LifeSpace Console MVP

## Positioning

**LifeSpace Console = LifeSpace 平台运维与治理控制台。**

生产域名：

```text
https://lifespace.aisr.online
```

建议 staging 域名：

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

### Slice 0 — control-plane foundation

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
- contract sanity checks in normal repository CI.

Still required before Slice 0 is considered deployed/accepted:

- apply Identity migrations `0006_platform_admin_audit.sql` and `0007_platform_administrators.sql` to staging;
- apply Core migration `0026_platform_admin_audit.sql` to staging;
- deploy matching Identity/Core branch runtime to staging;
- provision a dedicated staging Console LifeSpace application;
- register the staging Cloudflare Access audience;
- provision the Console Identity `lsa_*` executor and Core service executor;
- bootstrap at least one staging platform-administrator assignment;
- prove real Access -> LifeSpace user -> actor proof -> Identity/Core platform-admin flows;
- prove missing/revoked/wrong-application actor/executor denial;
- prove production services/data remain untouched.

### Slice 1 — Console application shell

Starts after Slice 0 staging proof:

- add `apps/console` in the LifeSpace monorepo;
- React + TypeScript + Vite + Cloudflare Worker/Static Assets;
- same-origin BFF;
- Cloudflare Access protected staging hostname;
- session/bootstrap flow that resolves the Access principal to a LifeSpace user and obtains actor proof only when privileged calls are needed;
- navigation/layout/error states/environment banner.

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

Purpose: answer “平台现在是否健康、关键控制面处于什么状态”。

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

Planned Console application location:

```text
apps/console
```

Preferred stack:

- React;
- TypeScript;
- Vite;
- Cloudflare Vite plugin / Worker Static Assets;
- one Worker deployment containing static UI + same-origin BFF.

Request topology:

```text
Browser
-> lifespace.aisr.online
-> Cloudflare Access
-> Console Worker/BFF
   -> Identity
   -> Core
```

Browser JavaScript never receives server executor credentials.

Production and staging use separate:

- Access Applications/audiences;
- Console LifeSpace applications;
- executor credentials;
- Workers/D1/R2/Queues;
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

1. staging Access login reaches the Console application and resolves a LifeSpace `usr_*` through Identity;
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
12. repository CI and staging E2E are green before production rollout.
