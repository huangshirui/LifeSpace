# LifeSpace Admin

LifeSpace Admin is the owner-controlled platform control plane. The first implementation intentionally focuses on one complete path: registering a new LifeSpace Application and making its Core model authorization usable immediately.

## Runtime

```text
Browser
  -> Cloudflare Access
  -> LifeSpace Admin Worker
      -> verify Cf-Access-Jwt-Assertion
      -> Service Binding -> Identity bootstrap administration
      -> Service Binding -> Core service-only model administration
```

The browser never receives `IDENTITY_BOOTSTRAP_SECRET` or `CORE_ADMIN_TOKEN`. A newly created trusted-application `lsa_*` secret is returned to the authenticated operator exactly once because it is the onboarding deliverable itself; Admin does not persist it.

## Application onboarding

`POST /api/applications` accepts:

- application name and client type;
- whether the application has a trusted backend/BFF;
- stable Identity scope ceiling;
- user access-token TTL;
- published model access (`read` / `write` / `manage`).

Admin generates the `app_*` id, registers the application in Identity, then atomically replaces that application's Core `application_model_access` catalog. If the Core step fails, Admin disables the Identity application and revokes any new active application credential before returning failure.

## Required Worker secrets

Each environment requires separate values:

- `CF_ACCESS_TEAM_DOMAIN` — for example `https://<team>.cloudflareaccess.com`;
- `CF_ACCESS_AUD` — Access Application audience tag for the Admin hostname;
- `IDENTITY_BOOTSTRAP_SECRET` — environment-specific Identity platform bootstrap credential;
- `CORE_ADMIN_TOKEN` — `lsp_pat_*` token for a service principal with `models:manage` in the platform-admin application context.

Staging and production secrets must never be reused across environments.

For staging, `.github/workflows/admin-staging-deploy.yml` installs these Worker secrets without exposing plaintext credentials in repository configuration. It reuses the existing staging Identity bootstrap secret and `infra/scripts/initialize-staging-admin-runtime.mjs` creates/rotates a dedicated non-expiring `models:manage` service token, writes it directly to the Admin Worker through Wrangler bulk secrets, then revokes the previous Admin runtime token after successful replacement.

The staging GitHub Environment therefore needs only these additional non-secret Access variables before the first Admin deployment:

- `LIFESPACE_STAGING_ADMIN_ACCESS_TEAM_DOMAIN`;
- `LIFESPACE_STAGING_ADMIN_ACCESS_AUD`.

`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `LIFESPACE_STAGING_BOOTSTRAP_SECRET` continue to use the existing staging deployment configuration.

## Cloudflare Access

Create separate Access Applications for:

- `admin-staging.aisr.online`;
- `admin.aisr.online`.

The Access policy decides which human operators may enter the Admin. The Worker additionally verifies the Access JWT signature, issuer, audience and expiration on every `/api/*` request.

The isolated `Deploy Admin staging` workflow refuses a successful result if an unauthenticated request to `admin-staging.aisr.online` receives HTTP 200, so a missing Access perimeter cannot be mistaken for a completed staging deployment. The final MVP proof remains a real operator sign-in followed by one browser application-onboarding flow.

## Local development

For local-only calls, set `ENVIRONMENT=local` and send `x-lifespace-local-admin: 1`. This bypass exists only in the local runtime branch and is ignored in staging/production.
