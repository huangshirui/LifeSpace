# LifeSpace production bring-up

## Scope

This runbook covers the guarded LifeSpace production deployment path, including the original **Phase 6** empty-platform bring-up and later compatible production releases.

It must not read or migrate HomeMew production business data. The completed HomeMew one-shot migration implementation was retired from the active repository in Phase 8; normal LifeSpace deployment must not revive historical migration code or route HomeMew application traffic.

## Production resources

- Identity D1: `lifespace-identity`
- Core D1: `lifespace-core`
- R2: `lifespace-assets`
- Creation Draft Queue: `lifespace-creation-drafts`
- Event Delivery Queue: `lifespace-event-deliveries`
- Event Delivery DLQ: `lifespace-event-deliveries-dlq`
- Identity Worker: `lifespace-identity` -> `auth.aisr.online`
- Core Worker: `lifespace-core` -> `core.aisr.online`

Desired names live in `resources.json`. Staging names are never accepted as production substitutions.

`provision-production.mjs` is deliberately create-if-missing and idempotent: it never deletes, renames, replaces or reuses staging resources. The `provision` workflow input remains `false` by default, but may be explicitly enabled on a later production release when the declared manifest adds a required production D1/R2/Queue resource.

## GitHub `production` environment

The `Deploy production` workflow runs in the GitHub `production` Environment. Configure:

- secret `CLOUDFLARE_API_TOKEN` with the approved LifeSpace production deployment permissions;
- variable or secret `CLOUDFLARE_ACCOUNT_ID`;
- secret `LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET`, at least 32 characters and distinct from the staging bootstrap secret.

The workflow never writes generated secrets to repository files or artifacts.

`LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET` is synchronized into the production Identity Worker. First bring-up generates RS256 signing material and the Core↔Identity shared authentication secret only when the complete corresponding secret sets are absent. Later runs preserve complete existing sets. A partially present set is treated as an error and is **not** automatically repaired or rotated in production.

## First Phase 6 run (historical)

GitHub only dispatches a `workflow_dispatch` workflow after that workflow file exists on the repository default branch. The original Phase 6 bring-up therefore merged the implementation to `main` before the first production run.

The historical first-run inputs were:

```text
phase6_bringup: true
provision: true
confirmation: DEPLOY_PRODUCTION
```

That path established the platform and is not a normal release mode. Do not intentionally repeat the empty-platform bring-up on an established production database.

## Normal production deployments after Phase 6

For a code/schema release that needs no new Cloudflare resource, use:

```text
phase6_bringup: false
provision: false
confirmation: DEPLOY_PRODUCTION
```

When the release adds a resource already declared in `infra/production/resources.json`, use:

```text
phase6_bringup: false
provision: true
confirmation: DEPLOY_PRODUCTION
```

This only runs the idempotent create-if-missing provisioner before migration/deployment; it does not run the Phase 6 business-empty gate. Normal production deployment uses Core-first -> Identity ordering so the newer compatible Core verifier/runtime is live before Identity may issue against it.

The Eventing production verifier requires:

- the Event Delivery Queue to be both produced to and consumed by `lifespace-core`;
- `max_retries=5`;
- dead-letter target `lifespace-event-deliveries-dlq`;
- the DLQ to exist as the dead-letter target without pretending it is a normal Core producer/consumer queue;
- production Queue IDs to remain isolated from staging.

## Migration and application-cutover boundary

Normal LifeSpace production deployment must not:

- run a retired HomeMew one-shot migration from Git history;
- create HomeMew provider mappings or import application business data as a side effect of platform deployment;
- alter HomeMew production DNS/routes/clients;
- delete legacy HomeMew runtime resources merely because the repository-side migration implementation has been retired.

The completed Phase 7 migration/cutover remains historical evidence. Any future migration or destructive runtime-resource retirement requires a new, explicitly approved plan based on the then-current contracts and rollback conditions.
