# LifeSpace Permission Model

## Core concepts

- **User**: global human LifeSpace identity (`usr_*`) resolved by LifeSpace Identity after an approved authentication path. For owner-controlled Web/PWA applications, Cloudflare Access proves the Web user and Identity resolves the verified Access principal to the global LifeSpace user.
- **Principal**: an authorization role for the entity whose authority is being exercised by the current credential/operation. In the currently deployed ordinary runtime, Core authenticates concrete user or service principals. `Principal` is not the conceptual parent type of every User, Agent, Application or Service entity.
- **Actor**: the entity that actually initiates or executes an operation when that distinction is material. For a direct ordinary request, principal and actor normally coincide. Mediated/delegated flows may distinguish them only through an explicit verified contract; platform administration already distinguishes a human actor from a controlled service executor.
- **Application context**: the registered LifeSpace application/integration context (`azp` / application id) through which authority is exercised. An Application may itself have credentials or controlled executors in specific flows, but application context is not automatically the principal or actor of every request.
- **Space**: source ownership and default authorization boundary for business data. Spaces are isolated by default; cross-Space sharing is explicit, bounded and revocable.
- **Space membership**: role-based relationship between a user and a Space.
- **Data Grant**: permission that exposes a Space or approved resource target to another principal or Space without changing ownership. Kernel 0.13.0 implements whole-Space and model-collection targets; record/view targets remain future contract work.
- **Credential scope**: stable permission carried by the current credential, such as `resources:read`, `resources:write`, `resources:manage`, or a Kernel-specific scope.
- **Application × Model Access**: Core catalog entry declaring the maximum `read` / `write` / `manage` access one application may exercise for one published model.
- **Model access capability**: `read`, `write`, or `manage` capability declared by the published Model Definition.
- **Model policy**: optional record/input-level restriction evaluated after principal, credential/application and Space/Data Grant authority.
- **Service API Token**: long-lived opaque bearer credential for one trusted service principal and client context; it is individually scoped, optionally expiring, and revocable.

Do not use `Data Grant` to mean OAuth authorization code/grant flow.

### Entity type versus operation role

The long-term North Star deliberately keeps identity-capable entity types separate from operation roles.

Conceptually, entities may include User, Agent, Application, Service and other explicitly modeled identities such as Device when justified. A particular operation may then refer to:

```text
principal           -> whose authority is being exercised
actor               -> who/what initiates or executes the operation
application context -> through which registered application/integration it occurs
```

Principal and actor may be the same or different. For example, a user directly changing a Task has the user as both principal and actor. A future explicitly modeled Agent acting under delegated user authority may have the user as principal and the Agent as actor. An Agent must not receive user-equivalent authority merely because it can act.

This is a conceptual boundary, not a claim that first-class Agent identity/delegation is already implemented. Current deployed contracts continue to use their concrete user/service-principal vocabulary until a deliberately versioned Agent/delegation contract exists.

## Effective permission

Effective permission for an ordinary model is the intersection of:

1. verified principal identity/authority;
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

Decision status: **accepted and implemented in the LifeSpace Console Slice 0 branch; deployment remains staging-gated.**

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

In this specialized control-plane flow, the human actor is the attributable human authority/initiator while the controlled backend/service executor performs the privileged server operation. This is an explicit mediated contract and must not be generalized into an unsigned `actor` field on ordinary requests.

Rules:

- Cloudflare Access controls entry to `lifespace.aisr.online`, but an Access session, IdP email, or Access `sub` is not by itself LifeSpace platform-administration authority.
- Identity first verifies Access, resolves `(iss, sub)` to the global `usr_*`, and establishes the ordinary app-scoped LifeSpace user session.
- A normal LifeSpace user JWT is **not** accepted as platform-admin actor proof, even if a caller attempts to place `platform:admin` in a normal requested scope list.
- `POST /api/v1/me/platform-admin-actor-token` is the dedicated privilege-elevation boundary. Identity checks the current user, current `platform_administrators` assignment, current application status, and the application's permission to request `platform:admin`, then issues a purpose-bound actor proof valid for at most five minutes.
- The actor proof is carried separately as `X-LifeSpace-Actor-Token`. A raw `actorUserId`, email, Access subject, decoded claim, or unsigned operator header is never accepted as operator identity.
- Privileged service endpoints require a separate executor credential held only by the same-origin Console BFF/Worker. Browser JavaScript never receives `lsa_*`, `lsp_pat_*`, bootstrap secrets, signing keys, or equivalent executor secrets.
- Actor proof and executor must resolve to the same registered LifeSpace application context. A proof issued to another application cannot be paired with a Console executor credential.
- Identity-owned Admin APIs verify the Console `lsa_*`, independently verify the actor proof, and re-check the actor's current `platform_administrators` assignment on every privileged request. Revoking the assignment therefore immediately denies subsequent Identity Admin calls even if an actor proof has not expired.
- Core-owned Admin APIs independently verify the service executor and the Identity-signed purpose-bound actor proof. Core does not duplicate/read Identity's administrator table; its maximum authorization staleness is therefore bounded by the five-minute actor-proof lifetime.
- Platform-admin operations emit audit evidence that distinguishes the human `usr_*` actor from the backend/service executor and never record credential plaintext, hashes, Access assertions, or actor-proof plaintext.
- Console-triggered Model Admin mutations first persist a `pending` audit record before the Registry mutation starts, then transition it to `success` or `failure`. If audit persistence is unavailable before mutation, the mutation does not begin.
- Existing non-interactive service automation using `models:manage` remains supported without a human actor proof. Supplying `X-LifeSpace-Actor-Token` on a mutation opts into the Console human-attribution path and the proof must then validate.
- The global bootstrap secret remains provisioning/break-glass authority. It is not a normal Console runtime credential and must not be stored in the Console Worker/BFF.

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

`$actor` is existing policy-language vocabulary for the verified current calling identity/context. It must not be interpreted as a license for a client to inject an arbitrary long-term North Star actor identity.

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
Application context: homemew-integrations
Token scopes: resources:read resources:write

Application × Model Access ceiling:
  event -> write
  task  -> write
  day_record -> read

Core Data Grants for spc_family_xxx:
  model:event      -> write
  model:task       -> write
  model:day_record -> read
```

A different service principal under the same application may receive a different set of model-collection Grants. This is how LifeSpace preserves the original HomeMew capability to authorize each external system independently without restoring model-specific credential scopes.

The effective result is the intersection. The token cannot use a model absent from its application's catalog, and it cannot use a model/Space target absent from current membership/Data Grant authority.

## Space roles

Initial role vocabulary remains small: `owner`, `admin`, `editor`, `viewer`. Published model policy or sensitive-data Capabilities may further reduce these defaults. Roles are not a substitute for model checks.

Personal Spaces may apply stricter lifecycle rules than family/team Spaces, such as one immutable owner and no ownership transfer, but such rules must be explicit Kernel policy rather than client assumptions.

## Data Grant principles

- Source data keeps exactly one `space_id`.
- Spaces are isolated by default; a Grant or approved derived view creates bounded sharing, not Space merging.
- Sharing must not duplicate the authoritative record.
- Grants may target a user/principal or another Space when approved.
- Kernel 0.13.0 implements two resource targets:
  - whole Space: `resourceType=space`, `resourceId=null`;
  - model collection: `resourceType=model`, `resourceId=<published modelKey>`.
- Omitted `resourceType/resourceId` on Grant creation remains backwards-compatible with a whole-Space Grant.
- A model-collection Grant authorizes only Generic Runtime operations for that model. It never authorizes Space detail, membership, invitation, or other Kernel Space-management surfaces.
- When both a matching model Grant and a whole-Space Grant are active for the same principal, model authorization uses the higher current permission, still bounded by credential scope and Application × Model Access.
- Permission levels are explicit. `free_busy` remains valid only at Space level; model-collection Grants use `read`, `write`, or `manage`.
- Revocation, expiry and permission downgrade take effect from current Core authorization state; do not encode long-lived mutable Space/model permission solely into JWT claims.
- Generic Runtime evaluates Grants against the resolved published `modelKey`, not merely against an arbitrary URL segment supplied by the client.
- Record/view-level Grant targets remain future work and require a concrete contract before implementation.

See `docs/model-scoped-data-grants.md` for the external-integration parity rationale and examples.

## Aggregate access

Authenticated aggregate endpoints under `/api/v1/me/...` may return records from multiple source Spaces when the model/capability explicitly supports aggregation. Each result must preserve source ownership and the caller's effective capabilities so clients can render read-only/shared data correctly.

Aggregation never changes the source Space or turns the caller's aggregate view into a new authoritative copy.

## Actor safety

- Current authenticated identity/authority is derived from verified credentials, never request `userId`.
- For ordinary direct user/service requests, the authenticated principal and execution actor normally coincide in the deployed runtime. A future distinction must be carried by an explicit authenticated/delegated contract rather than a client-supplied field.
- For Access-authenticated Web flows, Identity derives the current LifeSpace user principal from a verified `(iss, sub)` mapping. A BFF-supplied `sub`, email or `userId` is not sufficient authority by itself.
- Access `aud` determines approved application context, not user identity. It must be checked against the registered LifeSpace application before credentials are issued.
- Account linking is authentication state, not authorization. Linking multiple Access principals to one `usr_*` must not expand that user's Space/Data Grant authority; it only adds another approved way to reach the same global user.
- User-initiated Agent operations preserve delegated user authority. If a future Agent is separately identifiable as actor, that does not make it the user principal or grant additional authority unless an explicit Agent-owned grant/delegation exists.
- Platform-admin operations preserve both a current authorized human actor and a separately authenticated controlled executor; neither identity may be replaced by an unsigned operator field.
- Service and device identities receive only explicit stable scopes, Application × Model Access and Grants.
- A Service API Token authenticates a service principal and never becomes an implicit Space membership or administrator role.
- An Application context does not itself become a Space member or principal merely because a request is routed through that application.
- A system identity does not become a Space member merely to gain API access.
- AI Model Designer has no implicit data/model administration authority; its output is only a proposal until an authorized publisher validates and publishes it.
