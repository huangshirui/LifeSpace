# Phase 4 — HomeMew Integration Readiness

Status: **Complete**

Completed: 2026-08-13

## 1. Outcome

Phase 4 freezes the LifeSpace application-facing surface that the redesigned HomeMew Mini Program + Cloudflare backend may consume.

This phase changed **LifeSpace only**. It did not adapt the old HomeMew Mini Program or WeChat Cloud Functions, migrate HomeMew durable production data, deploy LifeSpace production, or switch HomeMew production traffic.

The accepted handoff is explicit and version-pinned. HomeMew must not consume an unversioned latest contract.

## 2. Accepted contract tuple

The Phase-4 HomeMew handoff is frozen as:

```text
Identity Contract:    0.4.0
Identity D1 schema:   4
Core Kernel Contract: 0.12.0
Core D1 schema:       24
Model Contract:       mct_9a3d9588da8591ab376ef000e5e661f670a64dd8b1ebc14fd146580f0ed1fa45
Integration Profile:  infra/homemew-integration-profile.json (profileVersion 1, accepted)
```

The machine-readable profile has `status=accepted` and `contracts.pinStatus=accepted`.

The accepted Model Contract contains:

| Model | Route | Version | HomeMew maximum access |
| --- | --- | ---: | --- |
| Day Record | `day-records` | 1 | `write` |
| Event | `events` | 2 | `write` |
| Task | `tasks` | 2 | `write` |
| Wish | `wishes` | 3 | `write` |

Any future breaking Kernel, Identity, Model Contract or integration-profile change requires a new explicit downstream compatibility/migration decision. The accepted tuple is not replaced by an unversioned active/latest value.

## 3. Trusted HomeMew backend boundary

The redesigned HomeMew Cloudflare backend owns WeChat/provider identity and the mapping:

```text
trusted WeChat openid
  -> HomeMew-owned mapping
  -> LifeSpace usr_*
```

After resolving the mapping, the trusted HomeMew backend authenticates to LifeSpace Identity with a server-only `lsa_*` application credential and calls `POST /internal/v1/tokens` for a short-lived HomeMew-app-scoped user token.

The Mini Program must never receive the `lsa_*` credential and must never be trusted to assert an arbitrary LifeSpace user ID directly to Identity.

HTTPS and a same-account Cloudflare Service Binding are transport choices only. They do not replace explicit application identity, scope ceilings, credential rotation or revocation.

## 4. Accepted HomeMew user-token policy

The accepted policy is:

- client type: `mini_program`;
- trusted backend: enabled;
- LifeSpace access-token TTL: **900 seconds (15 minutes)**;
- allowed scopes:
  - `profile:read`;
  - `profile:write`;
  - `spaces:read`;
  - `spaces:write`;
  - `spaces:manage`;
  - `resources:read`;
  - `resources:write`;
  - `creation-drafts:read`;
  - `creation-drafts:write`;
- `models:manage` is explicitly forbidden.

The 900-second access-token TTL is independent of the HomeMew/WeChat login-session lifetime. The trusted backend may obtain a new short-lived token after resolving an authenticated WeChat identity to the corresponding LifeSpace user.

Effective resource authority remains the intersection of the verified principal, current Space/Data Grant authority, application scope ceiling, Application × Model Access and model Policy/Capability rules.

## 5. Frozen capability review

All 13 frozen HomeMew backend capability groups have a final native LifeSpace surface:

| Capability | Final LifeSpace surface | Phase-4 result |
| --- | --- | --- |
| System / principal context | Identity/Core health, status and `/api/v1/me` | Accepted |
| User profile/avatar | Identity profile + user avatar | Accepted |
| Family | `Space(kind=family)` | Accepted |
| Membership / represented people | Membership + Space Person | Accepted |
| Invitations | Space invitations | Accepted |
| Family avatar | Core Space avatar | Accepted |
| Events | metadata-driven Event + Calendar Capability | Accepted |
| Tasks | metadata-driven Task + Workflow | Accepted |
| Day Records | metadata-driven Day Record + Temporal Capability | Accepted |
| Wishes | metadata-driven Wish + Policy/Workflow | Accepted |
| Creation Draft | Registry-driven Creation Draft / Queue | Accepted |
| External integrations | service principal + `lsp_pat_*` or OAuth + Data Grant | Accepted |
| Trusted application user exchange | `lsa_*` -> short-lived app-scoped user token | Accepted |

No frozen capability requires a legacy `/api/v1/families/...` compatibility route, legacy token acceptance, runtime user-ID-to-Person translation, or an additional HomeMew-specific Core runtime.

## 6. Staging evidence

### Application-boundary proof

`Deploy staging` run #28 / run ID `31692421666` passed on commit `489977b97d6483915c2f33e9287231b27ef829e2`.

It proved the dedicated HomeMew application registration, exact 900-second token TTL/scope set, `azp=app_homemew_staging`, `models:manage` rejection, four-model `write` access, Identity profile access, Core membership context, credential redaction/revocation and final proving-model/Creation-Draft behavior.

### Exporter-enabled final gate

`Deploy staging` run #29 / run ID `31694445585` passed on commit `76499060dd736655b218b1a1e00902fb7d988682`.

Every workflow step passed, including:

- repository validation;
- Core/Identity migration and staging convergence;
- HomeMew integration readiness verifier;
- active immutable Model Contract pointer;
- final proving-model platform regression;
- typed-runtime performance measurement;
- Registry-driven Creation Draft Queue;
- **Export and prove pinned HomeMew handoff reproducibility**;
- **Upload HomeMew contract handoff**.

The uploaded workflow artifact is:

```text
artifact id:   9178811267
artifact name: homemew-contract-handoff-76499060dd736655b218b1a1e00902fb7d988682
artifact sha256: 7e4cf049367e8babfcd531e8973b33e09e33b62a63a79552561253ecbbda4d3e
candidate bundle id: hmb_d6f6a4ef08e7312ee702ff48e52e205956841ac01dacec58c3cca31b31b7944d
```

The bundle checksum manifest was independently rechecked during closeout: all seven hashed payloads matched. No actual `lsa_*` credential, `lsp_pat_*` credential, secret hash, signing private key or bootstrap secret was present. `clientSecret` text in Identity OpenAPI is only a write-only schema/property definition, not credential material.

The staging artifact was generated immediately before the publication-state flip from candidate to accepted. The closeout flip changes only `status` / `pinStatus`; it does not change the accepted contract versions, Model Contract, scopes, TTL, model access, routes or runtime behavior. Final repository CI validates the accepted profile after this flip.

## 7. Reproducible handoff

`packages/contracts` is the read-only publication/export surface. The HomeMew exporter reads the **exact profile-pinned `mct_*`**, never an active/latest contract, and exports:

- Identity OpenAPI;
- Core Kernel OpenAPI;
- Model Contract OpenAPI;
- Model Contract JSON Schema;
- Model Contract manifest;
- HomeMew integration profile;
- handoff manifest;
- SHA-256 checksum manifest with deterministic `hmb_*` bundle identity.

Canonical sources remain service-owned; generated artifacts are not a second editable source of truth.

## 8. Exit gate

Phase 4 is complete because:

- the trusted HomeMew backend boundary is explicit and staging-verified;
- the HomeMew scope ceiling and 900-second access-token TTL are explicit and least-privilege;
- platform-admin `models:manage` authority is excluded;
- Task/Wish/Day Record/Event Application × Model Access is explicit and verified;
- all frozen HomeMew backend capabilities have final native LifeSpace surfaces;
- Identity `0.4.0`, Core Kernel `0.12.0` and one immutable Model Contract revision are accepted;
- reproducible/read-only handoff generation and upload are staging-proven;
- repository validation passed on the exporter-enabled candidate and is required again for the accepted closeout commit;
- production and HomeMew production traffic/data were untouched.

## 9. Boundary after Phase 4

Phase 4 completion does **not** mean the broader `HomeMew Integration Ready` milestone is complete. That milestone also requires the separately planned Phase 5 migration tooling/rehearsal gate defined in `docs/migration-plan.md`.

**Phase 5 remains Planned and is not started by this closeout.**
