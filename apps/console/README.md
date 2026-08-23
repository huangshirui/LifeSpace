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

It is protected by its own Cloudflare Access Self-hosted Application. The staging Audience (AUD) tag is:

```text
1d42303137e808002273985855078230ce53fe18078b40c5b8cbc09dd3a62a36
```

This value is environment-specific configuration, not a credential, and is committed only for the staging Console provisioning path.

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

## Staging provisioning workflow

Canonical workflow:

```text
.github/workflows/lifespace-console-staging-provision.yml
```

Manual workflow input:

```text
platform_admin_user_id=<existing staging usr_*>
```

The AUD, Console application ID and staging hostnames are fixed by the workflow. The workflow uses the existing `staging` GitHub Environment for Cloudflare/bootstrap authority.

Provisioning performs the following sequence:

1. verify that staging Identity/Core already match the branch schema/contract expectations;
2. create/reconcile `app_lifespace_console_staging`;
3. register the fixed staging Access AUD;
4. bootstrap/refresh the requested `usr_*` platform-administrator assignment;
5. create/reconcile the dedicated Core executor;
6. mint fresh one-time `lsa_*` and `lsp_pat_*` credentials in-run;
7. pass those credentials to Wrangler through an ephemeral mode-0600 secrets file;
8. deploy `lifespace-console-staging` to `lifespace-staging.aisr.online`;
9. verify that the hostname is reachable behind Access;
10. only after deployment succeeds, revoke superseded application credentials and Core executor tokens;
11. remove the ephemeral secrets file.

The workflow never installs the bootstrap secret into the Console Worker and never prints application/Core executor plaintext credentials.

`infra/scripts/prepare-staging-console-admin.mjs` remains the canonical LifeSpace-side reconciliation implementation used by the workflow.

## Staging proving sequence

Do not deploy production as part of this proving flow.

```text
1. Run “Deploy staging” from the Console branch/ref first.
   This applies Identity schema v7 / Core schema v26 and deploys the matching runtime.

2. Run “Provision LifeSpace Console staging”.
   Input: the existing staging LifeSpace usr_* that should be platform administrator.

3. Open https://lifespace-staging.aisr.online through Cloudflare Access.

4. Confirm /api/session resolves that same LifeSpace usr_*.

5. Click “验证控制面” and confirm every read-only Identity/Core check succeeds.

6. Run infra/scripts/verify-staging-console-admin.mjs when a raw real Access assertion
   is available for scripted E2E/deny-path proving.
```

If the Access principal is valid but not linked, the Console shows an explicit account-link-required state. It does not create or merge a LifeSpace account by email.

## Direct script inputs

For local/operator use outside the workflow, `infra/scripts/prepare-staging-console-admin.mjs` accepts:

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

Generated plaintext secrets must be sent only to `GITHUB_ENV` or a mode-0600 output file. Existing plaintext credentials cannot be recovered.

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