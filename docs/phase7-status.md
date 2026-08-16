# Phase 7 Status

Updated: 2026-08-16

Status: **In progress — production cutover tooling prepared; production write freeze/migration not yet executed**

## Goal

Perform the single controlled HomeMew production migration into the already deployed LifeSpace production platform and activate the redesigned HomeMew Mini Program without dual-write.

## Preconditions already passed

- HomeMew Integration Ready milestone passed.
- Phase 5 one-shot staging rehearsal passed.
- Phase 6 isolated LifeSpace production platform is deployed and business-empty.
- Redesigned HomeMew Mini Program staging E2E passed for login, family, member/invite, Event, Task, Day Record, Wish, Creation Draft (`喵一下`) and avatar flows.
- `homemew-backend-production` and its production `WECHAT_IDENTITIES` Durable Object namespace are deployed traffic-dark with no production custom domain attached.

## Phase 7 tooling

Branch `phase7-homemew-production-cutover` adds:

- guarded production target support to `infra/migration/homemew-one-shot.mjs`;
- explicit rejection of production `rehearse`;
- `infra/scripts/phase7-homemew-identities.mjs` to validate the legacy WeChat provider mapping export and derive the post-migration `openid -> LifeSpace usr_*` continuity map without printing raw openids;
- `.github/workflows/homemew-production-cutover.yml` with separate `preflight` and `cutover` modes.

The cutover workflow enforces this order:

1. verify explicit production intent and required secrets;
2. verify LifeSpace production is still the Phase-6 empty target;
3. verify `homemew-backend-production` already has `WECHAT_APP_SECRET` but no residual cutover credential/map;
4. verify `homemew.aisr.online` still belongs to legacy `homemew-core`;
5. capture a read-only preflight HomeMew snapshot and validate the legacy WeChat `identity_mappings` export;
6. on `cutover`, deploy a reversible write-freeze version to `homemew-core` and verify the public 503 maintenance response;
7. capture the final frozen source snapshot and revalidate provider identities;
8. reconfirm LifeSpace production is empty;
9. issue a temporary HomeMew production application credential, run the one-shot migration, then revoke that temporary credential;
10. require `migration-report.json = PASS` and verified production target status;
11. derive the provider continuity map from the final snapshot + migration report;
12. issue the final HomeMew production `lsa_*` credential and install it plus the provider map directly as `homemew-backend-production` Cloudflare Worker Secrets;
13. switch `homemew.aisr.online` to `homemew-backend-production` only after all previous gates pass;
14. verify public production backend health reports `loginReady=true` and provider bootstrap configured;
15. retain legacy `homemew-core`/D1 in the frozen state for stabilization and rollback evidence.

If a cutover step fails, the workflow attempts to restore the custom domain to legacy `homemew-core`, revoke any final credential issued during the failed attempt, and roll the legacy Worker back from its temporary freeze version. A partial LifeSpace migration is never resumed automatically.

## Provider identity continuity

The existing production Mini Program's `openid -> HomeMew user` mappings live in the legacy WeChat Cloud Database collection `identity_mappings`, not in the HomeMew D1. Ignoring that state would cause returning WeChat users to be treated as new identities after cutover.

Phase 7 therefore requires the production-environment secret:

```text
HOMEMEW_WECHAT_IDENTITY_MAPPINGS_JSON
```

It contains the legacy `identity_mappings` export as a JSON array, or an object containing `data`/`records`. Each row must contain `openid` and `homemewUserId`.

The workflow validates the export against the frozen HomeMew snapshot, combines it with `migration-report.json` user mappings, and derives `openid -> new LifeSpace usr_*`. That derived value is handed directly to `homemew-backend-production` as the server-only `WECHAT_IDENTITY_BOOTSTRAP_MAP` secret. On a returning user's first login, the HomeMew Durable Object persists the migrated LifeSpace user mapping instead of creating a duplicate user.

Raw provider mappings are not committed and are not uploaded as workflow artifacts.

## Remaining manual production prerequisites

Before running `cutover`:

1. configure `WECHAT_APP_SECRET` directly on Cloudflare Worker `homemew-backend-production`;
2. export the legacy WeChat Cloud Database `identity_mappings` collection and store the JSON only as the LifeSpace GitHub `production` environment secret `HOMEMEW_WECHAT_IDENTITY_MAPPINGS_JSON`;
3. make the redesigned Mini Program version review/release-ready. `develop`/`trial` continues to use staging; only the formal `release` build selects production.

Run `HomeMew production cutover` in `preflight` mode first with confirmation `PREFLIGHT_HOMEMEW_PRODUCTION`. Only after that passes should `cutover` be run with confirmation `CUTOVER_HOMEMEW_PRODUCTION`.

## Current production state

At this status update:

- no HomeMew production source write freeze has been activated;
- no HomeMew production data has been migrated into LifeSpace production by Phase 7;
- no final HomeMew production LifeSpace credential has been issued;
- `homemew.aisr.online` has not been switched to the new backend;
- the old HomeMew production application remains the writable source of truth.
