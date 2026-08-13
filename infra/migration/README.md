# HomeMew -> LifeSpace one-shot migration

Phase 5 keeps only the operational files needed to run one controlled HomeMew -> LifeSpace migration rehearsal.

The implementation is intentionally small:

- `homemew-one-shot.mjs` — read HomeMew with SELECT-only D1 queries, migrate through existing LifeSpace APIs, then verify the created state;
- one `migration-report.json` per run;
- no reusable migration framework, resume mode, dual-write, CDC or incremental synchronization.

## Commands

```bash
node infra/migration/homemew-one-shot.mjs snapshot
node infra/migration/homemew-one-shot.mjs migrate --source .migration/homemew-snapshot.json
# equivalent one-command rehearsal
node infra/migration/homemew-one-shot.mjs rehearse
```

The script is purpose-built and pins the HomeMew source plus LifeSpace staging endpoints already committed in the repositories. Generated `.migration/*` files are ignored by git.

Required runtime environment:

```text
CLOUDFLARE_ACCOUNT_ID
HOMEMEW_D1_API_TOKEN or CLOUDFLARE_API_TOKEN
LIFESPACE_APPLICATION_SECRET
```

For the branch rehearsal, `Deploy staging` creates a temporary credential for the accepted HomeMew staging application, runs the script, uploads only the migration report, and revokes that temporary credential. The snapshot remains only on the ephemeral runner.

## Scope

The script preserves current operational state: active users/families/memberships, current Event/Task/Day Record/Wish records and Person relations, Day Record occurrence dates/manual notes, and current avatars.

Inactive/deleted state, invitation history, Creation Draft jobs, transient OAuth state, old record versions and historical audit timestamps/actors are not imported. If active state cannot be represented by the accepted LifeSpace APIs without changing its business meaning, the run fails instead of silently rewriting it.

## Safety

- HomeMew source queries are read-only.
- The target is LifeSpace staging only.
- Production/user snapshots are never committed or uploaded as workflow artifacts.
- Legacy integration credentials are not copied; the report records re-provisioning work instead.
- Partial migration is failure; a failed staging attempt is not resumed incrementally.

See `docs/phase5-migration-tooling-plan.md` and `docs/phase5-status.md` for the accepted target tuple and exit gate.
