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

Repository Actions must provide:

- Secret: `CLOUDFLARE_API_TOKEN`
- Variable or secret: `CLOUDFLARE_ACCOUNT_ID`

The API token must have the account permissions required to create/manage Workers, D1, R2 and Queues used by staging.

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

## Deployment flow

Staging deployment is a separate operation from provisioning:

1. Resolve real staging D1 IDs in the CI checkout.
2. Run contract/tests/typecheck/build.
3. Apply Identity and Core D1 migrations.
4. Deploy Identity and Core Workers with `--env staging`.
5. Verify `/health` and `/api/v1/status`.
6. Run the Phase 1 Identity -> token -> Core -> Space end-to-end smoke test once runtime secrets are configured.

Credentials and runtime secrets are never committed.
