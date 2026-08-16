# HomeMew -> LifeSpace one-shot migration

This directory contains the deliberately small one-shot HomeMew -> LifeSpace migration used for the completed Phase 5 staging rehearsal and the controlled Phase 7 production cutover.

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

The default target remains LifeSpace staging. Production is selected only with the explicit environment guard:

```text
LIFESPACE_MIGRATION_TARGET=production
HOMEMEW_PRODUCTION_MIGRATION_CONFIRMATION=MIGRATE_HOMEMEW_PRODUCTION
```

Production `rehearse` is rejected. Phase 7 must capture a final frozen source snapshot first and then invoke `migrate` explicitly through `.github/workflows/homemew-production-cutover.yml`.

Required runtime environment for migration includes:

```text
CLOUDFLARE_ACCOUNT_ID
HOMEMEW_D1_API_TOKEN or CLOUDFLARE_API_TOKEN
LIFESPACE_APPLICATION_SECRET
```

The HomeMew source D1 is pinned to the frozen production source. The target URLs are canonical and selected only from `LIFESPACE_MIGRATION_TARGET`: staging uses `auth-staging.aisr.online` / `core-staging.aisr.online`; production uses `auth.aisr.online` / `core.aisr.online`.

## Phase 5 staging rehearsal

The completed Phase 5 rehearsal used a temporary HomeMew staging application credential, uploaded only the migration report, revoked the temporary credential, and kept the snapshot only on the ephemeral runner. See `docs/phase5-migration-tooling-plan.md` and `docs/phase5-status.md` for the evidence and accepted target tuple.

## Phase 7 production cutover

The production workflow has two modes:

- `preflight` is read-only. It requires the LifeSpace production empty-target gate, validates a HomeMew source snapshot, validates the exported legacy WeChat `identity_mappings`, confirms the production HomeMew backend already has `WECHAT_APP_SECRET`, and confirms `homemew.aisr.online` still targets the legacy Core.
- `cutover` repeats those gates, deploys a reversible write-freeze version to the legacy `homemew-core`, captures the final source snapshot, migrates once, requires `migration-report.json = PASS`, derives the old `openid -> new LifeSpace usr_*` continuity map, hands the final application credential and continuity map directly to `homemew-backend-production` as Cloudflare Worker Secrets, and only then switches `homemew.aisr.online`.

The workflow requires the production-environment secret `HOMEMEW_WECHAT_IDENTITY_MAPPINGS_JSON`. It must contain the legacy WeChat Cloud Database `identity_mappings` export as either a JSON array or an object containing a `data` or `records` array. Each row must contain `openid` and `homemewUserId`. Raw openids and the derived continuity map are never committed or uploaded as artifacts.

If cutover fails before new production writes are accepted, the workflow attempts to restore the legacy custom domain and roll `homemew-core` back from its temporary write-freeze version. A failed/partial LifeSpace migration is never resumed incrementally.

## Scope

The migration preserves current operational state: active users/families/memberships, current Event/Task/Day Record/Wish records and Person relations, Day Record occurrence dates/manual notes, and current avatars.

Inactive/deleted state, invitation history, Creation Draft jobs, transient OAuth state, old record versions and historical audit timestamps/actors are not imported. If active state cannot be represented by the accepted LifeSpace APIs without changing its business meaning, the run fails instead of silently rewriting it.

Legacy external-system credentials are never copied. Their definitions are reported for later LifeSpace service-principal/Data Grant/new-credential provisioning.

## Safety

- HomeMew source D1 queries are read-only.
- Production migration is impossible without an explicit target and confirmation value.
- Production `rehearse` is disabled.
- Production/user snapshots are never committed or uploaded as workflow artifacts.
- The final `lsa_*` and provider continuity map are stored only as Cloudflare Worker Secrets.
- No dual-write, CDC, incremental catch-up or resume mode exists.
- `migration-report.json` must be `PASS` before final credential handoff or domain cutover.
- The old HomeMew Core/D1 remains frozen/read-only after a successful cutover for stabilization and rollback evidence.
