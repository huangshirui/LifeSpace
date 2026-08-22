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

Model publication/retirement and Application × Model Access administration are platform administration, not ordinary Space `manage` permissions. Model-admin surfaces are separately scoped with `models:manage` and are service-principal-only unless a later explicit security decision changes that boundary.

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

## Data Grant principles

- Source data keeps exactly one `space_id`.
- Sharing must not duplicate the authoritative record.
- Grants may target a user/principal or another Space when approved.
- Grant resource scope may evolve from collection-level to record/view-level where a concrete requirement exists.
- Permission levels should be explicit. Calendar sharing may need `free_busy` in addition to read/write/manage.
- Revocation must take effect from current Core authorization state; do not encode long-lived mutable Space permissions solely into JWT claims.
- Generic Runtime must evaluate Grants against the resolved model/resource, not merely against an arbitrary URL segment supplied by the client.

## Aggregate access

Authenticated aggregate endpoints under `/api/v1/me/...` may return records from multiple source Spaces when the model/capability explicitly supports aggregation. Each result must preserve source ownership and the caller's effective capabilities so clients can render read-only/shared data correctly.

## Actor safety

- Current actor is derived from verified credentials, never request `userId`.
- For Access-authenticated Web flows, Identity derives the current LifeSpace actor from a verified `(iss, sub)` mapping. A BFF-supplied `sub`, email or `userId` is not sufficient authority by itself.
- Access `aud` determines approved application context, not user identity. It must be checked against the registered LifeSpace application before credentials are issued.
- Account linking is authentication state, not authorization. Linking multiple Access principals to one `usr_*` must not expand that user's Space/Data Grant authority; it only adds another approved way to reach the same global user.
- User-initiated Agent operations preserve delegated user context.
- Service and device identities receive only explicit stable scopes, Application × Model Access and Grants.
- A Service API Token authenticates a service principal and never becomes an implicit Space membership or administrator role.
- A system identity does not become a Space member merely to gain API access.
- AI Model Designer has no implicit data/model administration authority; its output is only a proposal until an authorized publisher validates and publishes it.
