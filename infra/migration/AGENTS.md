# HomeMew One-shot Migration Agent Instructions

This directory contains only the purpose-built HomeMew -> LifeSpace one-shot migration script and concise execution notes. It serves the completed Phase 5 staging rehearsal and the explicitly approved Phase 7 production cutover; it is not a reusable migration subsystem.

## Rules

- Keep the implementation specific to the frozen HomeMew source schema and accepted LifeSpace target. Do not generalize it into a migration framework without a separately approved need.
- Source HomeMew data is read-only. Never write to the source database or snapshot.
- Reject incompatible source schema, unresolved durable references, unexpected target contract state, or missing required objects.
- Sensitive authentication material is re-provisioned separately and is not part of the migration payload.
- Transform durable data directly into the final metadata-driven/typed-storage target; never recreate retired Phase-2 business tables or intermediate JSON persistence.
- Emit one consolidated `migration-report.json` with enough source-to-target mapping, counts, omissions and verification information to diagnose a run.
- Never commit production snapshots, raw WeChat `openid` exports, derived provider mappings, credentials, or other user data.
- Staging remains the default script target and is the only environment allowed to use `rehearse`.
- Production requires `LIFESPACE_MIGRATION_TARGET=production`, `HOMEMEW_PRODUCTION_MIGRATION_CONFIRMATION=MIGRATE_HOMEMEW_PRODUCTION`, and execution through the guarded Phase 7 workflow after its empty-target, source-freeze and provider-identity gates pass.
- Do not create a normal dual-write, CDC, resume or incremental catch-up path. A production source state is captured once under write freeze and must produce `migration-report.json = PASS` before application activation.
- Legacy WeChat provider identity continuity is part of cutover correctness even though it is not stored in the HomeMew D1 snapshot. Validate the separately supplied legacy `identity_mappings` export against the final snapshot, derive `openid -> new LifeSpace usr_*` only after migration PASS, and hand it directly to the HomeMew production Worker as a secret. Never print or persist raw openids in repository artifacts.
- On a pre-activation failure, restore the old HomeMew application path instead of allowing two writable sources. Partial LifeSpace migration state must be investigated/cleaned explicitly before any retry; never silently resume it.
