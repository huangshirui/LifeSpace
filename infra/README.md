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
- `Deploy production`: guarded normal production migration/deployment/verification. It never provisions infrastructure and contains no historical first-bring-up mode.

Phase-specific one-shot workflow modes are not permanent operator entrypoints. The historical Phase 6 empty-platform bring-up is complete and remains only as audit evidence in phase documents/Git history; `phase6_bringup` is not part of the long-lived production workflow.

Provisioning is a durable but low-frequency infrastructure operation rather than a deploy checkbox. When a release adds a declared Cloudflare resource, provision staging first, deploy/accept staging, provision production, then deploy production. Provisioners are idempotent create-if-missing and never delete, rename, replace or reuse resources across environments.

Deploy and provision operations for the same environment share a concurrency lock so they cannot mutate that environment at the same time.

`Deploy staging` derives expected Core/Identity contract and schema versions from the repository (`package.json` plus the latest numbered migration) through `infra/scripts/staging-expectations.mjs`. `Deploy production` does the same through `infra/scripts/production-expectations.mjs`.

Normal staging and production releases use Core-first -> Identity ordering so a newer compatible Core verifier/runtime is live before Identity may issue credentials that depend on it. The historical first production bring-up used a special Identity-first path because Core's Service Binding target did not yet exist; that exception is no longer active.

Historical Phase 6 verification used short-lived probe authority, removed probe users/applications/service principals/tokens after verification, and left HomeMew with a registered production application but no active cutover credential. That behavior is historical evidence, not part of normal deployment.

## Staging scripts

- `provision-staging.mjs`: create-if-missing D1/R2/Queue provisioning from the staging manifest; never deletes or reuses production resources.
- `resolve-staging-d1.mjs`: resolves staging D1 bindings.
- `ensure-staging-domains.mjs`: verifies/repairs staging custom domains.
- `staging-expectations.mjs`: derives repository-owned expected contract/schema versions and proving-model baseline.
- `prepare-staging-smoke.mjs`: prepares masked ephemeral staging principals/tokens/Space/model access.
- `prepare-staging-web-access.mjs`: idempotently prepares a trusted LifeSpace Web application and registers one real Cloudflare Access audience after Identity is deployed.
- `verify-staging-db.mjs`: verifies staging schema/platform persistence/active model contract state.
- `verify-staging-http.mjs`: verifies authenticated Kernel/Model Contract/Model Admin boundaries.
- `verify-staging-models.mjs`: verifies Task/Wish/Day Record/Event platform semantics.
- `verify-staging-creation-draft.mjs`: verifies Registry-driven Creation Draft + Queue terminal behavior.
- `cleanup-staging-smoke.mjs`: revokes temporary authority best-effort.

### HomeMew Web Access staging provisioning

`prepare-staging-web-access.mjs` is intentionally separate from generic staging smoke authority. It provisions the durable staging application identity needed by the HomeMew Web BFF and binds the real Cloudflare Access application AUD to it.

Prerequisites:

1. `Deploy staging` has deployed the currently accepted Identity contract/schema.
2. Identity staging has the approved Cloudflare Access team domain configured through `ACCESS_TEAM_DOMAIN`.
3. The HomeMew Web staging hostname is protected by a Cloudflare Access application and its AUD is known.
4. `LIFESPACE_STAGING_BOOTSTRAP_SECRET` is available only in an operator/staging secret context.

Required input:

```text
LIFESPACE_STAGING_BOOTSTRAP_SECRET=<staging bootstrap secret>
LIFESPACE_STAGING_ACCESS_AUD=<Cloudflare Access application AUD>
```

Defaults:

```text
LIFESPACE_IDENTITY_STAGING_URL=https://auth-staging.aisr.online
LIFESPACE_STAGING_WEB_APPLICATION_ID=app_homemew_web_staging
LIFESPACE_STAGING_WEB_APPLICATION_NAME=HomeMew Web staging
```

The application is reconciled to `clientType=web`, `trustedBackend=true`, a short user-token TTL and the HomeMew user scope ceiling. Immutable `clientType` / `trustedBackend` mismatches fail closed instead of mutating an existing application into another trust class.

Initial trusted-application creation returns an `lsa_*` credential exactly once. The script refuses to create or rotate a credential unless a secure sink exists:

- in GitHub Actions, `GITHUB_ENV` is used and the generated credential is masked before it is exported for later steps;
- for an explicit local operator run, set `LIFESPACE_STAGING_WEB_CREDENTIAL_OUTPUT` to a **new temporary file outside the repository**. The file is created exclusively with mode `0600` where supported. Move the credential immediately into the HomeMew Web staging Worker secret store and delete the temporary file.

Example local invocation after the real AUD is available:

```bash
LIFESPACE_STAGING_BOOTSTRAP_SECRET='...' \
LIFESPACE_STAGING_ACCESS_AUD='...' \
LIFESPACE_STAGING_WEB_CREDENTIAL_OUTPUT='/tmp/homemew-web-staging-credential.json' \
node infra/scripts/prepare-staging-web-access.mjs
```

Do not commit the output file, copy the credential into application configuration, or reuse the Mini Program `lsa_*`. HomeMew Web and HomeMew Mini Program are separate LifeSpace application contexts even when they resolve the same global `usr_*`.

The script first verifies it is talking to staging and the expected Identity contract/schema. It then:

1. creates or reconciles `app_homemew_web_staging`;
2. verifies at least one active application credential, creating one only when a secure sink is configured;
3. lists current Access audience registrations;
4. idempotently registers the supplied AUD;
5. reports the Identity issuer/AUD/application binding without printing secret material.

If audience registration returns `ACCESS_NOT_CONFIGURED`, configure `ACCESS_TEAM_DOMAIN` on Identity staging before retrying. If it returns `ACCESS_AUDIENCE_IN_USE`, stop: that AUD is already bound to another LifeSpace application and must not be silently reassigned.

## Production scripts

- `provision-production.mjs`: create-if-missing D1/R2/Queue provisioning from the production manifest; never deletes, renames, replaces or reuses staging resources. It is invoked only by **Provision production resources**.
- `resolve-production-d1.mjs`: resolves exact production D1 IDs only into the ephemeral deployment checkout.
- `ensure-production-domains.mjs`: preflights and attaches only the two approved production Worker Custom Domains; refuses to move a hostname owned by another Worker.
- `production-expectations.mjs`: derives production contract/schema expectations from the repository.
- `initialize-production-runtime.mjs`: initializes first-use signing/shared secrets, preserves complete existing secret sets, and refuses partial automatic repair/rotation.
- `verify-production-http.mjs`: verifies production health, environment, schema and contract versions.
- `verify-production-cloudflare.mjs`: verifies D1/R2/Queue/Worker/domain/secret presence, Queue attachment/policy, and staging isolation.
- `verify-production-model-admin.mjs`: uses disposable service authority to verify `lsp_pat_*` introspection and initialize/verify the accepted active Model Contract.
- `verify-production-homemew-auth.mjs` and `verify-production-db.mjs`: retained historical Phase 6 evidence helpers; they are not invoked by normal production deployment.

Detailed operator rules are documented in `infra/staging/README.md` and `infra/production/README.md`. Historical phase plans/status documents remain audit evidence, not current deployment runbooks.
