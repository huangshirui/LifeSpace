# HomeMew -> LifeSpace one-shot migration

Phase 5 keeps only the operational files needed to rehearse and later repeat one controlled HomeMew -> LifeSpace migration.

This directory is not a reusable migration framework. The intended final shape is intentionally small:

- one purpose-built migration script for the frozen HomeMew source schema and accepted LifeSpace target;
- one consolidated `migration-report.json` per run;
- concise staging/production execution notes.

## Safety

- HomeMew source snapshots are read-only inputs.
- Phase-5 rehearsal commands must reject LifeSpace production targets.
- Production/user data must never be committed.
- Incompatible source schema, unresolved durable references and required object mismatches are fatal.
- Legacy credentials are re-provisioned rather than copied.
- Partial migration is failure.

The accepted target tuple is the Phase-4 HomeMew integration tuple documented in `docs/phase5-migration-tooling-plan.md`.
