## 2026-11-09 · Account-selected third-party Delegation lifetimes / 第三方授权期限（三选一，开发待验收）

User-selected **Account approval**, not Agent-requested escalation, now chooses one of:
- **once (default)**: one approved operation, expires 30 minutes after approval;
- **timed**: repeat the exact approved model operation for 1 hour / 24 hours / 7 days (explicit Account option, maximum 7 days);
- **until_revoked**: repeat that exact operation until Account User revokes it or current OAuth/Space/Grant/Model authority ceases.

The original OAuth consent only enables requesting a Delegation; every `arq_*` still requires independent Account session and CSRF-protected approval. The operation-bound `dlg_*` keeps User Principal / Agent Actor, Client/Application/Resource/Space binding and current Core authorization. Account `/delegations` lists and revokes own active third-party grants, even after OAuth disconnect. The request URL expires in 10 minutes; selecting an unlimited lifetime never broadens the model/operation target or overrides live revocation checks.

External Provider single-use writes still consume **before one outbound attempt**. An explicitly approved recurring or indefinite External write may cause multiple individual Provider attempts; no exactly-once or cross-Provider atomicity guarantee is implied. The UI warns that repeated approvals can modify multiple records in the selected model.

This is **source on an unmerged development branch**, not deployed Staging or Production; CI + browser/Staging E2E and owner review remain required. Historical sections below describe earlier one-use-only slices.

# Identity Interactive OAuth Authorization Server / 交互式 OAuth 授权服务

## 2026-11-09 · Third-party External delegated write attempt / 第三方外部写入授权（待部署）

The Owner decided that a one-use OAuth MCP `arq_*` → Account-confirmed `dlg_*` may authorize a Provider-backed External write when the current MCP Server operation, OAuth Scope, User authority, Application Model Access, Space/Data Grant, Core bound Model/Provider and current record policy permit it. **One User approval means one external write attempt, regardless of outcome**, not one successful remote commit. Core consumes the approved one-use Delegation before Provider I/O, prevents replay/auto-retry, audits unknown outcomes, and requires a new Account approval for any subsequent attempt. A timeout may have modified the Provider; inspect current state before reapproval where possible. No trusted ALOHA/verified-WeCom UX changes and no new lifetime modes: Account still issues one-use only.


## 2026-11-09 · Person Directory Account Delegation / 第三方网页 Person 授权（候选）

For `modelKey:person`, the third-party OAuth MCP Agent can request exactly the current Server-selected `query/get/create/update/delete` operations. Core internally maps `query` to Kernel `list` and `modelKey:person` to a narrow `model:person_directory` Delegation target; it is never a broad `space` grant. After independent Account User approval, Core enforces current Person Data Grant/Membership and linked User restrictions, signed Principal=User / Actor=Agent, current OAuth Consent/Client/Resource and one-use replay prevention. The existing trusted ALOHA/verified WeCom Agent confirmation path remains unchanged. This adds no new route, database schema, or Agent/Identity credential type.

Core supports generic lifetime modes (one-use, time-limited repeated, and indefinite revocable). The **third-party Account-link confirmation UX remains intentionally one-use only**, not a lifetime chooser. The prospective Person behavior is **not Production / deployed Staging** until the exact SHA is promoted and real OAuth E2E is verified.


## 2026-11-08 · Third-party OAuth MCP User Delegation / 第三方网页确认（待 Staging 真实验收）

- Third-party Client access does not imply User Principal. The initial OAuth account page only records `allowUserAuthorization` eligibility; `resources:write` is a separate client Scope. Agent Direct remains `Principal=Actor=Agent`.
- A signed, current-authorized OAuth Agent may create a pending `arq_*` for exactly one allowed Native Model operation (get/query/create/update/delete), with a short-lived LifeSpace Account URL and request-reason preview. The intended `usr_*` is taken only from verified, current Identity Authorization, never an Agent argument. Requests are bounded by selected Client/Application/Agent/Space/Resource, current exact Server operation, OAuth Scope, TTL and rate limit.
- On `/delegation?request_id=arq_*`, LifeSpace Account independently authenticates its own User via Cloudflare Access → Identity, displays exact operation/Resource, and POSTs an explicit CSRF-protected Approve/Deny to Core. Core validates that the intended User matches the authenticated Account principal, rechecks the bound OAuth Authorization and current User/App Authority, and creates an immutable, short-lived `dlg_*` (one successful use) atomically with approval. The URL/request ID alone is NOT a bearer authority.
- To execute, the third-party MCP client explicitly selects that approved `dlg_*`; private Identity mints a ≤60-second represented JWT with `Principal=User, Actor=Agent` and signed OAuth Resource/Client/Agent/User/Space/Delegation context. Every Core call independently validates current OAuth state, exact approved `arq_*` operation binding, current Delegation and User authority, server operation, model policy, version and atomic single-use consumption/Change attribution. Other operations/cross-Space use fail closed.
- Existing **ALOHA app-internal confirmation** and **WeCom trusted Router chat confirmation** remain unchanged. The original trusted `/authorization-requests/.../confirm` path refuses `oauth_mcp` requests even if a trusted Agent knows the request ID; OAuth credentials cannot call the trusted path. All three channels share only Core `arq_*` and `dlg_*` domain facts, not confirmation UX or credentials.
- **Release status:** Source in [LifeSpace PR #500](https://github.com/huangshirui/LifeSpace/pull/500) + companion Adapters PR #38; no deployed or real Staging end-to-end approval proof yet. Account User, expired/revoked/cross-channel and represented execution tests are separate release gates under #499. Existing historical Staging-only sections below are superseded for current target design and do not indicate Production readiness.


Status: **Staging deployed; Production convergence in development. No production OAuth MCP release has been verified.** This is Identity's protocol and credential work, not a general `conn_*` registry and not a replacement for Core Authority.

## 2026-11-08 · 生产能力收敛（开发中，未生产发布）

> 本节是较早「Staging-only Candidate」段落的后续修订；它们是实施历史，不应当再被解读为当前目标。真正 Production 发布状态以 `docs/production/` 和发布工作流证据为准。

- OAuth MCP 的协议与 Authority（权限）语义不由 `ENVIRONMENT` 决定。Core 每次根据**当前启用的** `mcp_*` Server、其模型/Kernel 操作列表，提供用于 OAuth 的资源 Scope 上限（`resources:read` 或 `resources:read resources:write`）；该值只表示 Server 能力，不是用户/Agent 的 Data Grant。
- 核心 OAuth 授权仅接受客户端实际申请且 Server 允许的 Scope；未指定时按最小读取处理，管理/未知 Scope 不会被隐式映射为 MCP 数据管理。首次 Account Consent 显示实际请求，不自动扩权；旧 read-only token 不会变成 write token。
- Identity 当前有效 Authorization + Access Token 的 Scope 才进入短期 Agent Direct JWT。Core 对每个操作重新核对 OAuth 当前授权、选定 Space/Resource、MCP Server operation、Application × Model Access、Agent Data Grant、Model Policy、记录版本；Staging/Production 共享相同语义。没有配对资源/秘密/Service Binding 的环境继续 fail closed。
- CIMD/DCR 以环境中的明确特性开关 **且** Console 当前准入策略 **且** 同环境 Rate Limiter 为前置条件；Production 不再因名字而硬拒绝，但默认配置仍不启用注册，必须单独走受保护的上线审批。允许生产注册绝不等于验证第三方品牌身份。
- `allowUserAuthorization` 仅表示未来可申请用户 Delegation。Core `arq_*`/`dlg_*` 与 Account 独立人工确认、显式 Principal=User/Actor=Agent、撤销及审计尚需在正式发布前完成。Native `get`/Action/Person Directory/External Tool 的配置与暴露差异也仍是正式验收阻塞项。
- 发布追踪：[LifeSpace #499](https://github.com/huangshirui/LifeSpace/issues/499)。代码合并/Staging 测试不构成 Production 能力声明。

## Authority / 权限分工

- Cloudflare Access authenticates the Account Web SSO session. The Account BFF must exchange and verify the Access assertion through the existing Identity trust path. OAuth client metadata is not identity proof.
- Identity owns OAuth Client registration, Authorization requests/instances, one-time codes, opaque access/refresh credentials, revocation and introspection.
- A successful Consent selects one LifeSpace Application, one Space and a currently bound Agent. An OAuth Authorization is a distinct grant instance (not a Service/Agent identity); multiple authorizations may share a Client or Agent.
- Core owns Space authority, Data Grants, Agent Direct capability, User Delegation and current operation policy. The Actor is always the selected `agt_*`, never the user by default. `allowUserAuthorization` permits a later `arq_* -> dlg_*` request; it is **not** Delegation itself.
- Service `svc_*` and Agent `agt_*` may have multiple Space / Model Grants; the single-Space limit applies only to one interactive OAuth Authorization in MVP.
- The public OAuth token is never forwarded directly to Core. A trusted Adapter must introspect it and obtain a separate bounded execution credential; Core still re-evaluates live Grants/Delegation/Application Model Access.
- Resource Audience is an exact registered HTTPS URI; `OAUTH_ALLOWED_RESOURCES` is an initial deployment allowlist until published MCP Server control-plane discovery is integrated.

## Endpoints / 端点

- Authorization Server Metadata `/.well-known/oauth-authorization-server` (RFC 8414).
- Optional protected registration `POST /oauth/register` (RFC 7591): public DCR is **disabled by default**, requiring Console policy, `OAUTH_DCR_ENABLED=1` and a live rate limiter. It is subject to a global D1 quota; unused anonymous Client records without any dependent request or authorization are reclaimable after seven days. Client registration is not official vendor identity verification.
- `GET /oauth/authorize`: validates exact redirect, mandatory `state`, PKCE S256 and Resource URI; requires an independent authorization rate limiter and an atomic bound of 1000 live pending requests, creates only an expiring **pending** transaction, then redirects to configured Account Consent. Unbound expired requests are cleaned in bounded batches.
- `POST /oauth/requests/:requestId/approve`: internal *Core-trusted* approval only, using a dedicated `OAUTH_CORE_APPROVER_SECRET` and verified user JWT bound to the Account Application. Core verifies current Space `manage` authority before private confirmation; Identity independently checks active User/Application/Agent binding. The conservative Space-manage gate prevents a viewer from selecting an Agent with stronger independent Direct Grants. Do not expose this credential to Account/browser/clients; if the Core confirmation bridge is unavailable, no authorization can become active.
- `GET /api/v1/me/oauth/requests/:requestId` (Identity): Account-authenticated read-only pending request metadata; the unverified Client display name and requested scopes must not be presented as granted capability.
- `POST /api/v1/me/oauth/requests/:requestId/confirm` (Core): Account Application user JWT with `spaces:manage` and current Space `manage`; Core privately confirms through Identity. This step creates no Data Grant or User→Agent Delegation.
- `POST /oauth/token`: retains existing Service `client_credentials` unchanged, adds public-client `authorization_code` + PKCE and rotating `refresh_token`; tokens are opaque, scoped to a single Authorization and Resource URI, never Core JWTs.
- `POST /oauth/introspect`: private resource server authentication via `OAUTH_RESOURCE_SERVER_SECRET`; validates current token, Client, User, Agent binding, Application and Authorization state. Does not substitute for live Core Authority validation.
- `POST /oauth/revoke`: invalidates an access credential or the parent authorization for a refresh credential. Owner-facing authorization management is a later Account API slice.

## Configuration (not included in source control)

- `OAUTH_ISSUER`: fixed public HTTPS issuer; MUST match deployment host.
- `OAUTH_CONSENT_URL`: exact Account consent URL, same environment; required to start a transaction.
- `OAUTH_ACCOUNT_APPLICATION_ID`: the dedicated registered Account application ID, from which confirmed user JWTs must originate.
- `OAUTH_ALLOWED_RESOURCES`: whitespace-separated exact HTTPS MCP Resource identifiers; no broad wildcard.
- `OAUTH_RESOURCE_SERVER_SECRET`: separately provisioned strong introspection caller secret.
- `OAUTH_DCR_ENABLED=1`: deployment/incident switch; Console admission and rate limiting/WAF security still apply before public registration.
- `OAUTH_AUTHORIZE_RATE_LIMITER`: dedicated limiter required for anonymous authorization before resource discovery, with an independent global pending request D1 quota.
- `global_fetch_strictly_public` (Cloudflare Worker compatibility flag): required network boundary for CIMD metadata. It routes every global `fetch()` via the public Internet entry, including Identity's own zone; no private VPC egress binding is permitted for CIMD. Declared in Staging and Production Wrangler configurations, but only deployed in Staging during evaluation; Production rollout remains separately gated. Keep `OAUTH_CIMD_ENABLED=0` until controlled SSRF/DNS-rebinding negative and positive HTTPS metadata tests succeed. Do not infer real network safety solely from a DNS preflight or a successful dry-run build.
- `OAUTH_CORE_APPROVER_SECRET`: a **new and independent** Core→Identity secret for only the private approval bridge, distinct from `CORE_IDENTITY_SHARED_SECRET` and all OAuth client/resource credentials. Provision in both Core and Identity without exposing to Account BFF or browser.

## Required follow-on bridges and acceptance

The candidate now includes a separate Cloudflare Access-backed `apps/account` Consent UI/BFF with Origin, Fetch Metadata, user-bound CSRF and explicit human click. Core exposes a **read-only Native Agent Direct model access upper bound**, restricted by current Application × Model Access, published model access and live Agent Data Grants; Account additionally intersects it with the pending OAuth request scopes. This preview does **not** resolve per-record Model Policy, external model/provider capabilities, published MCP Resource tool-level capabilities or future User Delegation authority. Full user/Agent-use eligibility and MCP Adapter execution are still missing. The conservative Space `manage` gate is temporary. The candidate is **not a completed deployable end-user OAuth system**. Tests must prove redirects cannot be redirected to arbitrary hosts, PKCE downgrade/one-time code replay is denied, refresh rotation/reuse revokes the grant, wrong Client/Resource fails, token revocation is current-state, and legacy Service OAuth is unchanged.

## Current implementation slice (2026-11-04) / 已落地候选

- `apps/core/oauth-consent.openapi.yaml` is an independently versioned candidate companion contract (0.1.0); Core Kernel remains 0.54.0. Current Space manage check is performed on each confirmation, not cached.
- Account only holds a server-side app-scoped user token. Its future BFF must independently verify a real user interaction, CSRF protection, and the Identity Client/Resource metadata before invoking Core.
- Core calls Identity through its existing `IDENTITY` Service Binding, authenticated with `OAUTH_CORE_APPROVER_SECRET`. No Core/Identity database sharing or general Connection registry.
- `apps/account` BFF and Consent UI are now implemented and covered by Node tests; **the actual Account Cloudflare Access Application, LifeSpace Account Application, registered Access Audience and environment Secrets are not provisioned**. No staging or production deployment has occurred.

## Staging readiness / 上线前只读门禁 (2026-11-05)

- Run `node apps/account/scripts/check-staging-readiness.mjs` with **read-only** Cloudflare API credentials and Account ID after the candidate is merged and staged through the existing owner-triggered main-only platform deployment workflow. It checks exact staging Identity/Core versions, existence of the Account staging Worker, Account-specific Access app, and strict per-email Access policies.
- The read-only gate intentionally cannot verify private Identity Access Audience registration or Account/Core/Identity secrets, and therefore cannot mark deployment fully ready without a separately protected operator verification. **A different, owner-only workflow** (`.github/workflows/lifespace-account-staging-deploy.yml`) provisions the Account Staging Access Application, minimal Identity Account Application/Audience and independent Worker Secrets after the canonical main-branch platform staging release. That workflow generates 48-byte random CSRF and OAuth Core approval secrets per run (Staging only), verifies the freshly issued Account `lsa_*`, and revokes superseded keys only after successful installation. Neither workflow bypasses the owner-only release gate; neither deploys Production.
- Actual Account domain `account-staging.aisr.online` must be configured with a **dedicated** Cloudflare Access policy; it must not silently inherit Console Platform Admin authority or use the experimental MCP Preview OAuth policy.

## MCP Resource → LifeSpace Agent Direct read-only execution bridge (candidate / 候选)

This is a **new Identity OAuth path, not the retired Cloudflare Managed OAuth Preview**. Identity owns the OAuth authorization, Account owns the Consent UX, and Core alone authorizes data access. The Account application/Worker code is not a dependency of this trusted execution bridge beyond the existing consent record; parallel AISR Account Center development remains separate.

After `Account → Core consent → Identity Auth Code/PKCE → OAuth Resource Bearer`, the Staging MCP Resource Server must:

1. Privately introspect `lsp_oat_*` against Identity `POST /oauth/introspect` using its dedicated `OAUTH_RESOURCE_SERVER_SECRET`, with the **exact Resource URL**. Reject expired/revoked/mismatched tokens.
2. Obtain a **short-lived (maximum 60 seconds) Agent Direct Core JWT** from Identity `POST /oauth/execution-tokens`, sending the public OAuth bearer only to Identity. Identity rereads the current token, authorization, Application, Agent binding, registered client and Resource before signing. Claims bind `purpose=oauth_agent_execution`, `principal_type=agent`, `actor_type=agent`, `azp` Application, one `oauth_space_id`, the exact `oauth_resource` and `oauth_access_hash`. Its default scope is `resources:read`. In **Staging only**, it also preserves `resources:write` when present in both the Access Token and current Authorization consent. Production continues to issue read-only execution tokens.
3. Call Core only with that signed Agent execution JWT. **The public OAuth bearer is never forwarded to Core; User OAuth consent does not become a User Principal or automatic Delegation.** `allowUserAuthorization` merely means the Agent may request explicit User authorization in a future flow.
4. Core accepts this execution profile only on three read-only surfaces: `GET /api/v1/me/_discovery/inventory`, `GET /api/v1/spaces/{selectedSpaceId}/_discovery/models/{modelKey}`, and `POST /api/v1/spaces/{selectedSpaceId}/models/{modelKey}/records/query`. Core narrows the aggregate inventory to the selected Space, checks the normal current Agent Data Grant and Application Model Access, and must reject all other endpoints. In **Staging only**, write-scoped execution may additionally POST the Native record collection, PATCH one record or DELETE one record, constrained by the current MCP Server exact operation allowlist and normal Model Grant/Policy/concurrency checks. No batch mutation, Action, External mutation, admin endpoint or implicit User Delegation is enabled.
5. Before **every** authorized Core request, Core independently calls the private Identity `POST /introspection/v1/oauth-executions` through its existing internal secret/Service Binding. This checks the current OAuth token hash, authorization, client, Application/Agent binding, Resource and Space. **Revocation takes effect immediately**, including during the remainder of a 60-second execution JWT lifetime. Core must fail closed if its Identity private verifier is unavailable.

All private endpoints are in the Identity Application OpenAPI, **candidate/internal**, using two distinct private boundaries: Resource Server secret for issuance and Core internal secret for live revalidation. No shared D1, new Agent Grant, OAuth Client fallback, platform-admin credential or old Access assertion is added.

**Rollout boundary:** This source/contract candidate cannot be claimed as Staging/Production until the matching Adapters candidate, exact OAuth Resource Allowlist, same-environment bindings/secrets, deploy guard, and real positive/negative E2E are verified. Production configuration remains unchanged. The independently developed AISR Account Center UI is not modified by this candidate.


## Dynamic Core MCP Resource registration (dependent candidate; no deployment)

The accepted MCP Resource is the exact `https://core[-staging].aisr.online/mcp/{mcp_*}` URI, not a guessed domain slug or the former unscoped `/mcp`. `OAUTH_MCP_RESOURCE_ORIGIN` is an exact environment-specific origin. In this mode:

- Identity accepts a properly formed Core-issued `mcp_*` Resource only after **private current-state verification** via the same-environment `CORE` Service Binding and existing `CORE_IDENTITY_SHARED_SECRET`. Core responds to `POST /internal/v1/oauth/mcp-resource/validate` using its own current MCP Server enabled flag and canonical origin; there is no direct cross-worker D1 access.
- OAuth authorization startup **and** final Consent approval both verify the Server is still enabled. Identity token introspection and short-lived Agent execution preserve the exact Resource, while Core's live ingress and per-query Tool Policy block disabled or modified Servers on every invocation.
- Fixed `OAUTH_ALLOWED_RESOURCES` remains available for historical isolated synthetic tests. A canonical dynamic Resource requires Core verification even if also present in that list. An unavailable Core binding/secret or disabled/missing Server fails closed. Do not introduce a wildcard host resource allowlist.
- No new Account D1, generic Connection Registry, Cloudflare Managed OAuth, automatic User Delegation, or production deployment is introduced.

Deployment order is a separate owner-controlled Staging gate: review LifeSpace #480 then dependent #485; release Core with the MCP ingress/private verification route and private Adapter Service Binding **only when** the independently private Adapter Worker exists; then converge Identity's CORE Service Binding and dynamic resource origin; finally run OAuth PKCE/Consent/MCP Staging acceptance. Do not treat passing synthetic CI as a live release.


## MCP Client Admission (schema 18)

The LifeSpace Console `Platform → OAuth 客户端` page has just **CIMD**
and **DCR** enable switches and one optional **Allowed callback URLs** list.
There are no per-method client URL allowlists or admission-mode selectors.

- Enabling CIMD uses guarded public HTTPS metadata discovery, request
  validation, callback pinning, rate limits and an atomic D1 quota.
- Enabling DCR uses validated callback registrations, PKCE, rate limiting
  and an atomic D1 registration quota.
- Leaving Allowed callback URLs empty applies **no extra platform filter**;
  every authorization still verifies the client-specific registered redirect
  exactly. A nonempty list adds an extra platform-wide exact URI restriction
  to CIMD, DCR and manually registered clients. Wildcards are not supported.
- Schema 18 disables any previously enabled *restricted* CIMD/DCR switch
  before retiring its per-method whitelist, avoiding silent widening during
  deployment. The administrator explicitly re-enables the method.
- Account owns user Consent (Application, Space, Agent and scope) and
  revocation. Registering a client never grants access to user data.
- Identity advertises RFC 9207 issuer support and returns the fixed `iss`
  on both approval and user-declined authorization redirects.
- Production remains separately gated and must not be opened without a
  dedicated outbound metadata SSRF/DNS rebinding and abuse assessment.

See [MCP OAuth governance](./mcp-oauth-governance.md).

## Staging Native Agent Direct mutation contract / Staging 原生模型直接写入

Development slice; **not a Production capability**. The Native single-record CRUD
surface requires read + write OAuth consent, selected-Space binding, the same
Model's `query` exposure for discovery and an explicitly enabled `create`, `update`
or `delete` MCP Server operation. Application Model Access, current Agent Grant,
Model write capability, Model Policy and optimistic concurrency remain Core checks.
The consenting User is not the operation Principal: Principal=Actor=Agent.
`allowUserAuthorization=true` alone does not enable represented execution.

Batch semantic discovery optionally includes `detail.mutations` only for current
Staging write-authorized Native Models. It contains `contractId` (`mct_*`),
`modelVersion`, `schemaHash`, `operations` (Create/Update JSON Schema refs, Delete
version schema), and a closed `$defs` dependency subset from the stored immutable
Model Contract. Contracts mismatching the current Model fail closed. The Adapter
must verify identity and consume this schema, never handwrite business fields.
Current Core write access is checked for each returned Model; one active contract
snapshot is read per batch only when at least one write tool is authorized. It is
not re-generated on each request and no per-record database queries are added.

Each Core request introspects live OAuth consent and rejects any execution JWT
scope removed from that ceiling. A legacy read-only introspection response may
validate read but never establishes write. Existing read-only clients are unchanged.
An old Adapter remains query-only; deploy reviewed Identity/Core first, then the
Adapter. Staging release remains an owner-triggered action. Reconnect with explicit
write scope only for actual CRUD acceptance; a read-only connection must not gain
write from a broader Data Grant or Server configuration.

## 2026-11-12 · CIMD native egress closeout (candidate)

Owner approved retaining Cloudflare native strict-public fetch and a fail-closed A/AAAA preflight against special-use addresses. No VPC/private binding, external relay, secret, or vendor-specific allowlist. DNS checks do not pin the actual connection; no full draft conformance claim. Staging owner deployment runs live admission checks when explicitly enabled. Production remains separately gated. See #530 and `docs/mcp-oauth-governance.md`.
