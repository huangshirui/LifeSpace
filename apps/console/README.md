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

The workflow intentionally supports two stages so an operator does not need to know their LifeSpace `usr_*` before the first Console login.

### Stage A — session-only proving

Run the workflow with `platform_admin_user_id` left blank.

It will:

1. verify that staging Identity matches the branch schema/contract expectation;
2. create/reconcile `app_lifespace_console_staging` with the complete Console scope ceiling;
3. register the fixed staging Access AUD;
4. rotate a fresh server-only `lsa_*` in-run;
5. deploy `lifespace-console-staging` with only `IDENTITY_APPLICATION_CREDENTIAL`;
6. verify the hostname is reachable behind Access;
7. revoke superseded Console application credentials after deployment succeeds.

It does **not** create/change platform-administrator assignment and does not provision a Core executor.

Open the Console through Cloudflare Access after this stage. `/api/session` shows the globally resolved LifeSpace `usr_*` for the verified Access principal.

### Stage B — full platform-admin proving

Rerun the same workflow with:

```text
platform_admin_user_id=<usr_* shown by Stage A>
```

It will:

1. reconcile the Console Application and fixed AUD;
2. bootstrap/refresh that `usr_*` as a LifeSpace platform administrator;
3. create/reconcile the dedicated least-privilege Core executor;
4. rotate fresh one-time `lsa_*` and `lsp_pat_*` credentials in-run;
5. pass those credentials to Wrangler through an ephemeral mode-0600 secrets file;
6. deploy the Console Worker;
7. verify the hostname;
8. only after successful deployment, revoke superseded application credentials and Core executor tokens;
9. remove the ephemeral secrets file.

The workflow never installs the bootstrap secret into the Console Worker and never prints application/Core executor plaintext credentials.

Canonical reconciliation scripts:

```text
infra/scripts/prepare-staging-console-shell.mjs
infra/scripts/prepare-staging-console-admin.mjs
```

## Staging proving sequence

Do not deploy production as part of this proving flow.

```text
1. Run “Deploy staging” from the Console branch/ref first.
   This applies Identity schema v7 / Core schema v26 and deploys the matching runtime.

2. Run “Provision LifeSpace Console staging” with platform_admin_user_id blank.

3. Open https://lifespace-staging.aisr.online through Cloudflare Access.

4. Read the resolved LifeSpace usr_* from /api/session / proving page.

5. Rerun “Provision LifeSpace Console staging” with that usr_*.

6. Open the Console again and confirm /api/session resolves the same usr_*.

7. Click “验证控制面” and confirm every read-only Identity/Core check succeeds.

8. Run infra/scripts/verify-staging-console-admin.mjs when a raw real Access assertion
   is available for scripted E2E/deny-path proving.
```

If the Access principal is valid but not linked, the Console shows an explicit account-link-required state. It does not create or merge a LifeSpace account by email.

## Direct script inputs

For local/operator use outside the workflow, the full control-plane reconciliation script accepts:

```text
LIFESPACE_STAGING_BOOTSTRAP_SECRET
LIFESPACE_STAGING_CONSOLE_ACCESS_AUD
LIFESPACE_STAGING_PLATFORM_ADMIN_USER_ID
```

The session-only shell script omits the platform-admin user input.

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