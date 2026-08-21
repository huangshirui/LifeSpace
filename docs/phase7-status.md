# Phase 7 Status — HomeMew production cutover

Updated: 2026-08-21

Status: **Complete**

## Outcome

HomeMew production durable state was migrated once from the frozen legacy HomeMew source into LifeSpace production, verified with `migration-report.json = PASS`, and the HomeMew production application domain was activated on the redesigned Cloudflare backend.

Final production routing:

```text
homemew.aisr.online -> homemew-backend-production
                       -> LifeSpace Identity: auth.aisr.online
                       -> LifeSpace Core:     core.aisr.online
```

The legacy `homemew-core` Worker and HomeMew D1 are retained frozen/read-only for the Phase 8 stabilization and rollback-evidence window. No dual-write, CDC, incremental catch-up, or second migration was introduced.

## Accepted migration evidence

The successful one-shot production migration was executed by GitHub Actions run `32455970121`.

The retained workflow artifact is:

```text
homemew-production-migration-report-32455970121
artifact id: 9437613506
```

The report recorded `PASS` for both the migration result and verification result. Verified production counts were:

- 4 users;
- 3 family Spaces;
- 6 Memberships / 6 Space People;
- 499 Events;
- 22 Tasks;
- 5 Day Records;
- 5 Wishes;
- 5 avatar objects;
- 2 legacy external-system definitions accounted for re-provisioning.

The migration used the accepted production contract tuple:

```text
Identity Contract:    0.4.0
Core Kernel Contract: 0.12.0
Core D1 schema:        24
Model Contract:       mct_9a3d9588da8591ab376ef000e5e661f670a64dd8b1ebc14fd146580f0ed1fa45
HomeMew application:  homemew-miniprogram
```

Legacy credentials were not copied into LifeSpace.

## Provider identity continuity

The production cutover validated the legacy WeChat `identity_mappings` export against the frozen active HomeMew users before migration. After migration PASS, the derived `openid -> LifeSpace usr_*` continuity map was handed directly to `homemew-backend-production` as the server-only `WECHAT_IDENTITY_BOOTSTRAP_MAP` Cloudflare Worker Secret.

Raw `openid` values and the derived map were never committed or uploaded as migration artifacts.

A fresh final `lsa_*` trusted-application credential was issued only for the production HomeMew backend and stored as the Worker Secret `LIFESPACE_APPLICATION_CREDENTIAL`. The Mini Program never receives this credential.

## Activation recovery and semantic gate

The first activation attempt completed the data migration but failed before traffic activation while transferring the existing Cloudflare Worker Custom Domain. The old HomeMew route was restored and the credential from that failed activation was revoked.

Because LifeSpace production already contained the verified migrated state, the one-shot migration was **not** run again. Before activation was retried, a read-only semantic recovery gate compared the current frozen legacy source with the already-migrated LifeSpace records using the original PASS report's source-to-target mappings.

Run `32460066401` verified:

```text
semanticDrift: false
users:         4
spaces:        3
memberships:   6
events:        499
tasks:         22
dayRecords:    5
wishes:        5
objects:       5
systems:       2
```

This proved there was no business-state delta requiring cleanup, incremental catch-up, or a second migration.

## Final production activation

Final activation run `32460777350` completed successfully.

It re-froze the legacy source, repeated the semantic drift gate, issued and installed a fresh final HomeMew application credential, detached the Custom Domain from `homemew-core`, attached it to `homemew-backend-production`, and verified both public health and Cloudflare domain ownership.

The final production checks passed with:

```text
hostname:    homemew.aisr.online
service:     homemew-backend-production
health:      ok
runtime:     homemew-backend
environment: production
loginReady:  true
```

Failure rollback steps were skipped because activation completed successfully.

## Post-cutover state

- LifeSpace production is now the authoritative writable source for migrated HomeMew business data.
- `homemew.aisr.online` serves the redesigned HomeMew production backend.
- `WECHAT_APP_SECRET`, `WECHAT_IDENTITY_BOOTSTRAP_MAP`, and the active `LIFESPACE_APPLICATION_CREDENTIAL` remain server-only Cloudflare Worker Secrets.
- The old HomeMew Core/D1 is retained frozen/read-only for stabilization and rollback evidence.
- The production one-shot/cutover workflows and temporary recovery helpers are retired after evidence capture so Phase 7 cannot be accidentally re-run.
- Real-client Mini Program production smoke validation and old-infrastructure retirement belong to Phase 8.
- The two legacy external-system definitions remain explicit re-provisioning work; legacy credential material was intentionally not migrated.

## Phase 7 exit gate

Phase 7 is complete because:

- final production source state was captured under write freeze;
- one-shot migration completed with a PASS report;
- migrated users, Spaces, Memberships/People, business resources, relations and objects were verified;
- WeChat provider identity continuity was validated and handed to the application backend without committing provider identifiers;
- a fresh production-only trusted application credential is active only in the HomeMew backend;
- production routing now targets the redesigned HomeMew backend;
- public production health and Cloudflare domain ownership both pass;
- no normal dual-write, CDC, resume, or incremental migration path exists.
