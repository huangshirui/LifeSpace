# LifeSpace Application Onboarding

Status: **Admin MVP deployed to staging; browser operator E2E pending**

Updated: 2026-08-15

## Purpose

Registering a new product application is a LifeSpace Kernel/control-plane operation. A new ALOHA, HomeMew, Mini Program, Web application, device product or future vertical application must not require hand-editing Identity/Core D1 data, adding one-off migrations, or modifying ordinary-model runtime code merely to become a registered LifeSpace client.

The initial control plane is `apps/admin`, an owner-controlled Web Admin protected by Cloudflare Access.

## Source-of-truth boundaries

Application onboarding coordinates existing authoritative services; Admin is not a third source of truth.

- **Identity** owns Application identity, client type, status, stable scope ceiling, trusted-backend classification, user-token TTL and `lsa_*` Application credentials.
- **Core** owns Application × Model Access (`read` / `write` / `manage`) and continues to intersect it with credential scope, current Space Membership/Data Grant, published-model capabilities and model policy.
- **Admin** owns only the operator experience and orchestration. It does not persist Application or authorization records and does not bind either service's D1 database.

Application registration never grants Space data by itself.

## Runtime flow

```text
Operator browser
  -> Cloudflare Access
  -> apps/admin same-origin Worker/BFF
       -> verify Cf-Access-Jwt-Assertion
       -> generate app_* id
       -> Identity Service Binding
            POST /bootstrap/v1/applications
            optional one-time lsa_* credential
       -> Core Service Binding
            PUT /internal/v1/application-model-access/{applicationId}
            authenticated as a service principal with models:manage
       -> return application metadata + one-time lsa_* secret to operator
```

The Core application-model-access route is deliberately an internal service interface. It is not a downstream client API and is not part of the public Core Kernel OpenAPI. Ordinary applications cannot call it merely because they can read/write a Space.

## Cloudflare Access boundary

`admin-staging.aisr.online` and `admin.aisr.online` are separate Cloudflare Access Applications with environment-specific policies.

Cloudflare Access is the human authentication/perimeter layer. The Admin Worker additionally validates the Access JWT signature, issuer, audience and lifetime for privileged `/api/*` requests. It does not accept an email header as sufficient authentication.

The browser never receives:

- the Identity bootstrap secret;
- the Admin's `lsp_pat_*` Core service token;
- signing keys or other platform administration secrets.

A newly generated `lsa_*` Application credential is the onboarding output and may be displayed to the authenticated operator exactly once. Admin must not persist or log it.

## Registration input

The MVP registration request contains:

- display name;
- client type: `web`, `mini_program`, `service`, or `device`;
- whether the Application has a trusted backend/BFF;
- stable Identity `allowedScopes` ceiling;
- user-token TTL (300–3600 seconds);
- zero or more published model-access entries `{ modelKey, maxAccess }`.

Admin generates the opaque `app_*` identifier. Human product naming is metadata rather than the security identifier.

## Authorization result

Onboarding configures maximum application authority only. Runtime ordinary-model access remains:

```text
verified principal
∩ current credential resources:* scope
∩ current Application × Model Access
∩ current Space Membership / Data Grant
∩ published Model access capability
∩ Model / Capability policy
```

Publishing a new model does not automatically expose it to an existing Application. It must receive an explicit Application × Model Access entry.

## Failure and compensation

Identity and Core intentionally remain separate databases, so onboarding is not implemented as a distributed database transaction.

The MVP uses a fail-closed saga:

1. Create the Application and optional credential in Identity.
2. Replace that Application's model-access catalog in Core.
3. If Core rejects or fails the second step, immediately disable the new Identity Application and revoke every active credential created for it.
4. Return failure rather than a ready Application.
5. If compensation itself cannot complete, report `compensated: false` so an operator can repair the disabled/partial state explicitly; never claim rollback succeeded when it did not.

The Core catalog replacement uses one D1 batch for the delete-and-insert set.

## Administration credentials

The MVP Admin uses two server-side, environment-specific administration credentials:

- `IDENTITY_BOOTSTRAP_SECRET` for the existing Identity bootstrap administration surface;
- `CORE_ADMIN_TOKEN`, an opaque `lsp_pat_*` token for a service principal scoped to `models:manage`.

The global Identity bootstrap secret remains a platform-administration credential and must never become an Application runtime credential. A later dedicated scoped Identity operator API may replace its use inside Admin without changing the Application onboarding model.

### Staging authority bootstrap

Staging keeps Admin deployment isolated from the normal Core/Identity deployment workflow. `.github/workflows/admin-staging-deploy.yml` deploys `lifespace-admin-staging` only after the existing staging platform is reachable.

`infra/scripts/initialize-staging-admin-runtime.mjs` reconciles a dedicated `app_lifespace_admin_staging` Identity Application and service principal whose only scope is `models:manage`. On each Admin staging deployment it creates a replacement non-expiring, individually revocable `lsp_pat_*`, verifies that token against Core's internal Application × Model Access interface, writes the token directly into the Admin Worker secret store, and only then revokes previous active Admin runtime tokens. The temporary `lsa_*` used to administer that service principal is also revoked before the workflow exits.

The staging workflow therefore requires only two new non-secret GitHub Environment variables after the Cloudflare Access Application exists:

- `LIFESPACE_STAGING_ADMIN_ACCESS_TEAM_DOMAIN`;
- `LIFESPACE_STAGING_ADMIN_ACCESS_AUD`.

The Team Domain input accepts either `<team>.cloudflareaccess.com` or the full `https://<team>.cloudflareaccess.com` form and is normalized to HTTPS before being written to the Worker secret.

It reuses the existing staging `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `LIFESPACE_STAGING_BOOTSTRAP_SECRET`. No Admin runtime credential plaintext is committed to the repository or exported as a workflow artifact.

The workflow also fails if an unauthenticated request to `admin-staging.aisr.online` returns HTTP 200. This proves the Access perimeter is intercepting anonymous traffic, but it does not replace the final human sign-in / browser onboarding proof.

### Staging runtime proof — 2026-08-15

The application-onboarding branch was deployed to staging and verified in two layers:

- `Deploy staging` run #31 (`31893264882`) successfully deployed and converged the Core/Identity branch changes, including the internal Application × Model Access control-plane route, and passed the full staging regression suite.
- `Deploy Admin staging` run #4 (`31894039940`) successfully deployed `lifespace-admin-staging`, initialized and installed the dedicated `models:manage` service authority, rotated prior Admin runtime tokens after secret replacement, and proved that an unauthenticated request to `admin-staging.aisr.online` is intercepted by Cloudflare Access.

The temporary branch-only push trigger used to prove a workflow that had not yet landed on the default branch was removed after the run. Normal Admin staging deployment remains explicit `workflow_dispatch` only.

The remaining staging proof is browser-level: an authorized operator must sign in through Cloudflare Access and complete one real application registration, including one-time `lsa_*` output and selected Core Application × Model Access.

Production uses a separate Access Application, application/service authority and Worker secrets; staging authority is never promoted or copied into production.

## Contract boundary

Application onboarding does not create a new ordinary model contract. The Application receives access to selected currently published models; downstream releases still pin explicit compatible Core Kernel + Model Contract revisions through the existing contract workflow.

The internal Core model-access administration route is control-plane implementation detail, not a public downstream contract. Any future public/delegated Application management API requires a separate contract/security decision.

## MVP completion criteria

The first core flow is complete when staging proves all of the following:

1. Cloudflare Access admits an authorized operator and the Worker independently verifies its JWT.
2. Admin can list currently published models.
3. Register creates an `app_*` Identity Application.
4. A trusted backend receives one `lsa_*` plaintext exactly once.
5. Selected Application × Model Access rows are present in Core.
6. The `lsa_*` credential can subsequently authenticate the registered backend under its configured scope ceiling.
7. Core authorization observes the configured Application × Model Access.
8. A forced Core configuration failure leaves no active newly issued Application credential.
