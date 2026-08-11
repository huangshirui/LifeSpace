# Phase 2 Status — Native HomeMew capability migration

Updated: 2026-08-11

Phase 2 is **complete**. Every capability in the frozen production-used HomeMew backend baseline now has either a deployed native LifeSpace replacement or an explicit non-migration/retirement decision. Staging is the accepted verification environment; production and HomeMew production traffic remain unchanged.

## Phase 2 exit contract

HomeMew Phase 3 client migration must pin these platform contracts:

- **LifeSpace Core:** contract `0.11.0`, D1 schema `v9`.
- **LifeSpace Identity:** contract `0.3.0`, D1 schema `v4`.
- Native Core paths use `Space`, membership, Space Person and Data Grant semantics. No HomeMew `/api/v1/families/...` compatibility façade is part of the target contract.
- HomeMew product UI may continue to say family/member; its application data layer must translate to the native LifeSpace model.

## Direction reset retained

The post-Phase-2.6 architecture decision remains authoritative:

- Do not add HomeMew legacy runtime routes, response façades or legacy token verification to LifeSpace.
- Keep deterministic migration mappings/transforms and audit reports where IDs/models change.
- Keep HomeMew-only product rules in the HomeMew application boundary unless they are deliberate platform invariants.
- Application-specific external identity mappings such as WeChat `openid -> LifeSpace user_id` stay in the HomeMew adapter/BFF boundary.

## Completed capability slices

### Platform baseline and family Space policy

- [x] Global Identity, registered applications and trusted-backend token exchange.
- [x] Space, membership, Space Person, roles, Data Grants and application-scope authorization.
- [x] Family-kind timezone, member-limit, role mutation, leave/remove and invitation lifecycle.
- [x] Deterministic `family -> Space`, membership and Space Person migration mappings.

### Events, Tasks, Day Records and Wishes

- [x] Space-owned Events with Space Person attendees, search/filter/pagination, optimistic concurrency and soft deletion.
- [x] Space-owned Tasks with Space Person assignees, pending/completed/cancelled lifecycle, search/filter and optimistic concurrency.
- [x] Space-owned Day Records/occurrences with elapsed/countdown/cycle semantics, Space-timezone dates and historical Person refs.
- [x] Space-owned Wishes with owner/claimant/fulfiller Space Person refs and full lifecycle semantics.
- [x] Deterministic HomeMew schema-v11 transforms and semantic validation for all durable domain records above.

### Native-only convergence

- [x] Retire `/api/v1/families...`, `/api/v1/family-invites...` and `/api/v1/me/families` from Core runtime and canonical OpenAPI.
- [x] Remove compatibility-only response schemas, runtime user-to-Person translation and HomeMew client allowlists.
- [x] Keep `legacy_homemew_*` mappings only as migration/audit artifacts.
- [x] Canonical contract checks reject retired HomeMew paths and `Legacy*` schemas.

### User profile + R2 avatars/objects

- [x] Identity owns global user profile and user avatar metadata/API.
- [x] Core owns Space avatar metadata/API.
- [x] Shared environment assets R2 uses service-owned `avatars/users/...` and `avatars/spaces/...` namespaces; raw object keys are not public contract fields.
- [x] Safe avatar replacement and deterministic HomeMew `object-copy-manifest.json` migration behavior are implemented and staging verified.

### External integrations / service authentication

- [x] Identity-owned `svc_*` service principals.
- [x] Persistent/revocable opaque `lsp_pat_*` Service API Tokens with hash-only storage and one-time plaintext issuance.
- [x] Optional OAuth 2.0 `client_credentials` for the same service-principal model.
- [x] Core opaque-token introspection through Identity Service Binding plus normal RS256 JWT verification.
- [x] Service authority is scope ceiling × current Data Grant × domain authorization; service principals are not Space members.
- [x] HomeMew integration migration emits service-principal/Data-Grant artifacts and credential-rotation reports without copying `hmw_pat_*` or secret hashes.
- [x] Staging verifies immediate Grant/PAT revocation behavior.

### Creation Draft / Queue

**Status: Core `0.11.0` / schema `v9` deployed and verified in staging on 2026-08-11 through PR #19.**

- [x] Native `/api/v1/spaces/{spaceId}/creation-drafts...` enqueue/poll/choose-kind workflow.
- [x] User-interactive workflow is limited to an active user Space member with `creation-drafts:read/write`; service principals are intentionally unsupported.
- [x] Event/Task/Day Record draft people resolve to native Space Person IDs.
- [x] Queue producer/consumer uses generation claims and retry-safe transitions.
- [x] Existing environment-isolated Creation Draft Queue is bound to Core.
- [x] AI rate limit is re-provisioned as ephemeral policy state; counters are not migrated.
- [x] OpenAI-compatible structured-output provider is environment-configured rather than tied to a HomeMew-specific model/API key.
- [x] Draft/job state has a 24-hour TTL; terminal ready/failed state erases source input and hourly cleanup physically removes expired jobs.
- [x] Historical HomeMew Creation Draft jobs and in-flight Queue messages are explicitly **not migrated** because they are ephemeral.
- [x] Workers/D1 tests cover enqueue, polling, processing, choose-kind ownership, Person resolution and expiry cleanup.
- [x] Real staging smoke verifies Queue delivery reaches a terminal `ready`, `choose_kind` or expected `AI_*` failure state.
- [x] Staging auth smoke preserves the active signing-key pair during normal deployments and only repairs mismatched/missing keys with convergence probing.

## Final native parity sweep

The frozen HomeMew baseline contains 13 production capability groups:

1. system probes;
2. user profile/avatar;
3. family listing/profile;
4. members;
5. invitations;
6. family avatar;
7. events;
8. tasks;
9. day records;
10. wishes;
11. external integrations/credentials;
12. Creation Draft / Queue;
13. trusted internal user creation.

All 13 now have deployed native replacements. Cross-cutting search/filter/pagination, optimistic concurrency, soft deletion, request tracing, schema/contract probes, R2 migration, credential rotation and authorization semantics are covered by the corresponding native slices and automated/staging verification.

The frozen released baseline explicitly has **no implemented anniversary, notification, outbound webhook or general attachment API**. Those are future LifeSpace/HomeMew capabilities, not Phase 2 cutover blockers.

## Phase 2 exit gate

- [x] Every production-used HomeMew backend capability has a tested and staging-deployed native LifeSpace replacement.
- [x] Every durable baseline data set has a deterministic migration transform or explicit retirement decision.
- [x] Required R2 object migration behavior is deterministic and verifiable.
- [x] Required external integration/service authentication uses the final LifeSpace service-principal/Data-Grant model.
- [x] Creation Draft ephemeral state has an explicit non-migration decision and a native queue-backed replacement.
- [x] Compatibility-only runtime routes/contracts are absent from the target staging runtime.
- [x] Canonical Core/Identity contracts expose the implemented native capability set needed by the HomeMew client.
- [x] HomeMew can enter Phase 3 without depending on planned-only LifeSpace endpoints or a legacy HomeMew compatibility façade.

## Next phase

**Phase 3 — HomeMew native client migration.**

HomeMew must adapt its Mini Program/cloud functions/integration management to Core `0.11.0` + Identity `0.3.0`, including native Space/Person IDs, LifeSpace token exchange, profile/avatar ownership, service credentials/Data Grants and native Creation Draft APIs. No production traffic cutover occurs merely by completing Phase 2.
