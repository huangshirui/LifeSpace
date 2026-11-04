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

The Core trusted approval bridge is implemented as a candidate, but **Account Consent UI/BFF, explicit user-click/CSRF controls, fine-grained Agent use eligibility, model operation capability projection, and MCP Adapter execution are still missing**. The conservative Space `manage` gate is not an Agent permission substitute. Do not deploy this draft as a complete end-user OAuth system. Do not deploy this as a completed end-user sign-in system. Tests must prove redirects cannot be redirected to arbitrary hosts, PKCE downgrade/one-time code replay is denied, refresh rotation/reuse revokes the grant, wrong Client/Resource fails, token revocation is current-state, and legacy Service OAuth is unchanged.

## Current implementation slice (2026-11-04) / 已落地候选

- `apps/core/oauth-consent.openapi.yaml` is an independently versioned candidate companion contract (0.1.0); Core Kernel remains 0.54.0. Current Space manage check is performed on each confirmation, not cached.
- Account only holds a server-side app-scoped user token. Its future BFF must independently verify a real user interaction, CSRF protection, and the Identity Client/Resource metadata before invoking Core.
- Core calls Identity through its existing `IDENTITY` Service Binding, authenticated with `OAUTH_CORE_APPROVER_SECRET`. No Core/Identity database sharing or general Connection registry.
- Until Account BFF exists and has its own Access application and `OAUTH_ACCOUNT_APPLICATION_ID`, no end-user confirmation UI is available. No production secrets or deployments were changed.
