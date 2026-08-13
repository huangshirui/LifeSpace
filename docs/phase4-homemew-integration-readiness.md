# Phase 4 — HomeMew Integration Readiness

Status: **In progress — application boundary staging-verified; handoff export pending final gate**

Updated: 2026-08-13

## 1. Goal

Phase 4 makes LifeSpace's final application-facing platform surface explicit and staging-verifiable for the redesigned HomeMew Mini Program + Cloudflare backend.

This phase changes **LifeSpace only**. It does not adapt the old HomeMew Mini Program or WeChat Cloud Functions, migrate HomeMew durable production data, deploy LifeSpace production, or switch HomeMew production traffic.

The Phase 4 output is an integration contract that HomeMew can consume independently and that Phase 5 migration tooling can target without inventing application-specific platform behavior.

## 2. Entry baseline

Phase 3 is complete, including metadata-driven Generic Runtime, typed physical storage, current-state authorization, deterministic Model Contracts and the representative APAC performance gate.

Phase 4 starts from the following proving combination:

```text
Core Kernel Contract: 0.12.0
Core D1 schema:        24
Identity Contract:    0.4.0
Identity D1 schema:   4
Model Contract:       mct_9a3d9588da8591ab376ef000e5e661f670a64dd8b1ebc14fd146580f0ed1fa45
```

The Model Contract revision remains a proving revision until the complete Phase 4 exit gate accepts a concrete revision for HomeMew handoff.

## 3. HomeMew application integration profile

The machine-readable Phase 4 profile is `infra/homemew-integration-profile.json`.

Until Phase 4 closes it is marked `phase4-candidate`. The exit gate freezes the accepted values and changes the handoff status; downstream HomeMew code must not infer an unversioned `latest` contract.

### Trusted backend boundary

The redesigned HomeMew Cloudflare backend owns WeChat provider integration and the mapping:

```text
trusted WeChat openid
  -> HomeMew-owned mapping
  -> LifeSpace usr_*
```

After resolving that mapping, the backend authenticates to LifeSpace Identity with a server-only `lsa_*` trusted-application credential and calls `POST /internal/v1/tokens` to obtain a short-lived HomeMew-app-scoped user token.

The Mini Program must never receive an `lsa_*` credential and must never be trusted to assert an arbitrary LifeSpace `user_id` directly to Identity.

`lsa_*` is the explicit application authorization mechanism. HTTPS and a same-account Cloudflare Service Binding are transport choices only. A Service Binding may be adopted to reduce network overhead, but it does not replace application identity, scope ceilings, credential rotation or revocation. Any later replacement mechanism requires a separately approved trust model with equivalent properties.

### User token policy

Candidate HomeMew application policy:

- client type: `mini_program`;
- trusted backend: enabled;
- access-token TTL: 900 seconds (15 minutes);
- allowed user scopes:
  - `profile:read`;
  - `profile:write`;
  - `spaces:read`;
  - `spaces:write`;
  - `spaces:manage`;
  - `resources:read`;
  - `resources:write`;
  - `creation-drafts:read`;
  - `creation-drafts:write`.

The 900-second value is the LifeSpace access-token lifetime, not the HomeMew/WeChat login-session lifetime. A trusted HomeMew backend may transparently obtain a fresh short-lived user token after it has resolved the authenticated WeChat identity to the corresponding LifeSpace user.

`models:manage` is explicitly forbidden from ordinary HomeMew user tokens. Model Registry / AI Admin authority remains a separate platform-administration path.

Identity derives token `azp` from the authenticated `lsa_*` credential and rejects scopes outside the current registered application ceiling.

### Application × Model Access

Candidate HomeMew model access is:

| Model | Maximum access |
| --- | --- |
| Task (`task`) | `write` |
| Wish (`wish`) | `write` |
| Day Record (`day_record`) | `write` |
| Event (`event`) | `write` |

This catalog is independent of stable `resources:*` token scopes. Effective access still intersects current Space membership/Data Grants, Application × Model Access, model access requirements and Policy/Capability rules.

## 4. Frozen capability review

Phase 4 rechecks the Phase-2 parity matrix against the final Phase-3 runtime rather than against removed Phase-2 dedicated domain implementations.

Required HomeMew platform surfaces are:

| Capability | Final LifeSpace surface | Phase 4 state |
| --- | --- | --- |
| User profile/avatar | Identity `/api/v1/me` + user avatar asset | Native surface retained; HomeMew-scoped profile access staging-verified |
| Family | `Space(kind=family)` | Native Kernel surface retained and covered by platform staging regression |
| Membership / represented people | Membership + Space Person | Native Kernel surface retained and covered by platform staging regression |
| Invitations | Space invitations | Native Kernel surface retained and covered by platform staging regression |
| Family avatar | Core Space avatar | Native surface retained; staging regression passed |
| Events | metadata-driven Event + Calendar Capability | Final Phase-3 runtime; staging proving-model regression passed |
| Tasks | metadata-driven Task + Workflow | Final Phase-3 runtime; staging proving-model regression passed |
| Day Records | metadata-driven Day Record + Temporal Capability | Final Phase-3 runtime; staging proving-model regression passed |
| Wishes | metadata-driven Wish + Policy/Workflow | Final Phase-3 runtime; staging proving-model regression passed |
| Creation Draft | Registry-driven Creation Draft / Queue | Final Registry-driven surface; staging Queue regression passed |
| Owner-controlled integrations | service principal + `lsp_pat_*` + Data Grant | Native service-auth surface retained; staging regression passed |
| OAuth service integrations | service principal + OAuth `client_credentials` + Data Grant | Native service-auth surface retained; staging regression passed |
| Trusted application user exchange | `lsa_*` -> short-lived app-scoped user token | Identity 0.4.0; HomeMew-specific staging gate passed |

A capability is not considered missing merely because its Phase-2 handwritten route no longer exists. The final metadata-driven contract and runtime are authoritative.

No frozen HomeMew capability currently requires a legacy LifeSpace compatibility route or an additional HomeMew-specific Core runtime implementation.

## 5. Phase 4 staging gate

`Deploy staging` must prove a dedicated HomeMew-like application boundary in addition to the generic platform smoke tests.

The HomeMew integration verifier establishes that:

1. staging contains the canonical HomeMew staging application registration with the exact profile policy;
2. a fresh `lsa_*` credential can exchange an already-resolved active `usr_*` for a short-lived user token;
3. token `azp`, subject, principal type, scope set and TTL match the profile;
4. requesting `models:manage` or another scope outside the HomeMew ceiling is rejected;
5. the HomeMew application has exactly the required Application × Model Access rows for the proving HomeMew model set;
6. the HomeMew-scoped token can read Identity profile and reach Core using the existing authenticated Space membership;
7. the four HomeMew ordinary model routes authorize through the HomeMew application catalog;
8. replacement/revocation semantics remain proven by the generic Identity application-credential lifecycle verifier;
9. no application credential plaintext or secret hash appears in metadata output.

The gate must not grant `models:manage` to the HomeMew application merely to make platform-admin regression convenient.

### Successful application-boundary run

The first complete Phase-4 application-boundary gate passed on 2026-08-13:

- workflow: `Deploy staging`;
- run: #28;
- GitHub Actions run ID: `31692421666`;
- branch: `phase4-homemew-integration-readiness`;
- tested commit: `489977b97d6483915c2f33e9287231b27ef829e2`;
- result: **success**.

The run verified Core `0.12.0` / schema `24`, Identity `0.4.0` / schema `4`, active Model Contract `mct_9a3d9588da8591ab376ef000e5e661f670a64dd8b1ebc14fd146580f0ed1fa45`, `azp=app_homemew_staging`, the exact 900-second user-token TTL and scope set, `models:manage` rejection, four-model `write` access, Identity profile access, Core membership context, credential redaction/revocation, proving-model behavior and Registry-driven Creation Draft behavior.

This run establishes the application authorization boundary. A newer branch commit is still required to pass after the contract handoff exporter is added.

## 6. Contract handoff

HomeMew will consume an explicit compatible tuple:

```text
Identity Contract
+ Core Kernel Contract
+ Model Contract revision
+ HomeMew integration profile
```

The repository-owned canonical contracts remain `apps/identity/openapi.yaml`, `apps/core/openapi.yaml` and the immutable generated Model Contract revision. Any HomeMew snapshot/package is generated/read-only handoff material, not a second source of truth.

`packages/contracts` now implements the Phase-4 HomeMew handoff exporter. It verifies the deployed Identity/Core versions, retrieves the **exact profile-pinned `mct_*` revision** through the service-only Model Admin contract-read API, and exports:

- Identity OpenAPI;
- Core Kernel OpenAPI;
- Model Contract OpenAPI;
- Model Contract JSON Schema;
- Model Contract manifest;
- HomeMew integration profile;
- deterministic handoff manifest;
- SHA-256 checksums and a deterministic `hmb_*` bundle id.

No `lsa_*`, `lsp_pat_*`, signing key, bootstrap secret or Model Admin bearer is written into the artifact. The Model Admin bearer exists only while the exporter reads the immutable pinned contract revision.

The normal staging workflow uploads `packages/contracts/dist/homemew` as a read-only workflow artifact after the integration/platform gates pass. A final successful run on the exporter-enabled commit is required before the Phase-4 contract tuple can be marked accepted.

Phase 4 may still create a newer compatible `mct_*` if a genuine integration gap is found. The accepted revision is frozen only when the exit gate passes.

## 7. Exit gate

Phase 4 closes only when all of the following are true:

- the final HomeMew trusted-backend boundary is documented and staging-verified;
- the HomeMew application scope ceiling and token TTL are explicit and least-privilege;
- `models:manage` and other platform-admin authority are absent from HomeMew user tokens;
- HomeMew Application × Model Access is explicit and verified;
- every frozen HomeMew backend capability has a final native LifeSpace surface or an explicit approved retirement decision;
- Identity/Core Kernel versions and one Model Contract revision are accepted for HomeMew handoff;
- reproducible/read-only handoff artifacts can be generated for the HomeMew project;
- repository checks and the normal `Deploy staging` workflow pass on the exporter-enabled Phase-4 candidate;
- no criterion requires modifying the old HomeMew Mini Program or WeChat Cloud Functions;
- production and HomeMew production traffic/data remain untouched.

Current remaining blocker: **run the normal staging gate on the exporter-enabled PR head, confirm the uploaded handoff artifact and its deterministic checksum manifest, then freeze the accepted contract tuple.**

Phase 5 then owns deterministic one-shot migration tooling and rehearsal against this accepted final surface.
