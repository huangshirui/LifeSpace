# Identity Agent Instructions

LifeSpace Identity provides global LifeSpace user identity, trusted application credentials, service principals and opaque Service API Tokens, Cloudflare Access platform-principal resolution/linking for LifeSpace Web applications, and short-lived credential issuance for LifeSpace applications.

## Responsibilities

Identity owns:

- Global LifeSpace users (`usr_*`).
- Cloudflare Access platform-principal resolution for owner-controlled LifeSpace Web/PWA applications using Access as the shared long-term authentication/SSO layer.
- Linking one or more verified Access principals `(iss, sub)` to one global `usr_*`.
- Independent validation of Cloudflare Access assertions used for LifeSpace principal resolution, including issuer/signature/expiry and registered application audience checks.
- Trusted application/client registration.
- Revocable application credentials for trusted backends/BFFs.
- Service principals and opaque, individually scoped, optionally expiring, revocable Service API Tokens for owner-controlled trusted services.
- Short-lived Core token issuance for a LifeSpace user already resolved by a trusted application backend.
- Short-lived app-scoped user credential issuance after a verified Access principal has been resolved to a LifeSpace user through the approved Access contract.
- Optional OAuth `client_credentials` issuance of short-lived service tokens for third-party or policy-controlled integrations.
- Application/client identity claims such as `client_id` / `azp`, registered Cloudflare Access audience values for Web applications, and maximum allowed scopes.
- Token revocation and signing-key lifecycle.

Identity does not own:

- WeChat Mini Program `openid`, WeCom `userid`, school-provider IDs, or other application-specific external identity mappings.
- Google/Microsoft upstream provider account IDs, OAuth refresh tokens or provider secrets merely because those providers are configured behind Cloudflare Access. Identity consumes the verified Access principal, not the upstream IdP identity.
- Provider-specific code exchange, app secrets, callbacks, or provider APIs for an application-specific login/integration.
- A parallel Google/Microsoft/email browser IdP or SSO system while Cloudflare Access remains the approved long-term Web authentication layer.
- Space membership roles as a substitute for authentication.
- Data Grants or domain-level access decisions.
- Events, tasks, health, finance, growth or other life-domain records.

Application adapters/BFFs still own application-specific external-provider mapping, for example:

```text
HomeMew Cloudflare backend
  trusted WeChat openid
  -> HomeMew identity mapping
  -> LifeSpace usr_xxx
  -> authenticated token exchange with LifeSpace Identity
```

For Web Access authentication the boundary is different:

```text
Cloudflare Access
  -> verified Access JWT
  -> HomeMew / ALOHA same-origin BFF
  -> approved Identity Access contract
  -> Identity verifies JWT and resolves (iss, sub) -> usr_xxx
```

The BFF must not supply a naked Access `sub`, email or arbitrary `user_id` and ask Identity to trust it. Identity must derive the Access principal from a verifiable assertion.

A trusted application may assert a LifeSpace `user_id` only after authenticating to Identity with its own revocable application credential. Identity derives `azp` from that credential; the application must not be allowed to choose another application's identity. Requested scopes must be a subset of the application's registered maximum scopes.

For Access-based Web exchange, the calling application credential and the Access assertion's registered audience must agree before Identity can issue that application's user credential.

## Security rules

- Unified LifeSpace users do not imply centralized ownership of every application's external login identity.
- Cloudflare Access is the deliberate platform-level Web-authentication exception: Identity owns Access-principal -> `usr_*` resolution because the same Access identity must resolve consistently across HomeMew Web, ALOHA Web and future LifeSpace Web applications.
- Access principal identity is keyed by verified `(iss, sub)`. Access `sub` is never a LifeSpace `user_id`.
- Access `email` is non-authoritative metadata. Never merge two LifeSpace accounts merely because email claims match.
- Access `aud` identifies the protected Web application context, not the user. Bind/allowlist Access audiences to LifeSpace applications and never include `aud` in the Access user-identity key.
- Multiple Access principals may link to the same LifeSpace user. `user_id` must not be unique in Access-principal persistence.
- An unknown Access principal must not silently create a new LifeSpace user. It must enter an explicit link-existing-account or create-new-account flow.
- Linking a new Access principal to an existing user requires proof of control of that LifeSpace user. A Mini Program may confirm a one-time challenge using its current LifeSpace bearer token; Identity must derive the user from that token and must not learn the application's `openid`.
- Never accept arbitrary user assertions from browser or Mini Program code. User assertion/token exchange endpoints are backend-to-backend interfaces except explicitly authenticated `/api/v1/me/...` confirmation flows whose actor comes from a LifeSpace bearer token.
- Bootstrap credentials are platform-administration credentials only. Do not reuse the global bootstrap secret as a permanent application credential.
- Store only hashes of application credentials and Service API Tokens, and return a newly generated secret only once.
- Unified Identity does not mean a parent-domain shared session cookie.
- Individual applications may use host-only Secure HttpOnly App Session cookies; do not set `Domain=aisr.online`.
- Do not expose refresh tokens, signing keys, application credentials or provider secrets to browser JavaScript or Mini Program code.
- Tokens must identify the subject and authorized client/application; Core remains responsible for current Space/Data Grant authorization.
- Opaque Service API Tokens may use `expires_at = null` only for trusted server-side workloads. They must remain individually identifiable, immediately revocable, scope-limited, and prohibited in browsers, Mini Programs, distributable clients, and personal-user identities.
- A Service API Token must not be a long-lived JWT. Current token/principal state is verified by Identity introspection as defined in `docs/service-authentication.md`.
- Design revocation, rotation, redaction, Cloudflare signing-key/JWKS refresh behavior, Access-principal linking races and LifeSpace signing-key lifecycle deliberately.

## Persistence

Identity migrations belong under `apps/identity/migrations`. Identity and Core databases must remain logically isolated even if both use D1.

Do not add a generic `external_identities` table for application-owned provider mappings.

The approved Cloudflare Access integration uses a dedicated Identity-owned `access_principals` concept for platform Web authentication only. Its required logical invariants are:

```text
UNIQUE (issuer, subject)
INDEX  (user_id)
```

`user_id` is intentionally many-to-one from Access principals. Application-owned provider IDs must never be inserted into this table.

Any future persistence for Access audiences must bind each accepted Cloudflare Access `aud` to the intended LifeSpace application/environment so one BFF cannot exchange another application's assertion for authority.

## Contract

Identity's deployed API contract lives in `apps/identity/openapi.yaml`.

Backend-only bootstrap, trusted-application exchange, service-token management/introspection, optional OAuth service endpoints and future Access-principal exchange/linking endpoints must be visibly distinguished from user-facing protocols.

The planned Cloudflare Access contract is documented in `docs/application-authentication.md`. Do not add those planned endpoints to the deployed OpenAPI or claim them as implemented until persistence, JWT verification, runtime behavior, security tests and version bump land together.
