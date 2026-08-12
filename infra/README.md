# LifeSpace Infrastructure

LifeSpace keeps production and staging platform resources isolated. Current platform service endpoints are:

```text
Production
  auth.aisr.online -> Identity Worker
  core.aisr.online -> Core Worker

Staging
  auth-staging.aisr.online -> Identity Worker
  core-staging.aisr.online -> Core Worker
```

Application domains such as ALOHA and HomeMew remain owned by their application repositories and may use a same-origin BFF that reaches Core through a Service Binding.

## GitHub Actions

Long-lived workflows are intentionally small:

- `Check`: repository CI for pull requests and pushes to `main`.
- `Deploy staging`: manual staging migration, Core/Identity deployment, convergence checks and authenticated platform regression.

Phase-specific one-shot workflows should be removed after their closeout evidence is recorded rather than left as permanent operator entrypoints.

`Deploy staging` derives expected Core/Identity contract and schema versions from the repository (`package.json` plus the latest numbered migration) through `infra/scripts/staging-expectations.mjs`. This prevents workflow gates from silently retaining an older phase's version constants.

The authenticated staging regression uses ephemeral staging-only credentials and Application × Model access, exercises the proving models plus Registry-driven Creation Draft, then revokes/disables temporary service authority and removes temporary model access best-effort. It never targets production.

## Staging scripts

- `resolve-staging-d1.mjs`: resolves staging D1 bindings.
- `ensure-staging-domains.mjs`: verifies/repairs staging custom domains.
- `staging-expectations.mjs`: derives repository-owned expected contract/schema versions and proving-model baseline.
- `prepare-staging-smoke.mjs`: prepares masked ephemeral staging principals/tokens/Space/model access.
- `verify-staging-db.mjs`: verifies staging schema/platform persistence/active model contract state.
- `verify-staging-http.mjs`: verifies authenticated Kernel/Model Contract/Model Admin boundaries.
- `verify-staging-models.mjs`: verifies Task/Wish/Day Record/Event platform semantics.
- `verify-staging-creation-draft.mjs`: verifies Registry-driven Creation Draft + Queue terminal behavior.
- `cleanup-staging-smoke.mjs`: revokes temporary authority best-effort.

Historical phase plans/status documents remain audit evidence, but they are not deployment runbooks after their phase is closed.
