# HomeMew -> LifeSpace one-shot migration

This directory contains the deliberately small HomeMew -> LifeSpace one-shot migration used for the completed Phase 5 staging rehearsal and the completed Phase 7 production cutover.

The implementation remains intentionally narrow:

- `homemew-one-shot.mjs` — read HomeMew with SELECT-only D1 queries, migrate through existing LifeSpace APIs, then verify the created state;
- one `migration-report.json` per run;
- no reusable migration framework, resume mode, dual-write, CDC or incremental synchronization.

## Commands

```bash
node infra/migration/homemew-one-shot.mjs snapshot
node infra/migration/homemew-one-shot.mjs migrate --source .migration/homemew-snapshot.json
# staging rehearsal only
node infra/migration/homemew-one-shot.mjs rehearse
```

The script keeps staging as its default target. Production support remains guarded in code only as historical/reproducible migration tooling; the Phase 7 production execution entrypoint has been retired after successful cutover so the one-shot migration cannot be accidentally re-run.

Production selection still requires the explicit guards:

```text
LIFESPACE_MIGRATION_TARGET=production
HOMEMEW_PRODUCTION_MIGRATION_CONFIRMATION=MIGRATE_HOMEMEW_PRODUCTION
```

Production `rehearse` is rejected.

Required runtime environment for migration includes:

```text
CLOUDFLARE_ACCOUNT_ID
HOMEMEW_D1_API_TOKEN or CLOUDFLARE_API_TOKEN
LIFESPACE_APPLICATION_SECRET
```

The HomeMew source D1 is pinned to the frozen production source. The target URLs are canonical and selected only from `LIFESPACE_MIGRATION_TARGET`: staging uses `auth-staging.aisr.online` / `core-staging.aisr.online`; production uses `auth.aisr.online` / `core.aisr.online`.

## Phase 5 staging rehearsal

The completed Phase 5 rehearsal used a temporary HomeMew staging application credential, uploaded only the migration report, revoked the temporary credential, and kept the snapshot only on the ephemeral runner. See `docs/phase5-migration-tooling-plan.md` and `docs/phase5-status.md` for the evidence and accepted target tuple.

## Phase 7 production cutover — complete

The production one-shot migration completed on 2026-08-21.

Accepted migration evidence:

```text
GitHub Actions run: 32455970121
migration report:   PASS
artifact:           homemew-production-migration-report-32455970121
artifact id:        9437613506
```

Verified production counts were 4 users, 3 family Spaces, 6 Memberships/Space People, 499 Events, 22 Tasks, 5 Day Records, 5 Wishes and 5 avatar objects. Two legacy external-system definitions were accounted for re-provisioning; no legacy credential material was copied.

The WeChat `identity_mappings` export was validated against the frozen source and the derived `openid -> LifeSpace usr_*` continuity map was handed directly to `homemew-backend-production` as the server-only `WECHAT_IDENTITY_BOOTSTRAP_MAP` Secret. Raw provider identities were never committed or uploaded as artifacts.

The first traffic-activation attempt failed after migration PASS while transferring the Cloudflare Worker Custom Domain. The old route was restored and the failed activation credential was revoked. The migration was not re-run. A later read-only semantic gate verified the current legacy source against the original PASS report mappings with `semanticDrift: false` for all migrated users, Spaces, memberships, Events, Tasks, Day Records, Wishes, objects and the two recorded external-system definitions.

Final activation run `32460777350` succeeded. `homemew.aisr.online` is now attached to `homemew-backend-production`, public health reports the production HomeMew backend with `loginReady=true`, and the final production-only `lsa_*` credential remains only in the Worker Secret store.

Detailed evidence is in `docs/phase7-status.md`.

## Scope

The migration preserves current operational state: active users/families/memberships, current Event/Task/Day Record/Wish records and Person relations, Day Record occurrence dates/manual notes, and current avatars.

Inactive/deleted state, invitation history, Creation Draft jobs, transient OAuth state, old record versions and historical audit timestamps/actors are not imported. If active state cannot be represented by the accepted LifeSpace APIs without changing its business meaning, the run fails instead of silently rewriting it.

Legacy external-system credentials are never copied. Their definitions are reported for later LifeSpace service-principal/Data Grant/new-credential provisioning.

## Post-cutover safety state

- HomeMew source D1 access in the migration tool is read-only.
- Production snapshots were never committed or uploaded as workflow artifacts.
- The final `lsa_*` and provider continuity map are stored only as Cloudflare Worker Secrets.
- No dual-write, CDC, incremental catch-up or resume mode exists.
- The accepted production `migration-report.json` is `PASS`.
- The production cutover workflow and temporary activation-recovery helpers have been removed after evidence capture.
- The old HomeMew Core/D1 remains frozen/read-only for Phase 8 stabilization and rollback evidence.
