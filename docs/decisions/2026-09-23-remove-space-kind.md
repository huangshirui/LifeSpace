# Remove Space.kind after explicit deprecation

Status: **Accepted**

Date: 2026-09-23

## Context

`Space.kind` originally classified a Space as `personal`, `family` or `team`. The field never became an independent LifeSpace authorization, ownership or lifecycle primitive. The only material Kernel behavior attached to it was product-specific family capacity policy, which was removed before this decision.

Kernel 0.38.0 completed the semantic deprecation:

- no authorization decision depends on `kind`;
- membership and invitation behavior is identical for every Space;
- Platform Inspector and Console no longer expose or filter by `kind`;
- `CreateSpace.kind` became optional and was documented as deprecated;
- the response/storage field remained temporarily only for Stable Public wire compatibility.

Repository-wide checks of current downstream code found no active dependency on the deprecated Space classification. There is therefore no replacement semantic to migrate to: applications that need a business classification own that classification outside the LifeSpace Kernel.

## Decision

Kernel 0.39.0 removes `Space.kind` completely:

- remove `SpaceKind` from the Kernel OpenAPI;
- remove `kind` from Space create requests and Space/invitation-preview responses;
- remove all Runtime reads/writes of the column;
- migration 0045 drops `spaces.kind`;
- tests and staging fixtures use a generic Space without product classification.

This is an explicit Stable Public breaking representation change following the 0.38.0 deprecation step. The `core-space-membership` contract group remains Stable; it is not downgraded to avoid compatibility review.

## Compatibility

There is no replacement field.

A caller that still sends `kind` after 0.39.0 receives the normal unsupported-field/invalid-request response because Space creation uses a closed request object. A caller that previously read `kind` must stop doing so.

The accepted Stable Public schema baseline is regenerated deliberately as part of this breaking release after this decision and migration evidence are present.

## Data migration

The removed values carry no remaining platform semantics and require no backfill. Migration 0045 drops the column after migration 0044 already removed every family-specific trigger and migration-era consumer table.

Historical numbered migrations remain immutable; a fresh database may create the old column while replaying history and then removes it at migration 0045. The final schema contains no Space classification column.

## Rollback

Application code can be rolled back only together with a compatible schema restore. Because the dropped values are intentionally semantically dead, normal rollback does not attempt to reconstruct them. Production rollout must therefore treat 0045 as the explicit irreversible schema boundary for Kernel 0.39.0.
