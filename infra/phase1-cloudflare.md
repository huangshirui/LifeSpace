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
- `BOOTSTRAP_SECRET`: temporary high-entropy secret protecting platform bootstrap APIs. Do not reuse it as an application credential.

Staging Core secrets:

- `IDENTITY_PUBLIC_KEY`: matching RS256 public key. This is not secret but is configured as runtime material until JWKS/key rotation is implemented.

Optional Core variable:

- `CORS_ORIGINS`: comma-separated exact browser origins when direct browser-to-Core access is needed. Same-origin BFF access remains preferred.

## Application bootstrap policy

Each trusted backend receives its own one-time application credential from Identity bootstrap. Configure an application-specific access-token TTL between 300 and 3600 seconds.

For the HomeMew Mini Program staging application, use:

```json
{
  "id": "homemew-miniprogram",
  "name": "HomeMew Mini Program",
  "clientType": "mini_program",
  "trustedBackend": true,
  "accessTokenTtlSeconds": 3600
}
```

The returned application secret belongs only in the HomeMew login Cloud Function backend configuration. It must never be returned to Mini Program code.

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
8. Bootstrap a test trusted application and save its one-time application credential in the corresponding backend only.
9. Create a test LifeSpace user through the trusted application, issue an app-scoped token using the application's configured TTL, and exercise Space authorization in Core.
10. Bind staging custom domains.
11. Complete D1-backed authorization/integration tests before creating production resources.
