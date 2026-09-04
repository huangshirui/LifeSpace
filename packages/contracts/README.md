# @lifespace/contracts

Reproducible contract publication/export surface for LifeSpace consumers.

Canonical API syntax remains owned by the services and Model Registry:

- `apps/identity/openapi.yaml` — Identity contract;
- `apps/core/openapi.yaml` — Core Kernel contract;
- immutable `mct_*` Model Contract revisions — ordinary model OpenAPI/JSON Schema;
- application integration policy such as `infra/homemew-integration-profile.json`.

Generated/exported artifacts are read-only handoff material. They must never become a second editable source of truth, and downstream applications must pin an explicit compatible contract combination instead of consuming an unversioned latest revision.

## HomeMew current accepted handoff

The current repository HomeMew handoff pin is:

```text
Identity:       0.6.0
Core Kernel:    0.21.0
Model Contract: mct_723249464e3b7c2f53c4ef63edd53cfc17edb57205afa63a56ba7d0bd21209bf
Profile:        infra/homemew-integration-profile.json (profileVersion 1, accepted)
```

The accepted HomeMew profile was promoted to Core Kernel 0.21.0 / Identity 0.6.0 after `Deploy staging` run #67 (`33842249069`) proved the HomeMew integration Golden Flow on that Kernel, including Event/Task CRUD, Task semantic Action, stale-version denial, governed Change attribution, real public Eventing delivery, disabled-subscriber revocation and the typed-runtime performance gate. Kernel 0.21.0 is a Candidate/Public invitation-transport security migration: invite preview/join callers carry the possession token in the JSON body instead of the URL path. Repository search found no current HomeMew application dependency on those invite preview/join routes, so this promotion requires no HomeMew application code migration.

The accepted immutable Model Contract revision is the exact staging-proven release pin and includes the HomeMew baseline Task v5, Wish v8, Day Record v2 and Event v3 semantics verified by the same deployment. A compatible Registry publication does not automatically advance this application release pin. The target release state is first deployed and validated in staging, then the explicit immutable pin is promoted and the reproducible handoff is re-proved before production deployment; production does not silently select an active/latest Model Contract.

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

The exporter requires a service-only `models:manage` bearer only to read the exact immutable `mct_*` revision from Core. That bearer is not written to the bundle. Application credentials, Service API Tokens, Webhook signing secrets, signing keys and other secret material are never handoff artifacts.

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

HomeMew's accepted model-contract pin advances only through an explicit downstream compatibility decision after the target release state has been deployed and accepted in staging. The promoted immutable pin must then pass deterministic handoff export/upload before production deployment; it never follows active/latest Registry state implicitly.

## Historical Phase-4 accepted handoff

Phase 4 originally accepted this tuple:

```text
Identity:       0.4.0
Core Kernel:    0.12.0
Model Contract: mct_9a3d9588da8591ab376ef000e5e661f670a64dd8b1ebc14fd146580f0ed1fa45
Profile:        infra/homemew-integration-profile.json (profileVersion 1, accepted at that time)
```

The Phase-4 exporter-enabled staging gate passed in `Deploy staging` run #29 (`31694445585`) and uploaded the read-only HomeMew handoff artifact after proving deterministic export and the full application/platform regression suite. This historical revision remains immutable contract evidence; it is no longer the current HomeMew release pin.
