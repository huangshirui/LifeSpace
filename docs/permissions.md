# LifeSpace Permission Model

## Core concepts

- **User**: global human identity authenticated by LifeSpace Identity.
- **Principal**: authenticated actor such as user, delegated Agent, service, device, or application backend.
- **Space**: source ownership and default authorization boundary for business data.
- **Space membership**: role-based relationship between a user and a Space.
- **Data Grant**: permission that exposes a Space, resource collection, approved view, or individual resource to another principal or Space without changing ownership.
- **Application scope**: permission granted to the calling application/client.
- **Model access capability**: published model permission such as read/write/manage that maps into the platform scope catalog.
- **Model policy**: optional record/input-level restriction evaluated after principal, credential/application and Space/Data Grant authority.
- **Service API Token**: long-lived opaque bearer credential for one trusted service principal and client context; it is individually scoped, optionally expiring, and revocable.

Do not use `Data Grant` to mean OAuth authorization code/grant flow.

## Effective permission

Effective permission is the intersection of:

1. verified principal identity;
2. current Space membership / Data Grant authorization;
3. credential authority constrained by the calling application's allowed scopes/model access;
4. the published model's access requirement;
5. model policy / Capability-specific restrictions.

No application is trusted merely because of its hostname or product name. Publishing a model does not automatically grant every application or service access to it.

## Model authorization

Ordinary metadata-driven models declare access capabilities instead of registering ad-hoc authorization code.

Typical v1 capabilities:

```text
<model>:read
<model>:write
<model>:manage
```

The Model Scope Catalog is the authoritative mapping from published model capability to application/credential eligibility. Runtime route resolution must derive required scope/access from the published definition; it must not trust a client-provided scope name.

A dynamically published model must therefore pass both:

```text
credential/application may call this model capability
AND
principal currently has data authority over the source Space/record
```

Model publication/retirement is platform administration, not an ordinary Space `manage` permission. The model-admin surface must be separately scoped and initially service-only.

## Model policy safety

Policy is deny-capable refinement, never a way to expand authority beyond credential/application and current data authorization.

The policy language is closed and deterministic. It may inspect approved context such as `$actor`, `$space`, `$record`, `$input`, `$now`, but must not execute arbitrary JavaScript/SQL or call external services during authorization.

Any policy evaluation error fails closed.

## Service credentials

The deployed service credential model remains authoritative. See `docs/service-authentication.md`.

A service may authenticate either with an opaque `lsp_pat_*` Service API Token or with a short-lived service JWT obtained through OAuth `client_credentials`. OAuth is optional for owner-controlled trusted services.

The credential authenticates a service principal; it does not itself confer Space membership or broad data access. Core intersects current token/client scopes with current Grants and model rules on every request. Revoking a Token, disabling its principal, reducing its scopes/model access, or revoking a Data Grant removes the corresponding authority on subsequent requests.

Service API Tokens may have `expires_at = null`, but they remain individually revocable and must never be issued to browsers, Mini Programs, downloadable clients, or permanent personal-user identities.

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
- User-initiated Agent operations preserve delegated user context.
- Service and device identities receive only explicit scopes/model access and Grants.
- A Service API Token authenticates a service principal and never becomes an implicit Space membership or administrator role.
- A system identity does not become a Space member merely to gain API access.
- AI Model Designer has no implicit data/model administration authority; its output is only a proposal until an authorized publisher validates and publishes it.
