# LifeSpace Console

LifeSpace Console is the platform operations/governance Web application for `lifespace.aisr.online`.

The current `0.0.1` implementation is a **staging proving shell**, not the complete React/Vite MVP. Its Worker/BFF security and deployment boundary are intended to remain; only the temporary static presentation layer will be replaced in the dedicated UI slice.

## Current routes

```text
GET /api/health
GET /api/session
GET /api/platform/probe
```

- `/api/session` reads the server-provided `Cf-Access-Jwt-Assertion`, forwards the raw assertion to LifeSpace Identity and returns only the resolved LifeSpace profile/state.
- `/api/platform/probe` obtains a short-lived platform-admin actor proof server-side, then performs bounded read-only Identity/Core control-plane checks.
- Actor proof, application credential and Core executor bearer are never returned to browser JavaScript.
- The proving shell performs no model publication, Space mutation, credential mutation or arbitrary upstream proxying.

## Cloudflare Access

The staging hostname is:

```text
https://lifespace-staging.aisr.online
```

It must be protected by its own Cloudflare Access Self-hosted Application. Copy that Access application's Audience (AUD) tag and register it to the staging Console LifeSpace application during provisioning.

Cloudflare sends the application token to the Worker as:

```text
Cf-Access-Jwt-Assertion: <raw Access JWT>
```

The Console Worker does not trust decoded Access identity fields. It passes the original assertion to Identity, which independently validates the configured issuer, signature, lifetime, subject and registered audience before issuing any LifeSpace user credential.

## Runtime bindings

Non-secret vars are committed in `wrangler.jsonc`:

```text
ENVIRONMENT
IDENTITY_BASE_URL
CORE_BASE_URL
```

Staging/production additionally use Cloudflare Service Bindings:

```text
IDENTITY -> corresponding Identity Worker
CORE     -> corresponding Core Worker
```

Service Bindings are transport only. Privileged authorization still requires the explicit LifeSpace credentials below.

Worker secrets:

```text
IDENTITY_APPLICATION_CREDENTIAL
  Console application's server-only lsa_* credential

CORE_EXECUTOR_BEARER
  dedicated Console Core service executor lsp_pat_* (or approved service JWT)
```

The global bootstrap secret is deliberately **not** a Console Worker secret.

## Staging provisioning inputs

`infra/scripts/prepare-staging-console-admin.mjs` prepares the LifeSpace-side staging control-plane state. Required inputs:

```text
LIFESPACE_STAGING_BOOTSTRAP_SECRET
LIFESPACE_STAGING_CONSOLE_ACCESS_AUD
LIFESPACE_STAGING_PLATFORM_ADMIN_USER_ID
```

Defaults:

```text
LIFESPACE_STAGING_CONSOLE_APPLICATION_ID=app_lifespace_console_staging
LIFESPACE_STAGING_CONSOLE_APPLICATION_NAME="LifeSpace Console staging"
```

The script creates/reconciles:

- staging Console LifeSpace Web application;
- Access audience registration;
- platform-administrator assignment;
- dedicated Core service executor with the exact least-privilege scopes;
- one-time application/Core executor secrets when required.

Generated secrets must be sent only to `GITHUB_ENV` or a mode-0600 file configured by:

```text
LIFESPACE_STAGING_CONSOLE_CREDENTIAL_OUTPUT
```

Existing plaintext credentials cannot be recovered. The script fails instead of silently minting replacements unless explicit rotation/recovery conditions are satisfied.

## Staging deployment sequence

Do not deploy production as part of the proving flow.

Recommended staging order:

```text
1. Create/configure Cloudflare Access Self-hosted Application
   for lifespace-staging.aisr.online and obtain its AUD.

2. Deploy current Identity/Core branch to staging and apply migrations:
   Identity -> schema v7
   Core     -> schema v26

3. Provision LifeSpace Console staging application/audience/admin/executors
   with infra/scripts/prepare-staging-console-admin.mjs.

4. Deploy apps/console with --env staging.

5. Install the generated credentials as Worker secrets:
   IDENTITY_APPLICATION_CREDENTIAL
   CORE_EXECUTOR_BEARER

6. Open https://lifespace-staging.aisr.online through Cloudflare Access.

7. Confirm /api/session resolves the expected LifeSpace usr_*.

8. Click “验证控制面” and confirm every read-only Identity/Core check succeeds.

9. Run infra/scripts/verify-staging-console-admin.mjs when a raw real Access assertion
   is available for scripted E2E/deny-path proving.
```

If the Access principal is valid but not linked, the Console shows an explicit account-link-required state. It does not create or merge a LifeSpace account by email.

## Local development

Local vars point to local Identity/Core ports:

```text
Identity: http://127.0.0.1:8788
Core:     http://127.0.0.1:8787
```

Set local Worker secrets through Wrangler development secrets/environment rather than source code. A local request without a valid Access assertion will intentionally fail `/api/session` and `/api/platform/probe`; `/api/health` remains available for shell/build verification.

## Final frontend direction

After the staging Access/control-plane chain is accepted, keep the Worker/BFF and deployment model, then replace the proving-page presentation with:

- React;
- TypeScript;
- Vite;
- Cloudflare Vite plugin / Workers Static Assets.

The full MVP pages are specified in `docs/lifespace-console-mvp.md`.
