# Phase 1 Cloudflare provisioning

Phase 1 code is safe to build locally before remote resources exist. The zero-like D1 UUIDs in both Wrangler files are deliberate non-production placeholders and **must be replaced with IDs returned by Cloudflare before any remote migration or deployment**.

## Staging resources to create first

- Worker: `lifespace-identity-staging`
- D1: `lifespace-identity-staging`
- Worker: `lifespace-core-staging`
- D1: `lifespace-core-staging`
- Custom domains after Worker verification: `auth-staging.aisr.online`, `core-staging.aisr.online`

Staging Identity secrets:

- `TOKEN_PRIVATE_KEY`: RS256 PKCS#8 private key. Never commit it.
- `BOOTSTRAP_SECRET`: temporary high-entropy secret protecting Phase 1 bootstrap APIs. Remove the bootstrap API when real login/admin provisioning replaces it.

Staging Core secrets:

- `IDENTITY_PUBLIC_KEY`: matching RS256 public key. This is not secret but is configured as runtime material until JWKS/key rotation is implemented.

Optional Core variable:

- `CORS_ORIGINS`: comma-separated exact browser origins when direct browser-to-Core access is needed. Same-origin BFF access remains preferred.

## Production isolation

Do not create or bind production resources until staging passes the Phase 1 exit gate. Production must use different D1 IDs, Worker names and signing keys. Never reuse HomeMew production D1/R2/Queue bindings.

## Provisioning order

1. Create both staging D1 databases.
2. Replace only the `env.staging` placeholder D1 IDs in the Wrangler configs.
3. Generate a staging RS256 key pair offline; store the private key only in Identity and the public key in Core.
4. Configure `BOOTSTRAP_SECRET` in Identity.
5. Apply Identity and Core staging migrations.
6. Deploy Identity and Core staging Workers.
7. Verify `/health` and `/api/v1/status` before adding custom domains.
8. Create a bootstrap test user and application, issue a 15-minute token, and exercise Space authorization in Core.
9. Bind staging custom domains.
10. Complete Phase 1 authorization/integration tests before creating production resources.
