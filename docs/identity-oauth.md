# Identity Interactive OAuth Authorization Server / 交互式 OAuth 授权服务

Status: **candidate on independent feature branch; not deployed**. This is Identity's protocol and credential work, not a general `conn_*` registry and not a replacement for Core Authority.

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
- Optional protected registration `POST /oauth/register` (RFC 7591): public DCR is **disabled by default**, requiring `OAUTH_DCR_ENABLED=1` (staging/non-production only). Client registration is not official vendor identity verification.
- `GET /oauth/authorize`: validates exact redirect, mandatory `state`, PKCE S256 and Resource URI; creates only an expiring **pending** transaction and redirects to configured Account Consent.
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
- `OAUTH_DCR_ENABLED=1`: non-production only, optional compatibility switch; rate limiting/WAF required before public registration.
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
2. Obtain a **short-lived (maximum 60 seconds) Agent Direct Core JWT** from Identity `POST /oauth/execution-tokens`, sending the public OAuth bearer only to Identity. Identity rereads the current token, authorization, Application, Agent binding, registered client and Resource before signing. Claims bind `purpose=oauth_agent_execution`, `principal_type=agent`, `actor_type=agent`, `azp` Application, one `oauth_space_id`, the exact `oauth_resource` and `oauth_access_hash`. Its scope is **only** `resources:read`.
3. Call Core only with that signed Agent execution JWT. **The public OAuth bearer is never forwarded to Core; User OAuth consent does not become a User Principal or automatic Delegation.** `allowUserAuthorization` merely means the Agent may request explicit User authorization in a future flow.
4. Core accepts this execution profile only on three read-only surfaces: `GET /api/v1/me/_discovery/inventory`, `GET /api/v1/spaces/{selectedSpaceId}/_discovery/models/{modelKey}`, and `POST /api/v1/spaces/{selectedSpaceId}/models/{modelKey}/records/query`. Core narrows the aggregate inventory to the selected Space, checks the normal current Agent Data Grant and Application Model Access, and must reject all other endpoints/mutations.
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


## MCP Client Admission (schema 17)

Current design: see [MCP OAuth governance](./mcp-oauth-governance.md).

- **Protocol registration is not a User Authorization.** CIMD and DCR are
  registered at Identity; they do not grant `resources:*`, select a Space,
  create Delegation, or bypass Core's live MCP Server/Grant checks.
- LifeSpace Console **Platform → OAuth 客户端** owns per-method enable switches,
  `open` vs `restricted` admission, and the **optional** global exact callback
  restriction. Existing strict lists stay in Identity D1. No user-specific
  callback must be entered by a platform admin in `open` mode.
- CIMD `open` is Staging-only behind the environment kill switch and admission
  rate limiter. Metadata fetching is limited to strictly parsed public HTTPS
  Client ID URLs (5-second timeout, 8-KiB limit, no redirect), exact
  `client_id`, validated client metadata and redirect list. The first
  registration pins callbacks; later drift fails closed. The atomic D1 quota
  limits client registrations. Open CIMD remains **not approved for Production**
  until DNS rebinding/SSRF and abuse review.
- DCR `open` registers new clients only after redirect URI validation, DCR
  per-location rate limiting, atomic client quota, and strict public PKCE
  requirements. Production DCR is disabled independently. Existing clients
  are still bound to the precise registered callback on authorization and
  token exchange.
- **Shared callback policy** applies equally to pre-registered, CIMD and DCR
  clients. Default `client` means only the specific Client's registered
  exact redirects are accepted; optional `restricted` imposes a second,
  platform-wide exact URL list. Wildcards are not supported. Native localhost
  loopback callbacks remain available, as defined by registration rules.
- Identity advertises RFC 9207
  `authorization_response_iss_parameter_supported: true`. Both successful
  and user-rejected Account Consent callbacks carry `iss` exactly equal to
  the configured issuer, with the original `state`; invalid/unknown
  callbacks are never reflected back in OAuth redirects.
- Account lets the user choose Application, Space, Agent, execution mode and
  scopes. Account Connect/Grant management remains separate from Console's
  global admission controls. Removing an admission entry alone does not
  revoke previously issued User Authorizations.
