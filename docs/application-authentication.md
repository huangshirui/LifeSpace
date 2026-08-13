# Trusted Application Authentication

Status: **Implemented in Identity 0.4.0; staging deployment pending**

Updated: 2026-08-13

## Purpose

Trusted LifeSpace application backends/BFFs authenticate to Identity with an application credential whose plaintext starts with `lsa_`.

This credential is specifically for application-owned backend trust boundaries such as the HomeMew WeChat Cloud Function:

```text
WeChat Mini Program
  -> HomeMew Cloud Function resolves trusted openid
  -> HomeMew mapping resolves openid -> LifeSpace usr_*
  -> Cloud Function authenticates to Identity with lsa_*
  -> POST /internal/v1/tokens
  -> short-lived RS256 app-scoped user token
  -> Mini Program calls LifeSpace Core/Identity
```

The `lsa_*` credential is never exposed to Mini Program code, browser JavaScript, mobile clients, logs, documentation or ordinary user APIs.

It is different from an opaque `lsp_pat_*` Service API Token:

- `lsa_*` authenticates a registered **application backend** to Identity so it may create/resolve users and exchange an already-resolved `usr_*` for a short-lived user token;
- `lsp_pat_*` authenticates a **service principal** directly to Core under current Data Grants.

## Trust boundary

A trusted application may assert a LifeSpace `user_id` only after authenticating with one of its active application credentials. Identity derives the application ID (`azp`) and scope ceiling from current server-side application state.

The client cannot choose another application ID and cannot request scopes outside the application's current `allowedScopes`.

Application-owned provider identifiers such as WeChat `openid` remain outside LifeSpace Identity.

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

## HomeMew Phase 4

HomeMew Phase 4 uses this lifecycle before modifying the Mini Program login path.

The staging `homemew-miniprogram` application must be inspected and, if necessary, updated to the Phase-3 stable scope vocabulary before a new application credential is issued.

Expected user-facing application scopes are limited to the HomeMew product needs, for example:

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

`models:manage` is a service-admin capability and must not be placed into ordinary HomeMew Mini Program user tokens.

Core still intersects the resulting token scopes with current Space membership/Data Grants, Application × Model Access, published model access and model/Capability policy.

## Verification

Identity integration tests must prove:

- application metadata can be inspected without revealing credentials;
- mutable policy changes affect subsequent exchanges through current application state;
- replacement `lsa_*` plaintext is returned once and only its hash is stored;
- metadata listing exposes suffix/status/timestamps but no plaintext/hash;
- old and new credentials both work during the overlap window;
- revoking the old credential makes it fail immediately while the replacement remains valid.
