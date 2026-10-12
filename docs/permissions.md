# LifeSpace Permission Model

## Core concepts

- **User**: global human LifeSpace identity (`usr_*`) resolved by LifeSpace Identity after an approved authentication path. For owner-controlled Web/PWA applications, Cloudflare Access proves the Web user and Identity resolves the verified Access principal to the global LifeSpace user.
- **Authenticated principal context**: the current implementation's normalized authenticated identity context, such as a user or service identity carried by a verified credential. Existing contracts/code may use the shorter term `principal`; this is implementation vocabulary, not a claim that `Principal -> User | Agent | Application | Service` is the long-term entity ontology.
- **Principal role**: in the North Star authority model, whose authority is being exercised for an operation.
- **Actor role**: who/what actually executes or initiates an operation. Principal and Actor may be the same entity or different entities.
- **Application context**: the registered LifeSpace application through which an operation occurs; this is distinct from saying an Application entity is automatically the Principal or Actor.
- **Space**: source ownership, default authorization and durable Shared Reality boundary for business data.
- **Space membership**: role-based relationship between a user and a Space.
- **Data Grant**: permission that exposes a Space or approved resource target to another authenticated identity/principal target or Space without changing ownership. Kernel 0.13.0 implements whole-Space and model-collection targets; record/view targets remain future contract work.
- **Credential scope**: stable permission carried by the current credential, such as `resources:read`, `resources:write`, `resources:manage`, or a Kernel-specific scope.
- **Application × Model Access**: Core catalog entry declaring the maximum `read` / `write` / `manage` access one application may exercise for one published model.
- **Model access capability**: `read`, `write`, or `manage` capability declared by the published Model Definition.
- **Model policy**: optional record/input-level restriction evaluated after authenticated identity, credential/application and Space/Data Grant authority.
- **Service API Token**: long-lived opaque bearer credential for one trusted service principal representation and client context; it is individually scoped, optionally expiring, and revocable.

Do not use `Data Grant` to mean OAuth authorization code/grant flow.

## Entity type and operation role

Long-term conceptual design keeps entity type and operation role orthogonal:

```text
Entity type
  User | Agent | Application | Service | future identifiable entity types

Operation
  principal          = whose authority is exercised
  actor              = who/what executes or initiates the operation
  applicationContext = through which registered application context it occurs
```

A direct user action can have `principal == actor`. A user-delegated Agent action can have the user as Principal and the Agent as Actor. An Agent with explicitly granted independent authority may itself fill both roles.

An Agent is therefore a possible first-class Actor and authority-bearing entity, but it never obtains user authority merely because it executes a user-requested operation. Delegation must be explicit and bounded.

A Space Person (`per_*`) remains Shared Reality business identity, not an Authority-bearing identity. Policy may bridge a User Principal or User Actor to its active Space Person without changing the Authority model. For represented User -> Agent execution, `principal.personId` may resolve to the user's Space Person while `actor.personId` is null because the Agent is not itself a Person. This policy context may be co-fetched with Authority state for D1 efficiency, but Membership/Data Grant/Application Access/Delegation decisions remain based on Principal/Actor identities rather than Person records. The Runtime interface must preserve that distinction as well: Authority facts are returned as an Authority decision, while `principalPersonId / actorPersonId` are returned under a separate Policy Identity result even when one SQL statement physically supplies both.

This clarification does not retroactively add a universal Agent/Actor persistence model or require an immediate rename of deployed `principal`, `principal_type`, service-principal or token claims. Those are current contract/implementation terms and remain authoritative for supported behavior.

## Effective permission

Every ordinary Runtime operation executes under a verified **Execution Context**:

```text
application
principal
actor
delegationId?   // opaque selector only
```

Application / Principal / Actor are established from verified credential/runtime context and are never accepted as unsigned request identity. The request may carry `delegationId` only as an opaque selector; possession of a Delegation ID grants nothing.

A direct operation has `principal == actor` and requires no Delegation. A represented operation has `principal != actor` and requires a current valid Delegation bound to the verified Principal, Actor and Application.

Effective permission for an ordinary model is the intersection of:

1. verified Execution Context;
2. the current credential's stable `resources:*` scope required by the operation;
3. the calling application's current Application × Model Access catalog entry;
4. the Principal's current Space membership / Data Grant authorization;
5. a current Delegation when Principal and Actor differ;
6. the published model's declared access capability;
7. model policy / Capability-specific restrictions.

In short:

```text
verified Execution Context
∩ stable resources:* credential scope
∩ Application × Model Access
∩ Principal current Space membership/Data Grant
∩ Delegation when principal != actor
∩ published model access capability
∩ model policy/Capability restrictions
```

Delegation only narrows the Principal's current Authority. Actor-owned Authority cannot fill a gap when another Principal is declared. Revoking or narrowing Membership/Data Grant/Application Access/Delegation affects the next current-state check even when a credential is still cryptographically valid.

Core does not scan for a more permissive or “best matching” Delegation. A represented operation identifies the Delegation it intends to exercise and Core validates that selector against current state. One Delegation contains one Scope: one Space/Model/Record target plus one access ceiling. Record-scoped read authorizes only an already-known record and never collection enumeration.

No application is trusted merely because of its hostname or product name. Publishing a model does not automatically grant every application or service access to it.

For Access-authenticated Web requests, Cloudflare authentication alone satisfies none of the business-authority layers above. Identity must first validate the Access assertion, resolve `(iss, sub)` to a LifeSpace `usr_*`, bind the Access `aud` to the intended LifeSpace application context and issue/authorize the appropriate LifeSpace credential. Core authorization then proceeds exactly as for the same `usr_*` reached through any other approved authentication path.

For delegated Agent execution, the Agent token authenticates User Principal + Agent Actor + Application. The specific `delegationId` is intentionally not a bearer claim: it remains a request selector that Core rechecks against those verified identities and current Delegation state.

### Accepted Agent Principal / re-delegation target

The released credential profile above is the current implementation, not the permanent Authority ontology. The accepted target in `docs/authority-role-capability-redelegation.md` generalizes execution without changing the effective-authority intersection:

- Entity Type and operation role stay orthogonal; code-owned Entity Role Capability determines whether a type may be Principal / Actor / delegation issuer/receiver, but never grants business Authority.
- An Agent with explicit current Authority may execute as `Principal = Actor = Agent`.
- Identity converges on a short-lived Agent Execution Token where `sub` identifies the authenticated Agent Actor while Principal is an independent signed claim; Delegation remains a Core-validated request selector rather than bearer Authority.
- Ordinary `Agent A -> Agent B` delegation of A's own Authority uses `Principal=A, Actor=B`.
- Re-delegation preserves the original Root Principal and requires an explicit parent chain. Each child can only narrow scope, access ceiling, expiry and remaining propagation depth and remains in the same Application Context in the initial implementation.
- Clients submit only the leaf Delegation ID. Core resolves and validates the bounded ancestor chain from current state.
- Parent revoke / expiry / single-use consumption invalidates descendants without cascade-updating descendant rows.
- Successful mutation consumes every required single-use Delegation in the chain atomically with business Change / ChangeSet evidence; creating a Child Delegation does not itself consume a single-use parent.
- Governed Change must preserve the actual chain relied on at commit time rather than reconstructing historical Authority from mutable current state.

These target semantics are tracked by #302 and must not be described as deployed until the corresponding contracts/runtime/tests are released.

## Model authorization

Ordinary metadata-driven models declare `read`, `write`, and optionally `manage` access capabilities. Identity does **not** mint a new token-scope vocabulary for every model.

Stable credential scopes are:

```text
resources:read
resources:write
resources:manage
```

A credential with `resources:write` is still unable to write model `task` unless the calling application's Core catalog entry allows `task` at `write` or higher. Likewise, a catalog entry alone grants nothing when the credential lacks the stable resource scope or the authenticated identity lacks current Space/Data Grant authority.

Example:

```text
JWT / Service API Token scopes:
  resources:read resources:write

Application × Model Access:
  app_example × task       -> write
  app_example × wish       -> write
  app_example × day_record -> write
  app_example × event      -> write
```

This split is deliberate. Publishing a new ordinary model does not require an Identity deployment or an update to every application's Identity `allowed_scopes`. The model is unavailable to an application until an authorized Core administrator creates the corresponding Application × Model Access entry.

Runtime addressing reads `modelKey` directly from the canonical `/models/{modelKey}/records/...` path and derives the required `read` / `write` / `manage` level from the published definition; it never trusts a client-provided model scope name or requires Discovery to translate another identity.

Model publication/retirement and Application × Model Access administration are platform administration, not ordinary Space `manage` permissions. Model Registry governance surfaces remain service-principal-only with `models:manage` in the independently versioned Core Model Control Plane contract. Console-triggered model mutations preserve that service executor and add separately verified human Actor evidence; they do not turn the human user into a Model Admin service principal.

## Platform administration

Decision status: **accepted and implemented in the LifeSpace Console Slice 0 branch; deployment remains staging-gated.**

Platform administration is deliberately separate from Space roles and ordinary business-data authorization. Being a Space `owner` or `admin` does not make a user a LifeSpace platform administrator, and a platform-administration executor is never made a hidden member of every Space.

Cloudflare Access is the Console perimeter/SSO layer, not the final LifeSpace platform-authorization source. LifeSpace Identity owns an explicit `platform_administrators` assignment for eligible global `usr_*` users. Assignment creation/revocation is bootstrap/break-glass administration; routine Console runtime does not hold the bootstrap secret.

A privileged Console operation has two independently verified identities/roles:

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
  Core admin:     Console service principal / lsp_svc_* (legacy lsp_pat_* accepted) or equivalent service JWT
  operation-specific capability
              ∩
same LifeSpace application context (azp / clientId)
              =
platform-admin operation
```

This deployed control-plane flow deliberately uses the terms human `actor` and controlled `executor`. The executor is not silently the human's Principal, and neither role obtains ordinary Space authority from the platform-admin relationship.

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
- Platform-admin operations emit audit evidence that distinguishes the human `usr_*` Actor from the backend/service executor and never record credential plaintext, hashes, Access assertions, or actor-proof plaintext.
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

Any policy evaluation error fails closed.

## Service credentials

The deployed service credential model remains authoritative. See `docs/service-authentication.md`.

A service may authenticate either with a canonical opaque `lsp_svc_*` Service API Token (legacy `lsp_pat_*` accepted only as migration input) or with a short-lived service JWT obtained through OAuth `client_credentials`. OAuth is optional for owner-controlled trusted services.

The credential authenticates the current service-principal representation; it does not itself confer Space membership or broad data access. Identity constrains the credential to the application's stable scope ceiling and the service principal's maximum scopes. Core then intersects those scopes with current Application × Model Access, current Data Grants and model rules on every request.

Revoking a Token, disabling its service principal, reducing its scopes, reducing/removing Application × Model Access, or revoking a Data Grant removes the corresponding authority on subsequent requests.

Passive Eventing delivery is subject to the same current-state Service Principal rule even though the subscriber is not presenting a credential on each outgoing Webhook. Core stores only the stable `svc_*` subscriber reference and, immediately before a normal queued Webhook is sent, confirms with Identity that both the Service Principal and its owning registered application are still active. A disabled/missing principal fails closed and receives no delivery even while an old Data Grant and subscription remain. If current Identity state cannot be confirmed, the Webhook is not sent and the Queue delivery is retried rather than being authorized from stale positive state.

This makes Service Principal disablement a platform Authority kill switch for both active Core requests and passive Eventing delivery. Application cleanup may still revoke Grants and delete/disable Eventing configuration, but successful cleanup is not required for the disablement itself to stop new normal event delivery.

Service API Tokens may have `expires_at = null`, but they remain individually revocable and must never be issued to browsers, Mini Programs, downloadable clients, or permanent personal-user identities.

Example:

```text
Service principal: svc_automation_example
Application context: app_integrations_example
Token scopes: resources:read resources:write

Application × Model Access ceiling:
  event -> write
  task  -> write
  day_record -> read

Core Data Grants for spc_example_xxx:
  model:event      -> write
  model:task       -> write
  model:day_record -> read
```

A different service principal under the same application may receive a different set of model-collection Grants. This allows each external system to be authorized independently without restoring model-specific credential scopes.

The effective result is the intersection. The token cannot use a model absent from its application's catalog, and it cannot use a model/Space target absent from current membership/Data Grant authority.

## Space roles

Initial role vocabulary remains small: `owner`, `admin`, `editor`, `viewer`. Published model policy or sensitive-data Capabilities may further reduce these defaults. Roles are not a substitute for model checks.

Kernel lifecycle rules apply uniformly to Spaces unless a future platform-level distinction is explicitly introduced. Product-specific classifications and lifecycle differences belong downstream and must not be inferred from a Space type or naming convention.

### Space lifecycle authority

Kernel 0.16.0 adds an owner-only logical Space closure path:

```http
POST /api/v1/spaces/{spaceId}/close
```

The operation is intentionally stricter than ordinary Space `manage`:

- the caller must be a current authenticated `user` with credential scope `spaces:manage`;
- the caller's current active Space Membership role must be exactly `owner`;
- `admin`, whole-Space `manage` Data Grants, service/device principals and platform-admin authority do not imply Space-close authority;
- the caller must submit the current Space `version`; stale lifecycle changes fail with optimistic-concurrency conflict.

Closing is a governed logical termination, not physical deletion. Core marks the Space closed, records a lifecycle audit event, deactivates active Memberships and linked Space People, revokes active invitations and every Data Grant issued by that Space, and disables its Webhook/Event Subscription configuration. Ordinary Space-owned Shared Reality remains stored for history/retention instead of being deleted record by record.

All ordinary authorization paths must treat a closed Space as outside active Space authority even if stale relationship rows exist. Restore, purge/physical deletion and ownership transfer are separate future lifecycle contracts and must not be inferred from `close`.

## Data Grant principles

- Source data keeps exactly one `space_id`.
- Spaces remain distinct under sharing; a Grant never merges source and target Space.
- Sharing must not duplicate the authoritative record.
- Grants may target a supported authenticated identity/principal representation or another Space when approved.
- Kernel 0.13.0 implements two resource targets:
  - whole Space: `resourceType=space`, `resourceId=null`;
  - model collection: `resourceType=model`, `resourceId=<published modelKey>`.
- Omitted `resourceType/resourceId` on Grant creation remains backwards-compatible with a whole-Space Grant.
- A model-collection Grant authorizes only Generic Runtime operations for that model. It never authorizes Space detail, membership, invitation, or other Kernel Space-management surfaces.
- When both a matching model Grant and a whole-Space Grant are active for the same authenticated principal target, model authorization uses the higher current permission, still bounded by credential scope and Application × Model Access.
- Permission levels are explicit. `free_busy` remains valid only at Space level; model-collection Grants use `read`, `write`, or `manage`.
- Revocation, expiry and permission downgrade take effect from current Core authorization state; do not encode long-lived mutable Space/model permission solely into JWT claims.
- Generic Runtime evaluates Grants against the resolved published `modelKey`, not merely against an arbitrary URL segment supplied by the client.
- Record/view-level Grant targets remain future work and require a concrete contract before implementation.

See `docs/model-scoped-data-grants.md` for the external-integration parity rationale and examples.

## Aggregate access

Authenticated aggregate endpoints under `/api/v1/me/...` may return records from multiple source Spaces when the model/capability explicitly supports aggregation. Each result must preserve source ownership and the caller's effective capabilities so clients can render read-only/shared data correctly.

## Actor safety

- Current authenticated identity/actor context is derived from verified credentials, never request `userId`.
- Do not infer that the authenticated credential holder is always the conceptual Principal for every future delegated operation. Where Principal and Actor differ, the delegation/authority relationship must be explicit and auditable.
- For Access-authenticated Web flows, Identity derives the current LifeSpace user identity from a verified `(iss, sub)` mapping. A BFF-supplied `sub`, email or `userId` is not sufficient authority by itself.
- Access `aud` determines approved application context, not user identity. It must be checked against the registered LifeSpace application before credentials are issued.
- Account linking is authentication state, not authorization. Linking multiple Access principals to one `usr_*` must not expand that user's Space/Data Grant authority; it only adds another approved way to reach the same global user.
- User-initiated Agent operations preserve delegated user authority and Agent Actor attribution when the platform supports that delegation path.
- An Agent is not a User and does not inherit user authority merely by executing the operation.
- Platform-admin operations preserve both a current authorized human Actor and a separately authenticated controlled executor; neither identity may be replaced by an unsigned operator field.
- Service and device identities receive only explicit stable scopes, Application × Model Access and Grants.
- A Service API Token authenticates a service-principal representation and never becomes an implicit Space membership or administrator role.
- A system identity does not become a Space member merely to gain API access.
- AI Model Designer has no implicit data/model administration authority; its output is only a proposal until an authorized publisher validates and publishes it.

## North Star relationship

This document describes the **current permission architecture**. It intentionally keeps deployed authentication/contract terms stable while aligning future design with the North Star axioms:

- **Space Boundary**: Space is the default ownership/authorization boundary; cross-Space sharing is explicit and revocable.
- **Bounded Authority**: authority is explicit; entity type and Principal/Actor roles are not conflated.
- **Governed Change**: authorization is evaluated before durable changes commit. Exact Change Detail is immutable audit evidence but is not a bypass around current authorization: reading historical before/after values rechecks current model read authority, including after soft deletion; revoked Delegations/Grants lose access immediately.

A future implementation of richer Agent identity, delegation, consent or approval must extend these foundations deliberately and update contracts/tests before being described as supported behavior.


## Opaque Agent API credential boundary

`lsp_agt_*` authenticates an active registered Application + active Agent Actor only. With no Delegation selector, Core evaluates direct Agent Authority. With an explicit current `dlg_*`, Core may resolve only a User Root Principal and executes as `Principal=User / Actor=Agent`; the adapter does not submit a `principalUserId`. Service/Agent or other represented Principal types are rejected on this credential profile. Credential scope, Application × Model Access, current User Authority and current Delegation all remain intersected at execution.


## Semantic Relation authority / 语义关系授权

Create/delete require source write and target read; target write is not required. Query/get return an edge only when both same-Space Native endpoints are live and readable, including current Application exposure, Membership/Data Grant, explicit Delegation and identity-only read Policy. Query eligibility participates before pagination. Neither cached projection nor a known edge ID grants mutation authority. Single-use consumption is atomic with the relation Change; idempotent retries recheck current authority, including commit-time consumed/revoked state. See [semantic-relations.md](semantic-relations.md).
