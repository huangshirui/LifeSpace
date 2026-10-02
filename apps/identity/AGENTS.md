# Identity Agent Instructions

LifeSpace Identity owns global LifeSpace human identity, registered application trust, Cloudflare Access platform-principal resolution/linking, service principals/credentials, signing/issuance, explicit platform-administrator assignment and Identity-owned platform administration.

## Before changing Identity

Read:

1. root `AGENTS.md`;
2. `apps/AGENTS.md`;
3. `docs/architecture.md`;
4. `docs/permissions.md`;
5. `docs/application-authentication.md`;
6. `docs/service-authentication.md`;
7. `docs/contracts.md`;
8. the relevant Identity OpenAPI contract, migrations, tests and implementation.

## Identity responsibilities

Identity owns:

- global LifeSpace users (`usr_*`);
- stable Agent identities (`agt_*`) and their application binding;
- Core-only short-lived delegated Agent execution-token issuance;
- Cloudflare Access platform-principal mapping `(iss, sub) -> usr_*` for LifeSpace Web/PWA applications;
- Access audience registration `(iss, aud) -> LifeSpace application context`;
- explicit Access new-account registration and existing-account link challenges;
- registered LifeSpace applications and revocable `lsa_*` trusted-backend credentials;
- application scope ceilings and short-lived user-token issuance;
- service principals, opaque `lsp_pat_*` Service API Tokens and optional OAuth `client_credentials`;
- signing-key lifecycle and opaque-token introspection;
- explicit `platform_administrators` assignment state;
- dedicated `purpose=platform_admin_actor` proofs with maximum five-minute lifetime;
- Identity-owned Platform Admin operations and audit evidence.

Identity does not own:

- WeChat `openid`, WeCom IDs, school/provider subjects or other application-specific external identity mappings;
- Google/Microsoft upstream subject IDs or provider refresh tokens merely because those providers are configured in Cloudflare Access;
- a parallel Google/Microsoft/email Web IdP while Access remains the approved Web SSO layer;
- Space memberships or Data Grants;
- ordinary business-domain records;
- Core model authorization.

## External identity boundary

Application-owned identity flow:

```text
application provider authentication
-> owning application resolves provider ID -> usr_*
-> trusted backend authenticates with lsa_*
-> Identity issues app-scoped LifeSpace user token
```

Cloudflare Access flow:

```text
Cloudflare Access
-> raw verified Access JWT presented by same-origin BFF
-> Identity independently verifies issuer/signature/lifetime/sub/aud
-> (iss, sub) -> usr_*
-> registered aud -> calling LifeSpace application
-> app-scoped LifeSpace user token
```

Never accept a naked Access `sub`, email or caller-supplied `userId` as proof of identity.

## Cloudflare Access rules

- Access principal identity key is verified `(iss, sub)`.
- Access `sub` is never a LifeSpace `usr_*`.
- Access `aud` identifies application context, not the human.
- One active `(issuer, audience)` registration belongs to one LifeSpace application.
- Email is non-authoritative metadata and never auto-merges accounts.
- Multiple Access principals may intentionally link to one `usr_*`.
- Unknown Access principals require explicit create-new-account or proof-backed link-existing-account flow.
- Application-specific provider IDs never enter `access_principals`.

## Application credentials

`lsa_*` authenticates a registered trusted application backend to Identity.

Rules:

- server-only;
- plaintext returned exactly once;
- persist only cryptographic hash + non-secret metadata/suffix;
- multiple active credentials may overlap for rotation;
- revocation takes effect immediately on subsequent application authentication;
- never expose in browser/Mini Program/mobile code or logs;
- never confuse with a Core service principal credential.

The global bootstrap secret is provisioning/break-glass authority, not a normal application or Console runtime credential.

## Service credentials

Identity owns service principals plus:

- opaque `lsp_pat_*` tokens for owner-controlled trusted workloads;
- OAuth service client credentials and short-lived service JWT issuance where needed.

Opaque tokens remain individually scoped, optionally expiring and immediately revocable. Plaintext is one-time only. Existing opaque-token scope updates may reduce authority but must not silently expand an already-issued token.

See `docs/service-authentication.md` for normative service rules.

## Platform administration

Cloudflare Access entry is not LifeSpace platform-admin authority.

Identity owns active `platform_administrators` assignments. A user may obtain a dedicated actor proof only when:

- the user is active;
- their current administrator assignment is active;
- the calling LifeSpace application is active and permits `platform:admin`.

The proof must contain:

```text
principal_type = user
scope          = platform:admin
purpose        = platform_admin_actor
azp            = calling Console application
TTL            <= 300 seconds
```

Ordinary LifeSpace user JWTs, raw `actorUserId`, Access `sub`, email or unsigned headers are not substitutes.

Identity-owned privileged Console operations require two independently verified authorities:

```text
Authorization: Bearer <Console lsa_* executor>
X-LifeSpace-Actor-Token: <purpose-bound actor proof>
```

The executor requires the specific capability (`applications:manage`, `services:manage`, `identities:read`, `audit:read`, etc.). Actor `azp` and executor application ID must match. Identity re-checks current platform-administrator assignment on each Identity-owned privileged request.

Agent identity governance is application configuration and therefore uses `applications:manage`. It may create, rename, disable or reactivate a stable `agt_*` identity bound to a target trusted Application, but it must not create Delegation, Space/Data Grant, Model Access or Agent execution tokens as an implicit side effect. Agent `status` is global across all Application bindings and must be presented as such by operator tooling.

Bootstrap administrator assignment/revocation remains initial provisioning and recovery authority only.

## Persistence

Identity migrations belong under `apps/identity/migrations`. Core and Identity databases remain isolated.

Current dedicated platform concepts include:

- `applications` / `application_credentials`;
- `access_audiences` / `access_principals` / `access_link_challenges`;
- service principals and service credentials;
- `platform_administrators`;
- `platform_admin_audit`.

Do not create a generic `external_identities` table for application-owned provider mappings.

## Contract ownership

Normal application/user/service contract:

```text
apps/identity/openapi.yaml
current version: 0.7.0
```

Privileged LifeSpace Console control-plane contract:

```text
apps/identity/platform-admin.openapi.yaml
current version: 0.2.0
```

Do not place a Console-only privileged endpoint into the product-facing Identity OpenAPI merely because both are implemented by the same Worker. Conversely, do not implement a privileged route without adding it to the Platform Admin companion contract and its contract checks.

## Audit and secrets

Platform-admin audit must distinguish human actor from backend executor and may record bounded non-secret metadata, operation, target, request ID, result and timestamps.

Never audit or return stored:

- `lsa_*` plaintext;
- `lsp_pat_*` plaintext;
- OAuth client secret plaintext;
- credential hashes;
- Authorization headers.

## Verification

An Identity change is incomplete until:

- both applicable OpenAPI contract checks pass;
- migrations and schema version are aligned;
- positive and deny-path security tests cover the changed boundary;
- typecheck and dry-run Worker build pass;
- Access identity changes cover issuer/signature/lifetime/audience/linking races;
- platform-admin changes cover missing/wrong-purpose/mismatched actor proof, executor scope and administrator revocation semantics;
- downstream application-contract impact is explicitly assessed.
