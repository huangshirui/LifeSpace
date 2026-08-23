# LifeSpace Permission Model

## Core concepts

- **User**: global human LifeSpace identity (`usr_*`) resolved by LifeSpace Identity after an approved authentication path. For owner-controlled Web/PWA applications, Cloudflare Access proves the Web user and Identity resolves the verified Access principal to the global LifeSpace user.
- **Principal**: authenticated actor such as user, delegated Agent, service, device, or application backend.
- **Space**: source ownership and default authorization boundary for business data.
- **Space membership**: role-based relationship between a user and a Space.
- **Data Grant**: permission that exposes a Space, resource collection, approved view, or individual resource to another principal or Space without changing ownership.
- **Credential scope**: stable permission carried by the current credential, such as `resources:read`, `resources:write`, `resources:manage`, or a Kernel-specific scope.
- **Application × Model Access**: Core catalog entry declaring the maximum `read` / `write` / `manage` access one application may exercise for one published model.
- **Model access capability**: `read`, `write`, or `manage` capability declared by the published Model Definition.
- **Model policy**: optional record/input-level restriction evaluated after principal, credential/application and Space/Data Grant authority.
- **Service API Token**: long-lived opaque bearer credential for one trusted service principal and client context; it is individually scoped, optionally expiring, and revocable.

Do not use `Data Grant` to mean OAuth authorization code/grant flow.

## Effective permission

Effective permission for an ordinary model is the intersection of:

1. verified principal identity;
2. the current credential's stable `resources:*` scope required by the operation;
3. the calling application's current Application × Model Access catalog entry;
4. current Space membership / Data Grant authorization;
5. the published model's declared access capability;
6. model policy / Capability-specific restrictions.

In short:

```text
verified principal
∩ stable resources:* credential scope
∩ Application × Model Access
∩ current Space membership/Data Grant
∩ published model access capability
∩ model policy/Capability restrictions
```

No application is trusted merely because of its hostname or product name. Publishing a model does not automatically grant every application or service access to it.

For Access-authenticated Web requests, Cloudflare authentication alone satisfies none of items 2-6. Identity must first validate the Access assertion, resolve `(iss, sub)` to a LifeSpace `usr_*`, bind the Access `aud` to the intended LifeSpace application context and issue/authorize the appropriate LifeSpace credential. Core authorization then proceeds exactly as for the same `usr_*` reached through any other approved authentication path.

## Model authorization

Ordinary metadata-driven models declare `read`, `write`, and optionally `manage` access capabilities. Identity does **not** mint a new token-scope vocabulary for every model.

Stable credential scopes are:

```text
resources:read
resources:write
resources:manage
```

A credential with `resources:write` is still unable to write model `task` unless the calling application's Core catalog entry allows `task` at `write` or higher. Likewise, a catalog entry alone grants nothing when the credential lacks the stable resource scope or the principal lacks current Space/Data Grant authority.

Example:

```text
JWT / Service API Token scopes:
  resources:read resources:write

Application × Model Access:
  homemew-miniprogram × task       -> write
  homemew-miniprogram × wish       -> write
  homemew-miniprogram × day_record -> write
  homemew-miniprogram × event      -> write
```

This split is deliberate. Publishing a new ordinary model does not require an Identity deployment or an update to every application's Identity `allowed_scopes`. The model is unavailable to an application until an authorized Core administrator creates the corresponding Application × Model Access entry.

Runtime route resolution derives the model key and required `read` / `write` / `manage` level from the published definition; it never trusts a client-provided model scope name.

Model publication/retirement and Application × Model Access administration are platform administration, not ordinary Space `manage` permissions. Model-admin surfaces remain service-principal-only. Console-triggered model mutations preserve that service executor and add separately verified human actor evidence; they do not turn the human user into a Model Admin service principal.

## Platform administration

Decision status: **accepted and merged on `main`; the permanent React/Vite Console read-only slice is implemented on PR #47 and remains staging-acceptance-gated before production rollout.**

Platform administration is deliberately separate from Space roles and ordinary business-data authorization. Being a Space `owner` or `admin` does not make a user a LifeSpace platform administrator, and a platform-administration executor is never made a hidden member of every Space.

Cloudflare Access is the Console perimeter/SSO layer, not the final LifeSpace platform-authorization source. LifeSpace Identity owns an explicit `platform_administrators` assignment for eligible global `usr_*` users. Assignment creation/revocation is bootstrap/break-glass administration; routine Console runtime does not hold the bootstrap secret.

A privileged Console operation has two independently verified identities:

```text
human actor
  active global usr_*
  ∩ active platform_administrators assignment
  ∩ dedicated <= 5 minute Identity-signed actor proof
      scope: platform:admin
      purpose: platform_admin_actor
              ∩
controlled executor
  Identity admin: server-only Console lsa_* application credential
  Core admin:     Console service principal / lsp_pat_* or equivalent service JWT
  operation-specific capability
              ∩
same LifeSpace application context (azp / clientId)
              =
platform-admin operation
```

Rules:

- Cloudflare Access controls entry to `lifespace.aisr.online`, but an Access session, IdP email, or Access `sub` is not by itself LifeSpace platform-administration authority.
- Identity first verifies Access, resolves `(iss, sub)` to the global `usr_*`, and establishes the ordinary app-scoped LifeSpace user session.
- A normal LifeSpace user JWT is **not** accepted as platform-admin actor proof, even if a caller attempts to place `platform:admin` in a normal requested scope list.
- `POST /api/v1/me/platform-admin-actor-token` is the dedicated privilege-elevation boundary. Identity checks the current user, current `platform_administrators` assignment, current application status, and the application's permission to request `platform:admin`, then issues a purpose-bound actor proof valid for at most five minutes.
- The actor proof is carried separately as `X-LifeSpace-Actor-Token`. A raw `actorUserId`, email, Access subject, decoded claim, or unsigned operator header is never accepted as operator identity.
- Privileged service endpoints require a separate executor credential held only by the same-origin Console BFF/Worker. Browser JavaScript never receives raw Access assertions, LifeSpace user bearers, actor proofs, `lsa_*`, `lsp_pat_*`, bootstrap secrets, signing keys, or equivalent executor secrets.
- Actor proof and executor must resolve to the same registered LifeSpace application context. A proof issued to another application cannot be paired with a Console executor credential.
- Identity-owned Admin APIs verify the Console `lsa_*`, independently verify the actor proof, and re-check the actor's current `platform_administrators` assignment on every privileged request. Revoking the assignment therefore immediately denies subsequent Identity Admin calls even if an actor proof has not expired.
- Core-owned Admin APIs independently verify the service executor and the Identity-signed purpose-bound actor proof. Core does not duplicate/read Identity's administrator table; its maximum authorization staleness is therefore bounded by the five-minute actor-proof lifetime.
- Platform-admin operations emit audit evidence that distinguishes the human `usr_*` actor from the backend/service executor and never record credential plaintext, hashes, Access assertions, or actor-proof plaintext.
- Console-triggered Model Admin mutations first persist a `pending` audit record before the Registry mutation starts, then transition it to `success` or `failure`. If audit persistence is unavailable before mutation, the mutation does not begin.
- Existing non-interactive service automation using `models:manage` remains supported without a human actor proof. Supplying `X-LifeSpace-Actor-Token` on a mutation opts into the Console human-attribution path and the proof must then validate.
- The global bootstrap secret remains provisioning/break-glass authority. It is not a normal Console runtime credential and must not be stored in the Console Worker/BFF.
- The Console BFF exposes only fixed purpose-specific operations. It validates path identifiers, query allow-lists and result bounds and never accepts a client-controlled upstream URL/path/Authorization header.

Initial control-plane capabilities are explicit and revocable rather than one hidden superuser bypass:

```text
human actor proof:
  platform:admin

executor capabilities:
  applications:manage
  services:manage
  models:manage
  spaces:inspect
  identities:read
  audit:read
```

These scopes do not grant ordinary Generic Runtime business-data authority. In particular, `spaces:inspect` is a dedicated read-only platform Inspector capability; it does not create Space membership or authorize ordinary record mutations.

## Model policy safety

Policy is deny-capable refinement, never a way to expand authority beyond credential/application and current data authorization.

The policy language is closed and deterministic. It may inspect approved context such as `$actor`, `$space`, `$record`, `$input`, `$now`, but must not execute arbitrary JavaScript/SQL or call external services during authorization.

Any policy evaluation error fails closed.

## Service credentials

The deployed service credential model remains authoritative. See `docs/service-authentication.md`.

A service may authenticate either with an opaque `lsp_pat_*` Service API Token or with a short-lived service JWT obtained through OAuth `client_credentials`. OAuth is optional for owner-controlled trusted services.

The credential authenticates a service principal; it does not itself confer Space membership or broad data access. Identity constrains the credential to the application's stable scope ceiling and the service principal's maximum scopes. Core then intersects those scopes with current Application × Model Access, current Data Grants and model rules on every request.

Revoking a Token, disabling its principal, reducing its scopes, reducing/removing Application × Model Access, or revoking a Data Grant removes the corresponding authority on subsequent requests.

Service API Tokens may have `expires_at = null`, but they remain individually revocable and must never be issued to browsers, Mini Programs, downloadable clients, or permanent personal-user identities.

Example:

```text
Service principal: svc_n8n_home
Application context: homemew-external
Token scopes: resources:read resources:write

Application × Model Access:
  event -> write
  task  -> write

Core Data Grants:
  spc_family_xxx   -> write
  spc_personal_xxx -> read
```

The effective result is the intersection. The token cannot use a model absent from its application's catalog, and it cannot access a Space absent from current membership/Data Grant authority.

## Space roles

Initial role vocabulary remains small: `owner`, `admin`, `editor`, `viewer`. Published model policy or sensitive-data Capabilities may further reduce these defaults. Roles are not a substitute for model checks.

Personal Spaces may apply stricter lifecycle rules than family/team Spaces, such as one immutable owner and no ownership transfer, but such rules must be explicit Kernel policy rather than client assumptions.
