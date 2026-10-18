# LifeSpace production operations

External Provider support is an independent environment opt-in. Follow [External Provider rollout](../external-provider-rollout.md) for pinned Adapter packaging, private bindings, matching secret injection, staging evidence and production isolation. Native-only release success does not claim External availability; production Provider data is never used for destructive smoke.

## Scope

This runbook covers the long-lived LifeSpace production operation paths after the platform has already been established:

- **Deploy production**: database migration, Core/Identity deployment and verification.
- **Provision production resources**: low-frequency, create-if-missing reconciliation of declared D1/R2/Queue resources.

The historical Phase 6 empty-platform bring-up is complete and is no longer an active workflow mode. Its evidence remains in the phase status/history documents, but normal operators must not repeat the empty-platform path on an established production database.

Neither operation may read or migrate any consumer application's production business data as a side effect.

## Production resources

- Identity D1: `lifespace-identity`
- Core D1: `lifespace-core`
- R2: `lifespace-assets`
- Event Delivery Queue: `lifespace-event-deliveries`
- Event Delivery DLQ: `lifespace-event-deliveries-dlq`
- Identity Worker: `lifespace-identity` -> `auth.aisr.online`
- Core Worker: `lifespace-core` -> `core.aisr.online`

Desired names live in `resources.json`. Staging names are never accepted as production substitutions.

`provision-production.mjs` is deliberately create-if-missing and idempotent: it never deletes, renames, replaces or reuses staging resources.

## GitHub `production` environment

Production workflows run in the GitHub `production` Environment.

For deployment, configure:

- secret `CLOUDFLARE_API_TOKEN` with the approved LifeSpace production deployment permissions;
- variable or secret `CLOUDFLARE_ACCOUNT_ID`;
- secret `LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET`, at least 32 characters and distinct from the staging bootstrap secret.

For resource provisioning, only the Cloudflare API token and account ID are required; the bootstrap secret is deliberately not part of that workflow.

The workflows never write generated secrets to repository files or artifacts.

`LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET` is synchronized into the production Identity Worker by the deployment path. Runtime initialization generates signing/shared material only when a complete corresponding secret set is absent, preserves complete existing sets, and refuses partial automatic repair/rotation.

## Deploy production

Routine releases use the **Deploy production** workflow.

Input:

```text
confirmation: DEPLOY_PRODUCTION
```

There are no Phase 6 or provisioning checkboxes. The deployment workflow intentionally does not create D1/R2/Queue resources.

Current deployment ordering is:

1. validate repository and production infrastructure contract;
2. resolve expected Core/Identity schema and contract versions;
3. resolve existing production D1 IDs;
4. preflight approved production Custom Domains;
5. apply Core migrations;
6. deploy Core;
7. apply Identity migrations;
8. deploy Identity after the compatible Core runtime is live;
9. reconcile Custom Domains and runtime secrets;
10. wait for production HTTP/schema/contract convergence;
11. verify Cloudflare isolation/bindings and active immutable Model Contract.

Core-first -> Identity ordering matches the compatibility-preserving normal release path used by staging: a newer verifier/runtime is live before Identity may issue credentials that depend on it.

## Provision production resources

Use **Provision production resources** only when `infra/production/resources.json` introduces a required D1/R2/Queue resource that does not already exist, or when explicitly reconstructing a declared missing resource.

Input:

```text
confirmation: PROVISION_PRODUCTION
```

The workflow:

- runs in the GitHub `production` Environment;
- calls only the idempotent create-if-missing provisioner;
- does not run migrations;
- does not deploy Workers;
- does not initialize runtime/bootstrap secrets;
- never deletes, renames or replaces resources.

Provisioning and deployment share one production concurrency lock, so they cannot mutate production concurrently.

For a release that adds infrastructure, the intended promotion sequence is:

```text
Provision staging resources
-> Deploy staging and pass acceptance
-> Provision production resources
-> Deploy production
```

Do not use provisioning merely because a deployment is being performed; it is a separate low-frequency infrastructure operation.


## Eventing production verification

The Eventing production verifier requires:

- the Event Delivery Queue to be both produced to and consumed by `lifespace-core`;
- `max_retries=5`;
- dead-letter target `lifespace-event-deliveries-dlq`;
- the DLQ to exist as the dead-letter target without pretending it is a normal Core producer/consumer queue;
- production Queue IDs to remain isolated from staging.

## External application boundary

Normal LifeSpace production operations must not read or import an external application's business data as a deployment side effect, create provider mappings for a consumer, alter consumer DNS/routes/clients, or delete consumer-owned runtime resources.

Application migration, compatibility acceptance, provider identity mapping and release/cutover remain responsibilities of the application repository. Any future destructive LifeSpace infrastructure change requires its own explicit platform migration/rollback plan.


## File upload signing

File uploads are **not yet a verified production capability**. The separate, owner-approved `Deploy LifeSpace platform production` release will refuse to begin migrations unless the production GitHub Environment provides independent, bucket-scoped `R2_S3_ACCESS_KEY_ID` and `R2_S3_SECRET_ACCESS_KEY` secrets. Existing `CLOUDFLARE_ACCOUNT_ID` is synchronized as the Core `R2_S3_ACCOUNT_ID` Worker Secret.

Use an R2 token restricted to `lifespace-assets` with object read/write permissions. **Never reuse staging credentials** or expose these values in client code, GitHub source, logs, Worker API responses or application storage. Runtime secrets are synchronized only by the manual production workflow after Core deployment.

Review and non-destructively extend the shared production R2 bucket's existing CORS rules for explicitly allowed Web/PWA origins; signed Node/n8n uploads need no browser CORS. Preserve all unrelated existing rules. Native and Notion File real synthetic acceptance must pass in staging for the exact candidate SHA **before** production is run. The production workflow does not mutate a real Notion dataset as a synthetic smoke.
