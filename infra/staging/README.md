# LifeSpace staging provisioning

## Purpose

Create isolated Cloudflare staging resources for LifeSpace. Production resources must never be reused.

## Resources

- Identity D1: `lifespace-identity-staging`
- Core D1: `lifespace-core-staging`
- R2: `lifespace-staging-assets`
- Queue: `lifespace-staging-creation-drafts`

The desired resource names live in `resources.json`. The Cloudflare account is supplied by GitHub Actions through `CLOUDFLARE_ACCOUNT_ID`; account-specific IDs are not part of the resource manifest.

## GitHub configuration

Repository/`staging` Environment Actions must provide:

- Secret: `CLOUDFLARE_API_TOKEN`
- Variable or secret: `CLOUDFLARE_ACCOUNT_ID`
- Staging Environment secret: `LIFESPACE_STAGING_BOOTSTRAP_SECRET` (at least 32 characters)

The Cloudflare API token must have the account permissions required to create/manage Workers, D1, R2 and Queues used by staging.

`LIFESPACE_STAGING_BOOTSTRAP_SECRET` is the persistent platform-administration credential used by CI to register trusted staging applications through Identity. It must not be committed to the repository. The deploy workflow synchronizes it into the Identity Worker as `BOOTSTRAP_SECRET`.

## Provisioning flow

Run the **Provision staging infrastructure** workflow manually.

`infra/scripts/provision-staging.mjs` is idempotent:

1. List each required staging resource.
2. Create it only when the exact resource name is missing.
3. Never delete, rename, replace or reuse a production resource.
4. Report the resolved D1 and Queue IDs in the Actions job summary.

## D1 IDs

The checked-in Wrangler files intentionally keep non-production placeholder UUIDs for resources that do not exist in a fresh checkout.

Before migration/deployment, `infra/scripts/resolve-staging-d1.mjs` looks up the real staging D1 UUIDs by exact database name and replaces the placeholder values only in the ephemeral CI checkout. No human needs to copy D1 UUIDs into GitHub, and CI does not commit account-specific UUID changes back to `main`.

## Runtime secrets

The first successful staging deploy initializes the RS256 signing relationship automatically:

- Identity Worker secret `TOKEN_PRIVATE_KEY` is generated once.
- Core Worker secret `IDENTITY_PUBLIC_KEY` is generated from the matching key pair.
- Identity Worker secret `BOOTSTRAP_SECRET` is synchronized from `LIFESPACE_STAGING_BOOTSTRAP_SECRET` on every deploy.

If both signing-key secrets already exist, deploy preserves them so normal deployments do not invalidate already-issued tokens. If only one side exists, initialization fails rather than silently rotating into a mismatched key state.

## Deployment flow

Run the **Deploy staging** workflow manually after provisioning succeeds and the staging bootstrap secret is configured.

1. Resolve real staging D1 IDs in the CI checkout.
2. Run contract/tests/typecheck/build.
3. Apply Identity and Core D1 migrations.
4. Deploy Identity and Core Workers with `--env staging`.
5. Verify `/health` and `/api/v1/status` on both custom domains.
6. Initialize/preserve the RS256 runtime signing keys and synchronize the bootstrap secret.
7. Run the Phase 1 Identity -> token -> Core -> Space end-to-end smoke test, including an unauthenticated deny check.

The smoke test intentionally creates staging-only application/user/Space records identified by the GitHub Actions run ID. Credentials and runtime secret values are never printed or committed.
