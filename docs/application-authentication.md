# Trusted Application Authentication

Status: **Implemented in Identity 0.4.0; staging deployment pending**

Updated: 2026-08-13

## Purpose

Trusted LifeSpace application backends/BFFs authenticate to Identity with an application credential whose plaintext starts with `lsa_`.

This credential is a generic platform mechanism for an application-owned trusted backend that has already resolved its own external identity mapping.

Example target flow:

```text
Mini Program / application client
  -> application-owned backend resolves provider identity
  -> application mapping resolves provider identity -> LifeSpace usr_*
  -> trusted backend authenticates to Identity with lsa_*
  -> POST /internal/v1/tokens
  -> short-lived RS256 app-scoped user token
  -> untrusted client or approved BFF path calls LifeSpace Core/Identity
```

For HomeMew, the target application-owned backend is a redesigned Cloudflare backend. The existing WeChat Cloud Function is **not** adapted as a temporary LifeSpace bridge.

The `lsa_*` credential is never exposed to Mini Program code, browser JavaScript, mobile clients, logs, documentation or ordinary user APIs.

It is different from an opaque `lsp_pat_*` Service API Token:

- `lsa_*` authenticates a registered **application backend** to Identity so it may create/resolve users and exchange an already-resolved `usr_*` for a short-lived user token;
- `lsp_pat_*` authenticates a **service principal** directly to Core under current Data Grants.

## Trust boundary

A trusted application may assert a LifeSpace `user_id` only after authenticating with one of its active application credentials. Identity derives the application ID (`azp`) and scope ceiling from current server-side application state.

The client cannot choose another application ID and cannot request scopes outside the application's current `allowedScopes`.

Application-owned provider identifiers such as WeChat `openid` remain outside LifeSpace Identity.

A same-account Cloudflare Service Binding may be selected as transport between an application Worker and a LifeSpace Worker where appropriate, but transport topology is not itself application authorization. Any future Service-Binding-specific trust mechanism must preserve explicit application identity, scope ceilings and revocation semantics rather than relying on hostname or network location.

## Credential storage

Application credentials use the existing Identity D1 `application_credentials` table.

Requirements:

- plaintext format starts with `lsa_` and contains cryptographically random secret material;
- only SHA-256 hash and a non-secret suffix are persisted;
- plaintext is returned exactly once at credential creation;
- metadata APIs never return plaintext or hashes;
- multiple active credentials may overlap temporarily for zero-downtime deployment rotation;
- revocation is immediate for subsequent `/internal/*` authentication;
- credentials are environment-specific and must not be reused between staging and production.

## Platform-admin application lifecycle

Identity 0.4.0 exposes the following bootstrap-admin routes protected by `x-bootstrap-secret`:

```text
GET    /bootstrap/v1/applications/{applicationId}
PATCH  /bootstrap/v1/applications/{applicationId}
GET    /bootstrap/v1/applications/{applicationId}/credentials
POST   /bootstrap/v1/applications/{applicationId}/credentials
DELETE /bootstrap/v1/applications/{applicationId}/credentials/{credentialId}
```

The global bootstrap secret is a platform-administration credential only. It is not an application runtime credential and must never be copied into HomeMew/ALOHA application configuration.

Mutable application policy through the PATCH route is intentionally bounded to:

- display name;
- `allowedScopes` ceiling;
- user access-token TTL (300-3600 seconds);
- active/disabled status.

`clientType` and `trustedBackend` classification are not mutable through this endpoint.

## Rotation runbook

Application credential rotation uses overlap, never in-place secret replacement:

```text
1. Inspect current application metadata and credential suffixes.
2. POST a replacement credential.
3. Store the returned lsa_* immediately in the target backend secret store.
4. Deploy/restart the backend with the new credential.
5. Verify user creation/token exchange and Core authorization.
6. DELETE the old credential.
7. Verify the old credential now receives 401 and the new credential still works.
```

Do not revoke the old credential before the replacement backend deployment has been verified.

If a credential plaintext is lost before it is installed, create another replacement. Plaintext is never recoverable from Identity.

## HomeMew Integration Readiness

Identity 0.4.0 credential lifecycle is retained as a **generic LifeSpace platform capability**. It is not an instruction to retrofit the old HomeMew Mini Program login Cloud Function.

Before the `HomeMew Integration Ready` milestone, LifeSpace must decide and document the final trusted-backend path for the redesigned HomeMew Cloudflare backend, including whether it uses `lsa_*` directly over HTTP/service binding transport or a later explicitly approved same-account mechanism with equivalent identity, scope and revocation guarantees.

The final HomeMew application policy must define only product-needed user-facing scopes, for example:

```text
profile:read
profile:write
spaces:read
spaces:write
spaces:manage
resources:read
resources:write
creation-drafts:read
creation-drafts:write
```

`models:manage` is a service-admin capability and must not be placed into ordinary HomeMew user tokens.

Core still intersects the resulting token scopes with current Space membership/Data Grants, Application × Model Access, published model access and model/Capability policy.

The exact HomeMew application credential and contract configuration is frozen at the `HomeMew Integration Ready` milestone, not during intermediate platform proving work.

## Verification

Identity integration tests must prove:

- application metadata can be inspected without revealing credentials;
- mutable policy changes affect subsequent exchanges through current application state;
- replacement `lsa_*` plaintext is returned once and only its hash is stored;
- metadata listing exposes suffix/status/timestamps but no plaintext/hash;
- old and new credentials both work during the overlap window;
- revoking the old credential makes it fail immediately while the replacement remains valid.
