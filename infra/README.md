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

Application domains remain owned by their application repositories and may use a same-origin BFF that reaches LifeSpace through approved authenticated interfaces.

## GitHub Actions

Long-lived workflows are intentionally explicit about operation type:

- `Check`: repository CI for pull requests and pushes to `main`.
- `Provision LifeSpace platform staging resources`: low-frequency, create-if-missing reconciliation of D1/R2/Queue resources declared in the staging manifest.
- `Deploy LifeSpace platform staging`: manual staging migration, Core/Identity deployment, convergence checks and authenticated platform regression. It never provisions shared infrastructure.
- `Provision LifeSpace platform production resources`: guarded, low-frequency, create-if-missing reconciliation of D1/R2/Queue resources declared in the production manifest. It never migrates databases or deploys Workers. It is manual-only, typed-confirmation guarded and main-only.
- `Deploy LifeSpace platform production`: guarded normal production migration/deployment/verification. It never provisions infrastructure and contains no consumer-specific release gate. It is manual-only, typed-confirmation guarded and main-only.

All manual deploy/provision workflows explicitly pin `actions/checkout` to the dispatch-time immutable `github.sha`; queued runs never follow a branch that has advanced after dispatch.


Additional long-lived operator boundaries:

- `Deploy LifeSpace Console staging (isolated)` is the normal Console-only staging entrypoint. Its default job does not migrate/deploy Core or Identity or use bootstrap authority; an explicit `run_control_plane_acceptance=true` adds a separate staging-only control-plane acceptance job after deployment.
- `Converge LifeSpace staging control plane` remains a low-frequency platform/credential convergence path because it can reconcile Core/Identity, platform administrator assignment and Console executor credentials. It is not the normal Console deploy path.
- `Deploy LifeSpace Console production` remains an independent guarded Console-only production rollout.
- The APAC performance gate is an internal prerequisite job inside `Deploy LifeSpace platform production`, not a separate operator-facing workflow. It runs automatically against the exact candidate SHA before any production migration/deployment job may start.

`Deploy LifeSpace platform staging` derives expected Core/Identity contract and schema versions from the repository (`package.json` plus the latest numbered migration) through `infra/scripts/staging-expectations.mjs`. `Deploy LifeSpace platform production` does the same through `infra/scripts/production-expectations.mjs`.

Normal staging and production releases use Core-first -> Identity ordering so a newer compatible Core verifier/runtime is live before Identity may issue credentials that depend on it. The historical first production bring-up used a special Identity-first path because Core's Service Binding target did not yet exist; that exception is no longer active.

## Staging scripts

- `provision-staging.mjs`: create-if-missing D1/R2/Queue provisioning from the staging manifest; never deletes or reuses production resources.
- `resolve-staging-d1.mjs`: resolves staging D1 bindings.
- `ensure-staging-domains.mjs`: verifies/repairs staging custom domains.
- `staging-expectations.mjs`: derives repository-owned expected contract/schema versions and proving-model baseline.
- `prepare-staging-smoke.mjs`: prepares masked ephemeral staging principals/tokens/Space/model access.
- `verify-staging-db.mjs`: verifies staging schema/platform persistence/active model contract state.
- `verify-staging-http.mjs`: verifies authenticated Kernel/Model Contract/Model Admin boundaries.
- `verify-staging-models.mjs`: verifies Task/Wish/Day Record/Event platform semantics.
- `cleanup-staging-smoke.mjs`: revokes temporary authority best-effort.

## Production scripts

- `provision-production.mjs`: create-if-missing D1/R2/Queue provisioning from the production manifest; never deletes, renames, replaces or reuses staging resources. It is invoked only by **Provision LifeSpace platform production resources**.
- `resolve-production-d1.mjs`: resolves exact production D1 IDs only into the ephemeral deployment checkout.
- `ensure-production-domains.mjs`: preflights and attaches only the two approved production Worker Custom Domains; refuses to move a hostname owned by another Worker.
- `production-expectations.mjs`: derives production contract/schema expectations from the repository and pins semantic model hashes while treating Registry model versions as environment-local monotonic values.
- `initialize-production-runtime.mjs`: initializes first-use signing/shared secrets, preserves complete existing secret sets, and refuses partial automatic repair/rotation.
- `verify-production-http.mjs`: verifies production health, environment, schema and contract versions.
- `verify-production-cloudflare.mjs`: verifies D1/R2/Queue/Worker/domain/secret presence, Queue attachment/policy, and staging isolation.
- `verify-production-model-admin.mjs`: uses disposable service authority to verify `lsp_pat_*` introspection, reconcile required model semantics when safe, and prove that the production active immutable `mct_*` exactly represents the current production Registry snapshot.

Detailed operator rules are documented in `infra/staging/README.md` and `infra/production/README.md`. Historical migration evidence remains available through Git history and release artifacts rather than current runbooks.