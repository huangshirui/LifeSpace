# LifeSpace Console

LifeSpace Console is the platform operations/governance Web application for `lifespace.aisr.online`.

The current `0.0.1` implementation is a **staging proving shell**, not the complete React/Vite MVP. Its Worker/BFF security and deployment boundary are intended to remain; the temporary static presentation layer will be replaced in the dedicated UI slice.

## Current routes

```text
GET /api/health
GET /api/session
GET /api/platform/probe
```

- `/api/session` reads the server-provided `Cf-Access-Jwt-Assertion`, forwards the raw assertion to LifeSpace Identity and returns only the resolved LifeSpace profile/state.
- `/api/platform/probe` obtains a short-lived platform-admin actor proof server-side, then performs bounded read-only Identity/Core control-plane checks.
- Access assertions, LifeSpace user tokens, actor proofs, application credentials and Core executor bearers are never returned to browser JavaScript.
- The proving shell performs no model publication, Space mutation, credential mutation or arbitrary upstream proxying.

## Cloudflare Access

Staging hostname:

```text
https://lifespace-staging.aisr.online
```

Staging Access Audience (AUD):

```text
1d42303137e808002273985855078230ce53fe18078b40c5b8cbc09dd3a62a36
```

The AUD is environment configuration, not a credential, and is committed only for the staging Console provisioning path.

Cloudflare sends the application assertion to the Worker as:

```text
Cf-Access-Jwt-Assertion: <raw Access JWT>
```

The Console Worker does not trust decoded Access identity fields. It passes the original assertion to Identity, which independently validates issuer, signature, lifetime, subject and registered audience before issuing a LifeSpace user credential.

## Runtime bindings and secrets

Committed non-secret vars:

```text
ENVIRONMENT
IDENTITY_BASE_URL
CORE_BASE_URL
```

Staging/production Service Bindings:

```text
IDENTITY -> corresponding Identity Worker
CORE     -> corresponding Core Worker
```

Service Bindings are transport only. Privileged authorization still requires explicit LifeSpace credentials.

Console Worker secrets:

```text
IDENTITY_APPLICATION_CREDENTIAL
  Console application's server-only lsa_* credential

CORE_EXECUTOR_BEARER
  dedicated Console Core service executor lsp_pat_* in full-admin mode
```

The global bootstrap secret is deliberately **not** a Console Worker secret.

## Canonical staging workflow

```text
.github/workflows/lifespace-console-staging-provision.yml
```

This one workflow owns the complete staging proving sequence. It first converges the shared platform runtime, using the same safe rollout order as the normal staging deploy:

```text
Core migrations
-> Core staging deploy
-> wait for Core schema/contract convergence
-> Identity migrations
-> Identity staging deploy
-> wait for Identity schema/contract convergence
-> Console provisioning/deploy
```

The workflow uses the repository lockfile with the normal workspace toolchain and touches staging resources only.

It intentionally supports two runs so the operator does not need to know a LifeSpace `usr_*` before the first Console login.

### Stage A — session-only proving

Run `Provision LifeSpace Console staging` with `platform_admin_user_id` left blank.

The workflow will:

1. validate repository checks and staging authority;
2. converge Core staging to the branch schema/Kernel contract;
3. converge Identity staging to the branch schema/contract;
4. create/reconcile `app_lifespace_console_staging` with the complete Console scope ceiling;
5. register the fixed staging Access AUD;
6. rotate a fresh server-only `lsa_*` in-run;
7. deploy `lifespace-console-staging` with `IDENTITY_APPLICATION_CREDENTIAL`;
8. verify `lifespace-staging.aisr.online` is reachable behind Access;
9. revoke superseded Console application credentials only after successful deployment.

Stage A does **not** assign platform-admin authority and does not create a Core executor.

After it succeeds, open the staging Console through Cloudflare Access. `/api/session` displays the globally resolved LifeSpace `usr_*` for the verified Access principal.

### Stage B — full platform-admin proving

Rerun the same workflow with:

```text
platform_admin_user_id=<usr_* shown by Stage A>
```

The workflow will again verify/converge Core and Identity, then:

1. reconcile the Console Application and Access AUD;
2. bootstrap/refresh that `usr_*` as a LifeSpace platform administrator;
3. create/reconcile the dedicated least-privilege Core executor;
4. rotate fresh one-time `lsa_*` and `lsp_pat_*` credentials in-run;
5. pass those credentials to Wrangler through an ephemeral mode-0600 secrets file;
6. deploy the Console Worker;
7. verify the staging hostname;
8. revoke superseded application credentials and Core executor tokens only after deployment succeeds;
9. remove the ephemeral secrets file.

The bootstrap secret remains provisioning/recovery-only and is never installed in the Console Worker. Credential plaintext is masked and is not written to the repository or retained as a long-lived GitHub secret by this workflow.

## Browser proving

After Stage A:

```text
Open https://lifespace-staging.aisr.online
-> pass Cloudflare Access
-> confirm /api/session is linked
-> copy the displayed usr_*
```

After Stage B:

```text
Open the Console again
-> confirm /api/session resolves the same usr_*
-> click “验证控制面”
-> /api/platform/probe must pass the bounded Identity/Core read-only checks
```

For scripted allow/deny E2E, `infra/scripts/verify-staging-console-admin.mjs` can additionally use a real raw Access assertion.

If the Access principal is valid but not linked, the Console returns an explicit account-link-required state. It does not create or merge a LifeSpace account by email.

## Canonical provisioning scripts

```text
infra/scripts/prepare-staging-console-shell.mjs
infra/scripts/prepare-staging-console-admin.mjs
infra/scripts/verify-staging-console-admin.mjs
```

Direct operator execution of the full reconciliation script requires:

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

Local vars point to:

```text
Identity: http://127.0.0.1:8788
Core:     http://127.0.0.1:8787
```

Set local Worker secrets through Wrangler development secrets/environment rather than source code. A local request without a valid Access assertion intentionally fails `/api/session` and `/api/platform/probe`; `/api/health` remains available for shell/build verification.

## Final frontend direction

After the staging Access/control-plane chain is accepted, keep the Worker/BFF and deployment model, then replace the proving-page presentation with:

- React;
- TypeScript;
- Vite;
- Cloudflare Vite plugin / Workers Static Assets.

The full MVP pages are specified in `docs/lifespace-console-mvp.md`.

No production deployment is part of the staging proving flow.