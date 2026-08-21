# @lifespace/contracts

Reproducible contract publication/export surface for LifeSpace consumers.

Canonical API syntax remains owned by the services and Model Registry:

- `apps/identity/openapi.yaml` — Identity contract;
- `apps/core/openapi.yaml` — Core Kernel contract;
- immutable `mct_*` Model Contract revisions — ordinary model OpenAPI/JSON Schema;
- application integration policy such as `infra/homemew-integration-profile.json`.

Generated/exported artifacts are read-only handoff material. They must never become a second editable source of truth, and downstream applications must pin an explicit compatible contract combination instead of consuming an unversioned latest revision.

## HomeMew current accepted handoff

The current HomeMew release pin is:

```text
Identity:       0.4.0
Core Kernel:    0.12.0
Model Contract: mct_37f64546f9ebaf9697ee34b6b692ba3b96976a015b7ab5e5b243018fd3cfb41b
Profile:        infra/homemew-integration-profile.json (profileVersion 1, accepted)
```

This Model Contract revision was produced on 2026-08-21 by compatible metadata-only publications for the four HomeMew baseline models. Task, Wish, Day Record and Event now carry explicit domain-selection and field semantics consumed by Registry-driven Creation Draft classification. Ordinary CRUD/storage behavior is unchanged; the semantic metadata prevents broad schemas such as Wish from acting as an accidental fallback during AI interpretation.

`pnpm --filter @lifespace/contracts export:homemew` exports `dist/homemew/` after verifying the configured deployment and exact pinned Model Contract revision.

The bundle contains:

- `identity.openapi.yaml`;
- `core-kernel.openapi.yaml`;
- `model-contract.openapi.json`;
- `model-contract.schema.json`;
- `model-contract.manifest.json`;
- `homemew-integration-profile.json`;
- `handoff.json` with the explicit contract/application-policy tuple;
- `checksums.json` with SHA-256 file hashes and a deterministic `hmb_*` bundle id.

The exporter requires a service-only `models:manage` bearer only to read the exact immutable `mct_*` revision from Core. That bearer is not written to the bundle. Application credentials, Service API Tokens, signing keys and other secret material are never handoff artifacts.

## Previous 2026-08-21 audit-actor handoff

Before the Creation Draft semantic metadata update, HomeMew pinned:

```text
Model Contract: mct_a4cc6dad278204b08cd706f9abeb68107e229148f1cd9ccde0991382606a92b9
```

That immutable revision introduced Generic Resource audit actors (`createdBy` / `updatedBy`) in the generated ordinary-model response contract and remains historical contract evidence.

## Historical Phase-4 accepted handoff

Phase 4 originally accepted this tuple:

```text
Identity:       0.4.0
Core Kernel:    0.12.0
Model Contract: mct_9a3d9588da8591ab376ef000e5e661f670a64dd8b1ebc14fd146580f0ed1fa45
Profile:        infra/homemew-integration-profile.json (profileVersion 1, accepted at that time)
```

The Phase-4 exporter-enabled staging gate passed in `Deploy staging` run #29 (`31694445585`) and uploaded the read-only HomeMew handoff artifact after proving deterministic export and the full application/platform regression suite. This historical revision remains immutable contract evidence; it is no longer the current HomeMew release pin.
