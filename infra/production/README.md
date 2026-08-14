# LifeSpace production bring-up

## Scope

This runbook covers LifeSpace **Phase 6**: bring up an empty production platform before the HomeMew production migration/cutover.

It must not read or migrate HomeMew production business data and must not route HomeMew production traffic to LifeSpace.

## Production resources

- Identity D1: `lifespace-identity`
- Core D1: `lifespace-core`
- R2: `lifespace-assets`
- Queue: `lifespace-creation-drafts`
- Identity Worker: `lifespace-identity` -> `auth.aisr.online`
- Core Worker: `lifespace-core` -> `core.aisr.online`

Desired names live in `resources.json`. Staging names are never accepted as production substitutions.

## GitHub `production` environment

The `Deploy production` workflow runs in the GitHub `production` Environment. Configure:

- secret `CLOUDFLARE_API_TOKEN` with the approved LifeSpace production deployment permissions;
- variable or secret `CLOUDFLARE_ACCOUNT_ID`;
- secret `LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET`, at least 32 characters and distinct from the staging bootstrap secret.

The workflow never writes generated secrets to repository files or artifacts.

`LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET` is synchronized into the production Identity Worker. First bring-up generates RS256 signing material and the Core↔Identity shared authentication secret only when the complete corresponding secret sets are absent. Later runs preserve complete existing sets. A partially present set is treated as an error and is **not** automatically repaired or rotated in production.

## First Phase 6 run

GitHub only dispatches a `workflow_dispatch` workflow after that workflow file exists on the repository default branch. Therefore the Phase 6 implementation PR must pass CI and be merged to `main` before the first production run is dispatched.

After merge, run **Actions -> Deploy production -> Run workflow**, select `main`, and use:

```text
phase6_bringup: true
provision: true
confirmation: DEPLOY_PRODUCTION
```

The workflow:

1. runs the full repository validation;
2. create-if-missing provisions the production D1/R2/Queue resources;
3. resolves real production D1 UUIDs only in the CI checkout;
4. preflights `auth.aisr.online` and `core.aisr.online` and refuses to move either hostname from another Worker;
5. applies Identity migrations and deploys Identity first for the one-time Service Binding bootstrap;
6. applies Core migrations and deploys Core;
7. verifies/attaches the production custom domains;
8. initializes or preserves production signing/shared secrets;
9. verifies production health/status/schema/contracts and Cloudflare resource isolation;
10. creates disposable Model Admin authority, verifies `lsp_pat_*` Core introspection, initializes/reads the active Model Contract, then deletes the probe authority;
11. registers `homemew-miniprogram`, verifies the accepted HomeMew JWT boundary with disposable authority, then removes the probe user/credential;
12. verifies Core/Identity remain free of HomeMew/business state and that HomeMew has **zero active application credentials** after Phase 6.

The HomeMew production application registration is intentional metadata. Its actual cutover `lsa_*` credential is **not** retained by Phase 6. Phase 7 creates a new credential and places it directly in the HomeMew production secret store.

If the first run fails after resources have already been created, rerun Phase 6 from `main` with `provision: false` unless a missing resource still needs create-if-missing provisioning.

## Normal production deployments after Phase 6

Use:

```text
phase6_bringup: false
provision: false
confirmation: DEPLOY_PRODUCTION
```

Normal production deployment uses Core-first -> Identity ordering and does not run the Phase 6 business-empty gate or create Phase 6 probe authority.

## Phase 6 prohibition

Do not during this phase:

- run `infra/migration/homemew-one-shot.mjs` against HomeMew production;
- issue/store the final HomeMew production application credential;
- create HomeMew user/provider mappings;
- import HomeMew Spaces, people, Events, Tasks, Day Records, Wishes or avatars;
- alter HomeMew production DNS/routes/clients to point at LifeSpace.

Those actions belong to Phase 7 after the redesigned HomeMew release is ready.
