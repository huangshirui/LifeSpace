# Identity Agent Instructions

LifeSpace Identity provides global authentication, SSO/OAuth and credential issuance for all LifeSpace applications.

## Responsibilities

Identity owns:

- Global user identity.
- External identity mappings such as WeChat, Google or email login identities.
- Application/client registration.
- Browser login and SSO flows.
- Authorization Code + PKCE and related OAuth/OIDC-compatible flows as implemented.
- Identity sessions, token issuance, refresh/revocation and signing-key lifecycle.
- App/client identity claims such as `client_id` / `azp` and granted scopes.

Identity must not own:

- Space membership roles as a substitute for authentication.
- Data Grants or domain-level access decisions.
- Events, tasks, health, finance, growth or other life-domain records.

## Security rules

- Unified Identity does not mean a parent-domain shared session cookie.
- Browser Identity sessions use host-only Secure HttpOnly cookies; do not set `Domain=aisr.online`.
- Do not expose refresh tokens, signing keys or provider secrets to browser JavaScript or Mini Program code.
- Tokens must identify the subject and authorized client/application; Core remains responsible for current Space/Data Grant authorization.
- Design revocation and signing-key rotation deliberately; do not make long-lived bearer tokens the only revocation boundary.
- External provider identifiers are Identity concerns and should not leak into Core business records as primary actor IDs.

## Persistence

Identity migrations belong under `apps/identity/migrations`. Identity and Core databases must remain logically isolated even if both use D1.

## Contract

Identity's public protocol/API contract will live in `apps/identity/openapi.yaml` or a more appropriate standards-based specification when implementation begins. Do not invent custom OAuth semantics when a standard flow already fits the requirement.
