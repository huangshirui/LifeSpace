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
- `Deploy production`: guarded manual production deployment. Infrastructure provisioning is disabled by default and may only be enabled during an explicit Phase 6 bring-up run.

Phase-specific one-shot workflows should be removed after their closeout evidence is recorded rather than left as permanent operator entrypoints. The production workflow therefore uses a `phase6_bringup` input for the one-time empty-platform gate; normal production deployments after Phase 6 do not run empty-state or temporary-authority checks.

`Deploy staging` derives expected Core/Identity contract and schema versions from the repository (`package.json` plus the latest numbered migration) through `infra/scripts/staging-expectations.mjs`. `Deploy production` does the same through `infra/scripts/production-expectations.mjs`.

The first production bring-up is intentionally Identity-first so that Core's Service Binding has a real target. Once both production Workers exist, normal production deployment returns to Core-first -> Identity ordering so a newer compatible Core verifier/runtime is live before Identity may issue against it.

The Phase 6 production verification uses short-lived probe authority, removes the probe users/applications/service principals/tokens after verification, and leaves HomeMew with a registered production application but no active cutover credential. The real HomeMew production `lsa_*` credential is a Phase 7 concern and must be stored in the HomeMew production secret store when issued.

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

## Production scripts

- `provision-production.mjs`: create-if-missing D1/R2/Queue provisioning; never deletes or renames production resources.
- `resolve-production-d1.mjs`: resolves exact production D1 IDs only into the ephemeral deployment checkout.
- `ensure-production-domains.mjs`: preflights and attaches only the two approved production Worker Custom Domains; refuses to move a hostname owned by another Worker.
- `production-expectations.mjs`: derives production contract/schema expectations from the repository.
- `initialize-production-runtime.mjs`: initializes first-use signing/shared secrets, preserves complete existing secret sets, and refuses partial automatic repair/rotation.
- `verify-production-http.mjs`: verifies production health, environment, schema and contract versions.
- `verify-production-cloudflare.mjs`: verifies D1/R2/Queue/Worker/domain/secret presence and staging isolation.
- `verify-production-model-admin.mjs`: uses disposable service authority to verify `lsp_pat_*` introspection and initialize/verify the accepted active Model Contract.
- `verify-production-homemew-auth.mjs`: registers the frozen HomeMew production application ID, verifies the JWT boundary, and leaves no active HomeMew credential after Phase 6.
- `verify-production-db.mjs`: Phase 6-only empty-platform database and accepted-contract gate.

Detailed operator prerequisites and the Phase 6 run mode are documented in `infra/production/README.md`.

Historical phase plans/status documents remain audit evidence, but they are not deployment runbooks after their phase is closed.
