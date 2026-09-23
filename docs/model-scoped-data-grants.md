# Model-scoped Data Grants

Updated: 2026-08-23

## Purpose

LifeSpace Data Grants provide current, revocable authority from one source Space to a grantee principal. Collection-level model semantics allow external integrations to receive bounded model authority without introducing model-specific credential scopes.

The effective ordinary-model authorization remains the intersection of:

```text
verified principal
∩ stable credential scope (`resources:*`)
∩ Application × Model Access
∩ current Space membership / Data Grant
∩ published model access capability
∩ model policy / Capability restrictions
```

## Supported Grant targets

### Whole Space

```json
{
  "resourceType": "space",
  "resourceId": null,
  "permission": "read"
}
```

A whole-Space Grant may authorize Kernel Space reads/management according to its permission and is also a fallback authority for ordinary model operations in that Space.

For backwards compatibility, omitting `resourceType` and `resourceId` when creating a Grant is equivalent to `resourceType=space, resourceId=null`.

### Model collection

```json
{
  "resourceType": "model",
  "resourceId": "event",
  "permission": "write"
}
```

`resourceId` is the published LifeSpace `modelKey`, not an HTTP route segment or consumer-specific legacy scope name.

A model-collection Grant:

- applies only to Generic Runtime operations for the matching model in the source Space;
- does not authorize `/api/v1/spaces/{spaceId}` or membership/invitation Kernel operations;
- supports `read`, `write`, or `manage`; `free_busy` remains a Space-level concept;
- is checked from current D1 state on every authorization decision, so expiry, permission downgrade and revocation take effect without token rotation.

If both a matching model-collection Grant and a whole-Space Grant are active for the same principal, Core uses the higher current permission for that model operation. Application × Model Access and credential scopes remain independent ceilings; a Grant can only narrow/enable data authority, never expand what the application or token is allowed to do.

## External integration parity

Different external systems may require different model permissions, for example:

```text
Workflow automation
  event       write
  task        write

Home Assistant
  event       read
  task        none
```

The LifeSpace-native representation is:

```text
Service Principal (one per external system)
+ stable `resources:read` / `resources:write` credential scopes
+ Application × Model Access ceiling
+ per-Space model-collection Data Grants for that Service Principal
```

Do not restore legacy scopes such as `events:write` or `tasks:read` as the final authorization mechanism. Model identity belongs in the Grant target and Application × Model Access; credential scopes stay stable and model-agnostic.

## Persistence and migration

No D1 schema migration is required for Kernel 0.13.0. `data_grants` has contained generic `resource_type` and nullable `resource_id` columns since the platform foundation migration. This change completes their contract/runtime semantics:

- `resource_type='space'`, `resource_id IS NULL` — whole-Space Grant;
- `resource_type='model'`, `resource_id=<published model key>` — model-collection Grant.

Record/view-level Grant targets remain future work and must be introduced only with an explicit contract and authorization requirement.
