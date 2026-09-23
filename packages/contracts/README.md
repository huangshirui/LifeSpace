# @lifespace/contracts

Reproducible contract publication/export surface for LifeSpace consumers.

Canonical API syntax remains owned by the services and Model Registry:

- `apps/identity/openapi.yaml` — Identity contract;
- `apps/core/openapi.yaml` — Core Kernel contract;
- `apps/core/integration-eventing.openapi.yaml` — Integration/Eventing contract for consumers that use Eventing;
- immutable `mct_*` Model Contract revisions — environment-local ordinary-model OpenAPI/JSON Schema evidence;
- application integration policy such as `infra/homemew-integration-profile.json`.

Generated/exported artifacts are read-only handoff material. They must never become a second editable source of truth, and downstream applications must pin an explicit compatible contract combination instead of consuming an unversioned latest revision.

## HomeMew current accepted handoff

The machine-readable source of truth is `infra/homemew-integration-profile.json`. Its currently accepted production-ready baseline is:

```text
Identity:                   0.6.0
Core Kernel:                0.37.0
Integration/Eventing:       0.2.0
Model Semantic Fingerprint: msf_d6b275bf5f4516f057c02a21f89e46de380a71ffa85e9c34a9fbac60f1b60c01
Profile:                    infra/homemew-integration-profile.json (profileVersion 3, accepted)

Accepted staging mct evidence:
  mct_64b2ee86ba0a5dbc0d3dbee152321cf3b7fc2e38bc25e3294490b869a97a2e1f
```

This accepted baseline remains immutable until an explicit staging-candidate promotion updates the profile and its content-addressed staging evidence. Repository model semantics may advance ahead of that accepted baseline: staging proves the candidate first, exports a reproducible candidate bundle, and production remains fail-closed on the accepted profile until promotion.

Schema 42 has now been explicitly promoted from staging Run #95. It adds semantic field descriptions to Task and Day Record without changing typed storage or ordinary CRUD behavior. The accepted hashes are Task `fed3dab27e2f51da3780e42db38dd164fefe39f7d6e7f84161a97e1a8a6d96e6` and Day Record `9dae14eeaef9311412dc910a8976cf85e7d8641792192376ed6678739fe029d1`; the accepted staging evidence is `mct_64b2ee86ba0a5dbc0d3dbee152321cf3b7fc2e38bc25e3294490b869a97a2e1f`.

The promotion continues the #200 modelKey-only Runtime identity: cross-environment Model Semantic Fingerprints contain only `key + schemaHash`; `route` is not a Model identity. HomeMew remains a direct LifeSpace consumer. The four pre-#200 `/api/v1` domain-path compatibility aliases used during the cutover have been retired under #207; supported ordinary Runtime addressing is the canonical `/api/v1/spaces/{spaceId}/models/{modelKey}/records/...` surface.

Historical accepted tuples remain historical release evidence and are not rewritten when the current accepted baseline advances.

### Cross-environment model identity

A Model Contract Revision (`mct_*`) is a content-addressed snapshot of one environment's complete published Registry. Its manifest contains environment-local monotonic Model Registry versions. Staging and production can therefore have different valid `mct_*` IDs even when the HomeMew-visible model semantics are identical.

HomeMew release compatibility across environments is pinned by a semantic fingerprint over the exact models HomeMew consumes. The historical profile v2 is immutable pre-#200 evidence and hashed `key + route + schemaHash`. LifeSpace #200 removes `route` from all new candidate identities; profile v3 and later hash the model entries sorted by `key`, where each entry contains only:

```text
key
schemaHash
```

Environment-local model `version` and the environment-wide `mct_*` ID are deliberately excluded.

The historical profile v2 fingerprint covered:

```text
day_record  day-records  4b2f241958aeca05e396eea7e6719a3f030cef3ea7dfd3c57d426c086fe4cf56
event       events       6a23eb2f25463ce55d7ed75d64f0afa020d7aab25149badf28fdd77abc2d1aad
task        tasks        aaa6317b3810a20e6c4622736ec8e39e96edcd5079c6189fb5892ac54397b145
wish        wishes       ec4f99f238e44c756905d30a97f6bb5c063b783eca159dfe39f518ea58ff64b6
```

The current accepted profile v3 fingerprint covers:

```text
day_record  9dae14eeaef9311412dc910a8976cf85e7d8641792192376ed6678739fe029d1
event       be9bdea442a30108a22a2da77a96ab23aba5122ec3c2b1de20a6312cebb0cc8a
task        fed3dab27e2f51da3780e42db38dd164fefe39f7d6e7f84161a97e1a8a6d96e6
wish        7dc6c079916a967c8bcd93f8cbe082c98157ceaeb30ce782ef3f2eb035d370df
```

The release rule is therefore:

```text
Identity version
+ Core Kernel version
+ HomeMew Model Semantic Fingerprint
+ Integration/Eventing version (for post-split HomeMew releases that use Eventing)
= cross-environment application compatibility identity

mct_* = immutable environment-local contract/deployment evidence
```

A schema semantic change requires an explicit HomeMew compatibility decision and a new fingerprint. A merely higher environment-local Registry version does not. New staging candidates and promoted profiles must use only `key + schemaHash`; the legacy v2 calculation exists solely to verify its historical accepted artifact and must not be used to generate new identity.

### Reproducible staging handoff

`pnpm --filter @lifespace/contracts export:homemew` exports `dist/homemew/` only after verifying the configured Core/Identity versions, loading an explicit immutable staging `mct_*` evidence revision and proving that its HomeMew models match the accepted semantic fingerprint.

The bundle contains:

- `identity.openapi.yaml`;
- `core-kernel.openapi.yaml`;
- `integration-eventing.openapi.yaml` when the accepted profile pins Eventing;
- `model-contract.openapi.json`;
- `model-contract.schema.json`;
- `model-contract.manifest.json`;
- `homemew-integration-profile.json`;
- `handoff.json` with the cross-environment semantic release identity plus environment-local Model Contract evidence;
- `checksums.json` with SHA-256 file hashes and a deterministic `hmb_*` bundle id.

The exact staging `mct_*` remains useful as immutable code-generation and staging evidence; it is not required to be the production active `mct_*`. Production instead verifies the same semantic fingerprint against its own active immutable Model Contract.

The exporter requires a service-only `models:manage` bearer only to read the selected immutable `mct_*` revision from Core. That bearer is not written to the bundle. Application credentials, Service API Tokens, Webhook signing secrets, signing keys and other secret material are never handoff artifacts.

## Creation Draft semantic release candidate

The 2026-08-21/22 Creation Draft fix published metadata-only compatible versions of the four HomeMew baseline models:

```text
Task:       v3  3c56f1448340162279be544e16ac82e06c1aefe66a08e428b7f95ba319ab1ed2
Wish:       v4  6a5ccd9b6c30bcf3fc012b6e2aac6e4de53972a5d588a4ccd0f3300c7287b8f4
Day Record: v2  4b2f241958aeca05e396eea7e6719a3f030cef3ea7dfd3c57d426c086fe4cf56
Event:      v3  6a23eb2f25463ce55d7ed75d64f0afa020d7aab25149badf28fdd77abc2d1aad
```

These historical versions added explicit domain-selection and field semantics consumed by Registry-driven Creation Draft classification. Ordinary CRUD/storage behavior was unchanged; the semantic metadata prevented broad schemas such as Wish from acting as an accidental fallback during AI interpretation.

A four-model semantic identity is **not** an environment-wide active Model Contract pin. `mct_*` revisions snapshot the entire published Registry, so staging or production may legitimately produce a different active `mct_*` when environment-local versions or unrelated ordinary models differ. Creation Draft verification therefore proves the required model semantics while allowing unrelated published models to coexist.

HomeMew's accepted semantic release identity advances only through an explicit downstream compatibility decision after the target release state has been deployed and accepted in staging. The selected staging `mct_*` evidence must then pass deterministic handoff export/upload before production deployment; production proves the same semantic fingerprint against its own active immutable contract rather than following staging's `mct_*` ID.

## Historical Phase-4 accepted handoff

Phase 4 originally accepted this tuple:

```text
Identity:       0.4.0
Core Kernel:    0.12.0
Model Contract: mct_9a3d9588da8591ab376ef000e5e661f670a64dd8b1ebc14fd146580f0ed1fa45
Profile:        infra/homemew-integration-profile.json (profileVersion 1, accepted at that time)
```

The Phase-4 exporter-enabled staging gate passed in `Deploy staging` run #29 (`31694445585`) and uploaded the read-only HomeMew handoff artifact after proving deterministic export and the full application/platform regression suite. That historical tuple remains immutable evidence of what Phase 4 proved; it is not the current cross-environment HomeMew release identity.
