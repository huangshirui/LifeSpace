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

Long-lived workflows are intentionally explicit about operation type:

- `Check`: repository CI for pull requests and pushes to `main`.
- `Provision staging resources`: low-frequency, create-if-missing reconciliation of D1/R2/Queue resources declared in the staging manifest.
- `Deploy staging`: manual staging migration, Core/Identity deployment, convergence checks and authenticated platform regression. It never provisions shared infrastructure.
- `Provision production resources`: guarded, low-frequency, create-if-missing reconciliation of D1/R2/Queue resources declared in the production manifest. It never migrates databases or deploys Workers.
- `Deploy production`: guarded normal production migration/deployment/verification. It never provisions infrastructure and contains no historical first-bring-up mode. Before any production migration, it requires the accepted downstream release identity to match the repository production Kernel/Identity/model semantics.

Phase-specific one-shot workflow modes are not permanent operator entrypoints. The historical Phase 6 empty-platform bring-up is complete and remains only as audit evidence in phase documents/Git history; `phase6_bringup` is not part of the long-lived production workflow.

Provisioning is a durable but low-frequency infrastructure operation rather than a deploy checkbox. When a release adds a declared Cloudflare resource, provision staging first, deploy/accept staging, provision production, then deploy production. Provisioners are idempotent create-if-missing and never delete, rename, replace or reuse resources across environments.

Deploy and provision operations for the same environment share a concurrency lock so they cannot mutate that environment at the same time.


Additional long-lived operator boundaries:

- `Deploy LifeSpace Console staging (isolated)` is the normal Console-only staging entrypoint. Its default job does not migrate/deploy Core or Identity or use bootstrap authority; an explicit `run_control_plane_acceptance=true` adds a separate staging-only control-plane acceptance job after deployment.
- `Provision LifeSpace Console staging` remains a low-frequency platform/credential convergence path because it can reconcile Core/Identity, platform administrator assignment and Console executor credentials. It is not the normal Console deploy path and should shrink further with bootstrap-surface work tracked in #93.
- `Deploy LifeSpace Console production` remains an independent guarded Console-only production rollout.
- The APAC performance gate is an internal prerequisite job inside `Deploy production`, not a separate operator-facing workflow. It runs automatically against the exact candidate SHA before any production migration/deployment job may start.
- Product-owned staging workflows are not retained in this platform repository after the product environment is retired. HomeMew Web staging provisioning was removed in #261; application-specific deployment belongs to the HomeMew repository.


`Deploy staging` derives expected Core/Identity contract and schema versions from the repository (`package.json` plus the latest numbered migration) through `infra/scripts/staging-expectations.mjs`. `Deploy production` does the same through `infra/scripts/production-expectations.mjs`.

Normal staging and production releases use Core-first -> Identity ordering so a newer compatible Core verifier/runtime is live before Identity may issue credentials that depend on it. The historical first production bring-up used a special Identity-first path because Core's Service Binding target did not yet exist; that exception is no longer active.

Historical Phase 6 verification used short-lived probe authority, removed probe users/applications/service principals/tokens after verification, and left HomeMew with a registered production application but no active cutover credential. That behavior is historical evidence, not part of normal deployment.

## Staging scripts

- `provision-staging.mjs`: create-if-missing D1/R2/Queue provisioning from the staging manifest; never deletes or reuses production resources.
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

- `provision-production.mjs`: create-if-missing D1/R2/Queue provisioning from the production manifest; never deletes, renames, replaces or reuses staging resources. It is invoked only by **Provision production resources**.
- `resolve-production-d1.mjs`: resolves exact production D1 IDs only into the ephemeral deployment checkout.
- `ensure-production-domains.mjs`: preflights and attaches only the two approved production Worker Custom Domains; refuses to move a hostname owned by another Worker.
- `production-expectations.mjs`: derives production contract/schema expectations from the repository and pins semantic model hashes while treating Registry model versions as environment-local monotonic values.
- `check-production-release-readiness.mjs`: fail-closed pre-mutation gate that requires the accepted HomeMew Core/Identity pins and Model Semantic Fingerprint to match the repository production release. Platform code may enter `main` and be proven in staging before this downstream promotion occurs; production remains blocked until the accepted release identity is explicitly advanced.
- `initialize-production-runtime.mjs`: initializes first-use signing/shared secrets, preserves complete existing secret sets, and refuses partial automatic repair/rotation.
- `homemew-contract-identity.mjs`: defines the canonical HomeMew cross-environment Model Semantic Fingerprint from model `key + route + schemaHash`; it deliberately excludes environment-local Registry versions and `mct_*` revision IDs.
- `verify-production-http.mjs`: verifies production health, environment, schema and contract versions.
- `verify-production-cloudflare.mjs`: verifies D1/R2/Queue/Worker/domain/secret presence, Queue attachment/policy, and staging isolation.
- `verify-production-model-admin.mjs`: uses disposable service authority to verify `lsp_pat_*` introspection, reconcile required model semantics when safe, and prove that the production active immutable `mct_*` exactly represents the current production Registry snapshot.
- `verify-production-homemew-contract.mjs`: proves that the production Core/Identity versions and the HomeMew-selected models inside production's own active `mct_*` match the accepted cross-environment Model Semantic Fingerprint. It does not require production to reuse staging's `mct_*` ID.
- `verify-production-homemew-auth.mjs` and `verify-production-db.mjs`: retained historical Phase 6 evidence helpers; they are not invoked by normal production deployment. The DB helper follows the same semantic-fingerprint rule so historical verification does not reintroduce cross-environment `mct_*` equality.

Detailed operator rules are documented in `infra/staging/README.md` and `infra/production/README.md`. Historical phase plans/status documents remain audit evidence, not current deployment runbooks.