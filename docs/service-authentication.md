# Service and Automation Authentication

- Decision status: **Accepted**
- Runtime status: **Implemented and verified in staging on 2026-08-11; production not yet cut over**
- Decision date: 2026-08-10
- Applies to: n8n, curl/scripts, MCP servers, Agents, application backends, scheduled jobs, and other trusted server-side integrations

## Decision

LifeSpace supports two service-authentication modes. OAuth 2.0 `client_credentials` is not the only supported mode.

1. A long-lived, opaque, revocable **Service API Token** for trusted server-side environments controlled by the LifeSpace owner.
2. OAuth 2.0 `client_credentials` that exchanges a client secret for a short-lived access token when automatic short-lived rotation, third-party integration, or an enterprise security policy requires it.

Both authenticate a service principal and ultimately use the same Core authorization model:

```text
verified service principal
  ∩ token/client scopes
  ∩ current Space/Data Grants
  ∩ domain restrictions
```

Core API requests use the standard bearer header in both cases:

```http
Authorization: Bearer <credential>
```

A Service API Token is sent directly as `lsp_pat_...`. OAuth obtains a short-lived bearer JWT first. The use of an HTTP bearer header does not imply that OAuth is required.

## Why

Self-hosted n8n, private scripts, scheduled jobs, and similar services already run in a trusted server environment and can safely store a narrowly scoped secret. Forcing every such caller through a token-exchange flow would add credential-refresh configuration without materially improving the security boundary for this use case.

A fixed token does not mean an ungoverned secret. LifeSpace Service API Tokens remain:

- bound to one service principal and one registered client/application context;
- limited by explicit scopes;
- limited to current Core Data Grants;
- individually named, auditable, rotatable, and immediately revocable;
- optionally expiring, while allowing `expires_at = null` for owner-controlled services that need a non-expiring token;
- prohibited in browsers, Mini Programs, public clients, and distributable client code.

OAuth `client_credentials` remains valuable for third-party or policy-controlled integrations. It is an additional choice, not a mandatory indirection for every trusted service.

## Credential selection

| Caller | Credential | Default |
|---|---|---|
| Browser or Web App frontend | Short-lived user access token or same-origin BFF session | Required; never expose a Service API Token |
| WeChat Mini Program | Short-lived app-scoped user access token | Required |
| Self-hosted n8n | Opaque Service API Token | Recommended |
| Owner-controlled curl/script/cron | Opaque Service API Token | Recommended |
| Owner-controlled MCP server or Agent backend | Opaque Service API Token, unless delegated user authority is required | Recommended |
| Third-party backend integration | OAuth `client_credentials` | Recommended |
| User-delegated Agent action | Short-lived delegated user credential | Required; do not replace the user with a permanent service administrator |
| Household display/device | Device-specific, narrowly scoped credential | Separate device policy; do not reuse a user or general service token |

## Service API Token format and storage

The plaintext format is:

```text
lsp_pat_<cryptographically-random-secret>
```

Implementation requirements:

- Generate at least 256 bits of cryptographically secure random secret material.
- Store only a versioned cryptographic hash of the complete token in Identity D1. Never store or log plaintext.
- Return plaintext exactly once at creation.
- Persist a non-secret lookup prefix/fingerprint and final characters for operator identification.
- Redact `Authorization`, token values, hashes, and credential-bearing payloads from logs and errors.
- Allow `expires_at` to be either a timestamp or `null`.
- Support immediate revocation, principal disablement, token rotation, and per-token scope reduction.
- Record creation, creator/owner, revocation, and last-used metadata without making last-used writes a correctness dependency.
- Use distinct tokens for staging and production, and normally one token per service/workload.

A Service API Token is opaque. It must not be a long-lived JWT, because mutable status, scope reduction, and revocation must be checked against current server state.

## Ownership and runtime verification

Identity owns service principals and service credentials. Core owns Space/Data Grants and domain authorization.

Implemented request path:

```text
n8n / script
  -> one Core HTTP request with Bearer lsp_pat_...
  -> Core recognizes the opaque token prefix
  -> Core calls Identity introspection through an internal Service Binding
  -> Identity verifies the token hash and current credential/principal status
  -> Core evaluates current scope, Space/Data Grant, and domain rules
```

From n8n or curl this remains one business HTTP request. The implementation adds one internal Core-to-Identity verification call and does not require an n8n “get token” node.

Short-lived JWTs continue to be verified locally by Core with Identity's public key. Core authentication therefore has two explicit adapters that produce one normalized principal context:

- RS256 JWT verifier;
- opaque Service API Token introspection.

Core does not have direct access to Identity D1 and does not duplicate credential hashes. Positive introspection caching is not part of the initial implementation; current-state verification is used so token/principal revocation takes effect on the next request.

## Principal, client, scope, and Grant semantics

A service principal is not a Space member merely because it can call the API.

Each Service API Token resolves to:

- `principal_id` with principal type `service`;
- bound application/client context;
- Core audience;
- granted scopes;
- current token and principal status;
- optional expiry.

Identity issues credentials only within the registered application's and service principal's maximum scope ceilings. Core still evaluates current Data Grants. A token does not embed a fixed `space_id` as its authorization rule.

Example:

```text
Service principal: svc_n8n_home
Client: n8n-home
Token scopes: events:read events:write tasks:read tasks:write

Core Data Grants:
  spc_family_xxx: events read/write, tasks read/write
  spc_personal_xxx: events read only
```

Possessing the token does not grant access to any other Space.

## Implemented Identity contract

Canonical syntax is owned by `apps/identity/openapi.yaml` (Identity 0.3.0 / schema v4). Implemented capabilities include:

- create/list/update/disable/re-enable a service principal;
- create a Service API Token and return plaintext once;
- list token metadata without returning plaintext or hashes;
- update token label/expiry and reduce token scopes;
- revoke a token;
- rotate by creating a replacement and then revoking the old token;
- internally introspect a Service API Token for Core;
- create/list/revoke OAuth client credentials;
- issue short-lived service JWTs through OAuth `client_credentials`.

Implemented route shapes include:

```text
GET    /api/v1/service-principals
POST   /api/v1/service-principals
PATCH  /api/v1/service-principals/{principalId}
GET    /api/v1/service-principals/{principalId}/tokens
POST   /api/v1/service-principals/{principalId}/tokens
PATCH  /api/v1/service-principals/{principalId}/tokens/{tokenId}
DELETE /api/v1/service-principals/{principalId}/tokens/{tokenId}
GET    /api/v1/service-principals/{principalId}/oauth-credentials
POST   /api/v1/service-principals/{principalId}/oauth-credentials
DELETE /api/v1/service-principals/{principalId}/oauth-credentials/{credentialId}
POST   /introspection/v1/service-tokens
POST   /oauth/token
```

Identity-owned persistence is defined by migration `0004_service_authentication.sql`:

```text
service_principals
- id
- application_id
- display_name / description
- max_scopes
- status
- created_by_user_id
- created_at / updated_at / disabled_at

service_api_tokens
- id
- principal_id
- token_hash_version / token_hash
- display_prefix / last_four
- label
- scopes
- audience
- expires_at nullable
- created_at / created_by_user_id
- last_used_at
- revoked_at / revoked_by_user_id

service_oauth_credentials
- id
- principal_id
- secret_hash / secret_suffix
- label / status
- created_at / created_by_user_id
- last_used_at
- revoked_at / revoked_by_user_id
```

Core Data Grants reference the stable service `principal_id`; they do not reference a particular token.

## Core Data Grant management

Core 0.10.0 exposes native Space-level Data Grant management for authorized user principals:

```text
GET    /api/v1/spaces/{spaceId}/grants
POST   /api/v1/spaces/{spaceId}/grants
PATCH  /api/v1/spaces/{spaceId}/grants/{grantId}
DELETE /api/v1/spaces/{spaceId}/grants/{grantId}
```

A service principal gains no Space access merely by existing or possessing a valid credential. The current Data Grant and credential/application scopes are evaluated on every request. Revoking the Grant removes the service's Space authority on the next request for both opaque and OAuth credential modes.

## n8n configuration

For an owner-controlled n8n instance, create one Header Auth credential:

```text
Credential Type: Header Auth
Name: Authorization
Value: Bearer lsp_pat_xxxxxxxxx
```

Then call Core directly:

```text
https://core.aisr.online/api/v1/spaces/{spaceId}/events
```

There is no token acquisition node and no refresh workflow.

If OAuth `client_credentials` is deliberately selected, configure n8n's OAuth2 credential with the Identity token endpoint, client ID, client secret, and requested scopes. n8n should cache and refresh the short-lived access token; workflows must not manually fetch a new token before every Core call.

## curl and scripts

Use an environment variable or secret store rather than placing the credential directly in shell history:

```bash
curl "https://core.aisr.online/api/v1/spaces/spc_xxx/events" \
  -H "Authorization: Bearer ${LIFESPACE_TOKEN}"
```

The same direct-token pattern is appropriate for private scripts and scheduled jobs. Never commit the token to a repository, workflow export, Docker image, or documentation.

## HomeMew migration

HomeMew `hmw_pat_*` secrets are not copied or reinterpreted as LifeSpace credentials.

For every active HomeMew integration:

1. Create or resolve a LifeSpace service principal and registered application context.
2. Translate HomeMew integration permissions into LifeSpace scopes.
3. Translate the integration's family binding into explicit Grants on the mapped family Space.
4. Generate a new `lsp_pat_*` token or OAuth client credential according to the caller's selected mode.
5. Update n8n/script/MCP configuration.
6. Verify allow and deny behavior against LifeSpace staging.
7. Revoke the HomeMew credential after cutover and the agreed rollback window.

Migration tooling now emits deterministic service-principal/Data Grant output plus a credential-rotation report. Legacy credential plaintext and hashes are never copied into LifeSpace.

## Implemented scope

1. [x] Identity service-principal and Service API Token schema/migrations.
2. [x] Management, revocation, rotation-by-replacement, and internal introspection contracts.
3. [x] Optional OAuth `client_credentials` service-token issuance.
4. [x] Core normalized dual authentication adapters.
5. [x] Service principals connected to current Core Data Grant evaluation.
6. [x] Current-state revocation and non-secret credential metadata handling.
7. [x] HomeMew integration transform/report logic with credential rotation.
8. [x] n8n/curl usage documented in this normative runbook.
9. [x] Canonical Core/Identity contracts and generated Wrangler binding synchronized.

## Acceptance verification

Automated tests and the 2026-08-11 staging smoke verify:

- valid `lsp_pat_*` authenticates as the expected service principal;
- plaintext is returned once and neither plaintext nor hash appears in list APIs;
- malformed/unknown/revoked tokens, disabled principals, invalid client credentials and scope violations fail;
- token scopes cannot exceed application/principal ceilings and existing token scopes do not auto-expand;
- insufficient token scope fails even when a Data Grant exists;
- missing/revoked Data Grant fails even when the token has scope;
- one Space Grant does not allow access to another Space;
- token replacement can overlap until the old token is explicitly revoked;
- RS256 user/service JWT behavior remains intact;
- n8n/curl semantics remain one client-visible Core HTTP request;
- OAuth `client_credentials` reaches Core through the same service principal/Data Grant authorization model;
- Data Grant revocation denies both opaque and OAuth service credentials on the next Core request;
- opaque token revocation returns authentication failure on the next Core request.

Production/staging credential isolation remains a deployment invariant; production credentials are not created or exercised by staging verification.

## Non-goals

- Permanent personal-user API tokens.
- Service API Tokens in browsers, Mini Programs, mobile apps, or downloadable clients.
- Long-lived JWTs presented as revocable opaque tokens.
- Treating a service principal as a hidden Space administrator.
- Encoding all mutable Space authorization in credential claims.
- Reusing one token across unrelated workloads or environments.
