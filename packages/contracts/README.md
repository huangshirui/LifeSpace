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

The current cross-environment HomeMew release identity is:

```text
Identity:                   0.6.0
Core Kernel:                0.21.0
Model Semantic Fingerprint: msf_498674114e2e312c926f733ba939b49d85020a1ee14a4729b27be62bf1f774dc
Profile:                    infra/homemew-integration-profile.json (profileVersion 2, accepted)

Accepted staging mct evidence:
  mct_723249464e3b7c2f53c4ef63edd53cfc17edb57205afa63a56ba7d0bd21209bf
```

The accepted HomeMew profile was promoted to Core Kernel 0.21.0 / Identity 0.6.0 after `Deploy staging` run #67 (`33842249069`) proved the HomeMew integration Golden Flow on that Kernel, including Event/Task CRUD, Task semantic Action, stale-version denial, governed Change attribution, real public Eventing delivery, disabled-subscriber revocation and the typed-runtime performance gate. Kernel 0.21.0 is a Candidate/Public invitation-transport security migration: invite preview/join callers carry the possession token in the JSON body instead of the URL path. Repository search found no current HomeMew application dependency on those invite preview/join routes, so this promotion requires no HomeMew application code migration.

The current accepted HomeMew tuple predates the #109 split, so its historical Core pin still contains Eventing representation. It is not silently rewritten. The next HomeMew promotion on Core 0.31.0 or later must add an explicit Integration/Eventing pin; the staging-candidate exporter includes that version and contract file so staging evidence can prove the migration before the accepted profile changes.

### Cross-environment model identity

A Model Contract Revision (`mct_*`) is a content-addressed snapshot of one environment's complete published Registry. Its manifest contains environment-local monotonic Model Registry versions. Staging and production can therefore have different valid `mct_*` IDs even when the HomeMew-visible model semantics are identical.

HomeMew release compatibility across environments is consequently pinned by the canonical semantic fingerprint over the exact models HomeMew consumes. The fingerprint is SHA-256 over the model entries sorted by `key`, where each entry contains only:

```text
key
route
schemaHash
```

Environment-local model `version` and the environment-wide `mct_*` ID are deliberately excluded.

The current fingerprint covers:

```text
day_record  day-records  4b2f241958aeca05e396eea7e6719a3f030cef3ea7dfd3c57d426c086fe4cf56
event       events       6a23eb2f25463ce55d7ed75d64f0afa020d7aab25149badf28fdd77abc2d1aad
task        tasks        aaa6317b3810a20e6c4622736ec8e39e96edcd5079c6189fb5892ac54397b145
wish        wishes       ec4f99f238e44c756905d30a97f6bb5c063b783eca159dfe39f518ea58ff64b6
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

A schema/route semantic change requires an explicit HomeMew compatibility decision and a new fingerprint. A merely higher environment-local Registry version does not.

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
