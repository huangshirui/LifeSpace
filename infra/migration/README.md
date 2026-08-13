# HomeMew -> LifeSpace one-shot migration tooling

Phase 5 tooling lives here because it is operational migration infrastructure, not a reusable runtime package.

Current first slice establishes deterministic IDs/checksums and the migration-plan envelope. Later slices add read-only HomeMew D1 snapshot inspection, final-schema transforms, target import, R2 copy and full verification.

## Safety

- Never point Phase-5 rehearsal commands at LifeSpace production.
- Source HomeMew snapshots are read-only inputs.
- Production/user data must never be committed.
- Unknown schema or unresolved references are fatal.
- Secrets are rotation inputs, not migration payloads.

## Local checks

```bash
node --test infra/migration/test/*.test.mjs
```

The accepted target contract tuple is defined in `manifest.mjs` and must match `infra/homemew-integration-profile.json` plus the Phase-4 accepted contract before import tooling is allowed to mutate a target.
