# @lifespace/contracts

Reproducible contract publication/export surface for LifeSpace consumers.

Canonical API syntax remains owned by the services and Model Registry:

- `apps/identity/openapi.yaml` — Identity contract;
- `apps/core/openapi.yaml` — Core Kernel contract;
- immutable `mct_*` Model Contract revisions — ordinary model OpenAPI/JSON Schema;
- application integration policy such as `infra/homemew-integration-profile.json`.

Generated/exported artifacts are read-only handoff material. They must never become a second editable source of truth, and downstream applications must pin an explicit compatible contract combination instead of consuming an unversioned latest revision.

## HomeMew current accepted handoff

The current HomeMew release pin remains:

```text
Identity:       0.4.0
Core Kernel:    0.12.0
Model Contract: mct_a4cc6dad278204b08cd706f9abeb68107e229148f1cd9ccde0991382606a92b9
Profile:        infra/homemew-integration-profile.json (profileVersion 1, accepted)
```

This immutable revision introduced Generic Resource audit actors (`createdBy` / `updatedBy`) in the generated ordinary-model response contract and is the contract currently accepted by the production HomeMew release. A compatible Registry publication does not automatically advance this application release pin; the pin is promoted only after the target production Registry state has been deployed and accepted.

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

## Creation Draft semantic release candidate

The 2026-08-21/22 Creation Draft fix publishes metadata-only compatible versions of the four HomeMew baseline models:

```text
Task:       v3  3c56f1448340162279be544e16ac82e06c1aefe66a08e428b7f95ba319ab1ed2
Wish:       v4  6a5ccd9b6c30bcf3fc012b6e2aac6e4de53972a5d588a4ccd0f3300c7287b8f4
Day Record: v2  4b2f241958aeca05e396eea7e6719a3f030cef3ea7dfd3c57d426c086fe4cf56
Event:      v3  6a23eb2f25463ce55d7ed75d64f0afa020d7aab25149badf28fdd77abc2d1aad
```

These versions add explicit domain-selection and field semantics consumed by Registry-driven Creation Draft classification. Ordinary CRUD/storage behavior is unchanged; the semantic metadata prevents broad schemas such as Wish from acting as an accidental fallback during AI interpretation.

The four-model semantic fingerprint is **not** itself an environment-wide active Model Contract pin. `mct_*` revisions snapshot the entire published Registry, so staging or production may legitimately produce a different active `mct_*` when other ordinary models are also published. Creation Draft verification therefore proves that its pinned immutable Registry revision contains the exact four baseline versions/hashes above, while allowing unrelated published models to coexist.

HomeMew's accepted handoff pin will be advanced separately only after the compatible semantic versions are deployed and accepted in production.

## Historical Phase-4 accepted handoff

Phase 4 originally accepted this tuple:

```text
Identity:       0.4.0
Core Kernel:    0.12.0
Model Contract: mct_9a3d9588da8591ab376ef000e5e661f670a64dd8b1ebc14fd146580f0ed1fa45
Profile:        infra/homemew-integration-profile.json (profileVersion 1, accepted at that time)
```

The Phase-4 exporter-enabled staging gate passed in `Deploy staging` run #29 (`31694445585`) and uploaded the read-only HomeMew handoff artifact after proving deterministic export and the full application/platform regression suite. This historical revision remains immutable contract evidence; it is no longer the current HomeMew release pin.
