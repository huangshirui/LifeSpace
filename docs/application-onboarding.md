# LifeSpace Application Onboarding

Status: **implemented as Admin MVP; staging runtime proof pending**

Updated: 2026-08-14

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
