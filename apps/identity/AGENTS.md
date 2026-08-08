# Identity Agent Instructions

LifeSpace Identity provides global LifeSpace user identity, trusted application credentials, platform SSO/session capabilities when explicitly implemented, and short-lived credential issuance for LifeSpace applications.

## Responsibilities

Identity owns:

- Global LifeSpace users (`usr_*`).
- Trusted application/client registration.
- Revocable application credentials for trusted backends/BFFs.
- Short-lived Core token issuance for a LifeSpace user already resolved by a trusted application backend.
- Application/client identity claims such as `client_id` / `azp` and maximum allowed scopes.
- Token revocation and signing-key lifecycle.
- Platform-owned browser login/SSO/session flows only when they are explicitly introduced as LifeSpace platform capabilities.

Identity does not own:

- WeChat Mini Program `openid`, WeCom `userid`, Google account IDs, school-provider IDs, or other application-specific external identity mappings.
- Provider-specific code exchange, app secrets, callbacks, or provider APIs for an application.
- Space membership roles as a substitute for authentication.
- Data Grants or domain-level access decisions.
- Events, tasks, health, finance, growth or other life-domain records.

Application adapters/BFFs own their external-provider mapping, for example:

```text
HomeMew Cloud Function
  trusted WeChat openid
  -> HomeMew identity mapping
  -> LifeSpace usr_xxx
  -> authenticated token exchange with LifeSpace Identity
```

A trusted application may assert a LifeSpace `user_id` only after authenticating to Identity with its own revocable application credential. Identity derives `azp` from that credential; the application must not be allowed to choose another application's identity. Requested scopes must be a subset of the application's registered maximum scopes.

## Security rules

- Unified LifeSpace users do not imply centralized ownership of every application's external login identity.
- Never accept arbitrary user assertions from browser or Mini Program code. User assertion/token exchange endpoints are backend-to-backend interfaces.
- Bootstrap credentials are platform-administration credentials only. Do not reuse the global bootstrap secret as a permanent application credential.
- Store only hashes of application credentials and return a newly generated secret only once.
- Unified Identity does not mean a parent-domain shared session cookie.
- If browser Identity sessions are introduced, use host-only Secure HttpOnly cookies; do not set `Domain=aisr.online`.
- Do not expose refresh tokens, signing keys, application credentials or provider secrets to browser JavaScript or Mini Program code.
- Tokens must identify the subject and authorized client/application; Core remains responsible for current Space/Data Grant authorization.
- Design revocation and signing-key rotation deliberately; do not make long-lived bearer tokens the only revocation boundary.

## Persistence

Identity migrations belong under `apps/identity/migrations`. Identity and Core databases must remain logically isolated even if both use D1.

Do not add a generic `external_identities` table for application-owned provider mappings. If a future LifeSpace-owned SSO provider requires platform credential storage, introduce that capability explicitly with its own contract and threat model.

## Contract

Identity's API contract lives in `apps/identity/openapi.yaml`. Backend-only bootstrap and trusted-application exchange endpoints must be visibly distinguished from user-facing browser protocols.
