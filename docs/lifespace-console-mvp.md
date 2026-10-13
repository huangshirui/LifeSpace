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

Console 管理 LifeSpace 平台本身的控制面：Application、Model、Identity、Space、平台凭证、审计和系统状态。

它不是：

- 下游产品的业务管理后台；
- 通用业务数据编辑器；
- Cloudflare/GitHub 运维后台；
- SQL/D1 控制台。

## Delivery status

### Control-plane foundation — merged

PR #42 已将 Console 所需的控制面安全基础合并到 `main`：

- Identity 显式 `platform_administrators` assignment；
- <=5 分钟 `purpose=platform_admin_actor` human proof；
- human actor + controlled executor 双重授权；
- Identity Platform Admin Application 管理；
- Application credential 与 Access audience 管理；
- cross-application Service Principal / `lsp_svc_*` 管理（legacy `lsp_pat_*` 仅迁移兼容）；
- 全局只读 User + Access-principal inspector；
- Core Application × Model Access 管理；
- 全局只读 Space/member/Data Grant/model-record-count inspector；
- Identity/Core platform-admin audit；
- Console-aware Model publish/retire actor attribution；
- Identity/Core 独立 Platform Admin companion contracts `0.1.0`；
- staging provisioning / verifier。

Core Kernel 与 Identity Application Contract 不因 Console 控制面变化而升级；当前 Kernel 已由独立的 Data Grant 变更推进到 `0.13.0`，Identity Application Contract 仍为 `0.5.0`。

### Historical staging proving shell — completed bootstrap role

早期 `apps/console/public` dependency-light proving shell 用于在真实 `lifespace-staging.aisr.online` + Cloudflare Access 环境证明：

```text
Access
-> Console Worker/BFF
-> Identity Access exchange
-> LifeSpace usr_*
-> actor proof
-> Identity/Core control plane
```

它已经完成架构验证职责，不再是当前前端实现；`public/` proving assets 已在当前 UI slice 中删除。

真实 proving 也确认了关键 Identity invariant：合法 Access `(iss, sub)` 如果 Identity 未知，会返回 `ACCESS_PRINCIPAL_UNLINKED`，不会依据 email 自动创建或自动合并用户。

### Current UI slice — PR #47

Current branch:

```text
feat/lifespace-console-ui-shell
```

Current PR:

```text
#47 feat: build LifeSpace Console React read-only MVP
```

Repository implementation and CI currently include:

- React 19 + TypeScript + Vite；
- Cloudflare Vite plugin + Worker/Static Assets；
- permanent sidebar/navigation/layout/error/environment/operator states；
- Overview；
- Applications list + diagnostic detail；
- Models list + published-definition detail；
- Users + linked Access-principal diagnostics；
- Spaces + member/Grant/model-record-count diagnostics；
- aggregated Identity/Core Audit；
- System status/security-boundary diagnostics；
- bounded same-origin `/api/*` BFF；
- frozen workspace lockfile；
- Vite build-time Cloudflare environment selection；
- semantic existing Application ID compatibility while new applications remain generated `app_*` IDs。

当前 slice **只实现只读控制台**。以下 mutation UI 明确延期：

- Application policy / credential / Access audience mutations；
- Service Principal / Service API Token mutations；
- Application × Model Access writes；
- Model validate / publish / retire。

PR #47 在 production 上没有部署，也不得在本 slice 未经明确批准时触碰 production。

### Remaining gate for PR #47

在 PR Ready 前还需要：

1. 将当前 React/Vite + bounded BFF build 部署到 staging；
2. 用精确 staging `usr_*` 完成 full platform-admin provisioning；
3. 真实浏览器通过 Cloudflare Access 验证 Overview / Applications / Models / Users / Spaces / Audit / System；
4. 验证浏览器响应/源码中没有 Access/LifeSpace/actor/executor bearer；
5. 保留 missing assertion / unlinked / non-admin / wrong-purpose / wrong-application deny evidence；
6. 确认现有 service-only Model Admin automation 仍不受影响；
7. production LifeSpace and external-application services/credentials/data remain untouched。

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

目标：回答“平台现在是否健康，关键控制面处于什么状态”。

当前只读 MVP 展示：

- environment；
- Identity health / schema / application contract；
- Core health / schema / Kernel contract；
- Identity/Core Platform Admin companion contract versions；
- Application / Model / User / Space counts；
- recent Identity/Core audit；
- count truncation warning（bounded inspector 达到上限时）。

后续可在已有平台接口提供时加入 Registry revision / active `mct_*` revision，不为此在 Console 建独立状态源。

不是 MVP：Grafana replacement、CPU/latency dashboard、日志搜索平台。

## Applications

### Current read-only slice

List shows：

- name；
- Application ID；
- client type；
- active/disabled；
- trusted-backend；
- allowed scopes；
- token TTL。

Detail aggregates authoritative control-plane metadata from Identity/Core：

- application metadata；
- Application credential metadata only（suffix/status/time，无 plaintext/hash）；
- Access audiences；
- Service Principals；
- Application × Model Access。

Existing Application targets accept the canonical semantic identifier form:

```text
^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$
```

This preserves earlier LifeSpace IDs such as semantic application names. New Platform Admin creation still produces generated `app_*` IDs.

### Deferred write slice

Future bounded mutations may expose：

- name / allowedScopes / access-token TTL / status；
- replacement `lsa_*` credential with plaintext exactly once；
- credential revoke；
- Access audience register/revoke；
- Application × Model Access replacement；
- Service Principal create/update/disable；
- opaque token create/update/revoke with plaintext exactly once and scope-reduction-only updates。

Browser never receives the Console's own executor credentials as part of these operations.

## Models

### Current read-only slice

Show current published Model Registry entries：

- key；
- route；
- version；
- state；
- schema hash；
- compatibility；
- declared access capabilities；
- structured/raw published definition detail。

### Deferred write slice

Future explicit workflow：

```text
edit/paste Model Definition
-> validate
-> show issues/schema hash
-> choose/confirm compatibility
-> review affected definition
-> explicit publish
```

Retire remains a destructive explicit-confirmation action.

Console-triggered publish/retire must continue to send the five-minute human actor proof in addition to the Core `models:manage` service executor so audit keeps human/executor attribution separate.

Not MVP：drag-and-drop model designer、AI auto-publish、arbitrary SQL/JS policy editor。

## Users

Users remains a **read-only Identity troubleshooting inspector**。

List：

- search `usr_*` / display name；
- status filter；
- bounded result size。

Detail：

- global `usr_*`；
- display name / avatar / status / timestamps；
- linked Cloudflare Access principals；
- issuer / subject / status / timestamps；
- email snapshot clearly non-authoritative。

Not MVP：

- edit `usr_*`；
- manual Access subject editing；
- email merge；
- impersonation；
- arbitrary unlink/recovery before a complete lockout threat model exists。

## Spaces

Spaces remains a **read-only Core troubleshooting inspector**。Platform administrator does not become a hidden member of every Space。

List：

- search by `spc_*` / name；
- member count；
- active Grant count；
- active ordinary record count。

Detail：

- ID / name / timezone / version；
- active members + linked Space Person display names；
- Data Grants including revoked/expiry state；
- record counts grouped by model key。

Not MVP：

- arbitrary downstream business-record edit；
- force membership；
- arbitrary Data Grant mutation；
- authorization bypass by impersonation。

## Audit

Identity 与 Core 各自保留 authoritative platform-admin audit store；Console 仅聚合展示，不创建第三份审计数据库。

Each privileged event distinguishes：

- human actor `usr_*`；
- actor application/token proof metadata；
- backend/service executor；
- operation；
- target type/ID；
- secret-free summary；
- request ID；
- timestamp；
- result (`pending` / `success` / `failure` where applicable)。

Credential plaintext/hash 与 Authorization headers 永远不是 audit 字段。

## System

当前只读 System 展示：

- environment；
- Console version；
- Identity status/schema/application contract；
- Core status/schema/Kernel contract；
- Identity/Core Platform Admin companion version；
- server-only security-boundary assertions；
- Identity/Core executor path availability。

System 不是 Cloudflare dashboard。Workers/D1/R2/Queues/Access 配置继续属于 infra/deployment workflow，除非未来有明确、受限、可审计的平台需求。

## Security architecture

### 1. Cloudflare Access is the perimeter, not final authorization

```text
Browser
-> Cloudflare Access
-> Console Worker/BFF
-> Identity usr_* resolution
```

Access email/session alone does not grant LifeSpace platform administration。

### 2. Explicit administrator assignment

Identity owns `platform_administrators`。Initial assignment/recovery remains bootstrap-only。

### 3. Purpose-bound human proof

A current administrator obtains：

```text
POST /api/v1/me/platform-admin-actor-token
```

Proof constraints：

```text
scope   = platform:admin
purpose = platform_admin_actor
TTL     <= 300 seconds
azp     = Console application
```

A normal user JWT carrying `platform:admin` without the dedicated purpose is not accepted。

### 4. Separate controlled executor

Identity：

```text
Authorization: Bearer <Console lsa_*>
X-LifeSpace-Actor-Token: <actor proof>
```

Core：

```text
Authorization: Bearer <Console service executor>
X-LifeSpace-Actor-Token: <actor proof>
```

Actor and executor must use the same LifeSpace application context。

### 5. Browser/Worker boundary

Browser calls only same-origin fixed `/api/*` endpoints。

Browser JavaScript never receives：

- raw Access assertion；
- LifeSpace user bearer；
- actor proof；
- Console `lsa_*`；
- Core `lsp_pat_*`；
- bootstrap secret。

The BFF validates fixed route shapes, identifier formats, query allow-lists, duplicate query parameters and bounded result limits before composing upstream calls。It never accepts client-controlled upstream URLs/paths/Authorization headers。

### 6. First-use Access registration

Staging may retain one bounded first-use mutation for the **current verified Access principal**：

```text
POST /api/session/register
```

Requirements：

- staging only；
- exact same-origin browser evidence；
- explicit intent header and user confirmation；
- browser supplies display name only；
- Identity canonical `/internal/v1/access/registrations` owns creation；
- no target `usr_*` / email / subject override；
- no email auto-merge；
- existing-account linking remains proof-backed Identity link challenge。

### 7. Bootstrap is not runtime authority

Bootstrap secret is never installed into the normal Console Worker or browser。It remains provisioning/break-glass authority only。

## Contract model

Console consumes privileged companion contracts rather than broadening downstream product contracts：

```text
Identity Application Contract:    0.5.0
Identity Platform Admin Contract: 0.1.0

Core Kernel Contract:             0.13.0
Core Platform Admin Contract:     0.1.0
Model Contract Revision:          mct_<hash>
```

Canonical files：

```text
apps/identity/openapi.yaml
apps/identity/platform-admin.openapi.yaml
apps/core/openapi.yaml
apps/core/platform-admin.openapi.yaml
```

Downstream applications do not repin business contracts merely because Console governance syntax changes。

## Technical implementation

Current implementation：

```text
apps/console
├─ React + TypeScript client
├─ Vite
├─ @cloudflare/vite-plugin
├─ Cloudflare Worker/BFF
└─ Workers Static Assets
```

Request topology：

```text
Browser
-> lifespace.aisr.online / lifespace-staging.aisr.online
-> Cloudflare Access
-> Console Worker/BFF
   -> Identity
   -> Core
```

Cloudflare Service Bindings may transport calls to the matching Identity/Core Worker, but explicit LifeSpace executor credentials remain the authorization boundary and no cross-app DB coupling is introduced。

### Vite deployment model

Vite owns the client build output and generated Worker deployment config。Environment is selected at build time：

```text
CLOUDFLARE_ENV=staging pnpm exec vite build
pnpm exec wrangler deploy --secrets-file <ephemeral-secrets-file>
```

The old `assets.directory: ./public` proving configuration must not be restored。Production uses a separate build environment/configuration and requires explicit deployment approval。

### Environment isolation

Staging and production have independent：

- Access Applications/audiences；
- Console LifeSpace Applications；
- executor credentials；
- Console Workers；
- Identity/Core workers/data stores。

Staging must never point to production services/secrets and vice versa。

## MVP non-goals

- ordinary business-data editor；
- SQL/D1 console；
- Cloudflare configuration manager；
- GitHub CI/CD manager；
- downstream product administration；
- user impersonation；
- email-based account merging；
- AI automatic model publication；
- drag-and-drop model designer；
- heavy observability dashboards；
- arbitrary Space membership/Grant mutation；
- arbitrary Swagger/API executor。

## Acceptance criteria

The read-only React/Vite slice is Ready only when：

1. workspace install uses committed `pnpm-lock.yaml` with `--frozen-lockfile`；
2. full repository `pnpm check` is green；
3. staging Access login reaches the React Console and resolves one explicit LifeSpace `usr_*`；
4. assigned platform administrator can obtain the five-minute actor proof；
5. non-assigned / wrong-purpose / wrong-application authority is denied；
6. Identity/Core privileged reads require both human proof and correct server executor；
7. Applications/Models/Users/Spaces/Audit/System show only their bounded intended data；
8. User/Space inspectors do not create hidden platform authority；
9. browser-visible code/responses contain no Access/LifeSpace/actor/executor bearer material；
10. staging Vite build/deploy uses the staging-generated configuration and credentials；
11. existing service-only Model Admin automation still works；
12. production and staging remain isolated and this slice does not modify production external-application data；
13. real staging browser/E2E evidence is complete before production rollout is considered。

Write-capable Console administration is a separate subsequent slice and must preserve the same actor/executor, one-time-secret and audit boundaries。

## External model configuration (development candidate)

Model registration reuses the governed Model Definition publication dialog (`origin: external`, fields {}). Space detail offers binding to a published External definition, an existing Space connection and concrete Data Source ID. Binding is a separate approved platform configuration use case: BFF exchanges the current Access assertion for a server-only User token with profile:read/spaces:manage and calls only bounded Core Space configuration routes. Core checks current manage membership; platform inspection grants no hidden authority. Existing Console application credentials must explicitly allow spaces:manage; no production credential or scope is changed by this candidate. Connection Secret provisioning remains controlled service-only Model Admin. Real staging browser acceptance is still required.
