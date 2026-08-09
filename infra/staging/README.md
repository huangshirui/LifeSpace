# LifeSpace staging provisioning

## Purpose

Create isolated Cloudflare staging resources for LifeSpace.

Production resources must never be reused.

## Resources

- Identity D1: `lifespace-identity-staging`
- Core D1: `lifespace-core-staging`
- R2: `lifespace-staging-assets`
- Queue: `lifespace-staging-creation-drafts`

## Flow

1. Create resources with Wrangler CLI.
2. Record generated IDs in deployment configuration.
3. Apply D1 migrations.
4. Deploy Identity and Core Workers using `--env staging`.
5. Run `/health` and `/api/v1/status` checks.

Credentials are supplied through GitHub Actions secrets and are never committed.
