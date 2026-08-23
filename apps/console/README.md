# LifeSpace Console

LifeSpace Console is the LifeSpace platform operations/governance Web application for `lifespace.aisr.online`.

The current `0.1.0` implementation is the permanent **React + TypeScript + Vite + Cloudflare Worker/BFF read-only MVP shell**. The earlier dependency-light `public/` proving page has been removed; the security/deployment boundary it proved remains.

## Current UI

```text
Overview
Platform
  Applications
  Models
  Users
  Spaces
Operations
  Audit
  System
```

This slice is intentionally read-only. Application/credential/audience/service-token mutations, Application × Model Access writes, and Model validate/publish/retire UI are deferred to a later slice.

## Same-origin BFF routes

```text
GET  /api/health
GET  /api/session
POST /api/session/register   # staging first-use only
GET  /api/platform/probe     # retained staging/control-plane verifier
GET  /api/overview
GET  /api/applications
GET  /api/applications/:applicationId
GET  /api/models
GET  /api/models/:modelKey
GET  /api/users
GET  /api/users/:userId
GET  /api/spaces
GET  /api/spaces/:spaceId
GET  /api/audit
GET  /api/system
```

The browser talks only to these same-origin routes. It does not know Identity/Core service URLs or supply upstream authorization/path data.

## Security chain

For every privileged read, the Worker performs:

```text
Cloudflare Access assertion
-> LifeSpace Identity Access exchange
-> app-scoped LifeSpace user credential
-> <=5-minute purpose=platform_admin_actor proof
-> controlled server-side executor
-> fixed Identity/Core Platform Admin operation
```

Identity control-plane calls use:

```text
Authorization: Bearer <Console lsa_*>
X-LifeSpace-Actor-Token: <actor proof>
```

Core control-plane calls use:

```text
Authorization: Bearer <Console service executor>
X-LifeSpace-Actor-Token: <actor proof>
```

The following never cross the Worker/browser boundary:

- raw `Cf-Access-Jwt-Assertion` value;
- LifeSpace user bearer;
- platform-admin actor JWT;
- `lsa_*` application credential;
- `lsp_pat_*` Core executor;
- bootstrap secret.

The BFF validates identifiers and query allow-lists/result bounds before composing an upstream request. It is not an arbitrary Identity/Core reverse proxy or Swagger executor.

## First-use Access identity

A valid Cloudflare Access session can be unknown to LifeSpace Identity. That is intentional: Access email is diagnostic metadata, not account-merge authority.

The canonical model remains:

```text
unknown verified Access principal
  -> explicit create-new-user
  OR
  -> proof-backed link-existing-user challenge
```

`POST /api/session/register` exists only for staging first-use proving. It:

- requires an exact same-origin browser request;
- requires `Sec-Fetch-Site: same-origin`;
- requires `x-lifespace-console-intent: register-current-access-principal`;
- accepts only a display name;
- forwards the current verified Access assertion to Identity's canonical `/internal/v1/access/registrations` flow;
- cannot select a target `usr_*`, Access subject, email mapping or backend credential;
- is unavailable in production.

If the operator already owns a staging LifeSpace user, they must use the proof-backed Identity linking flow rather than creating another user.

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

Service Bindings are transport only; explicit LifeSpace credentials remain the authorization boundary.

Worker secrets in full-admin mode:

```text
IDENTITY_APPLICATION_CREDENTIAL  # server-only lsa_*
CORE_EXECUTOR_BEARER             # dedicated lsp_pat_* executor
```

The global bootstrap secret is deliberately not a Console Worker secret.

## Application identifiers

Platform Admin must support LifeSpace applications created before generated `app_*` IDs became the default. Existing target IDs therefore accept the canonical semantic identifier form:

```text
^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$
```

New applications created through Platform Admin still receive generated `app_*` IDs.

## Cloudflare/Vite deployment

The Console uses `@cloudflare/vite-plugin`. Vite owns the built client asset directory and generates the Worker deployment configuration.

Select the target environment at **build time**:

```text
CLOUDFLARE_ENV=staging pnpm exec vite build
pnpm exec wrangler deploy --secrets-file <ephemeral-secrets-file>
```

For production the build environment would be `production`, but production deployment is outside this slice and requires explicit approval.

Do not restore the old `assets.directory: ./public` proving-shell configuration. The React build output is the deployed client asset source.

## Canonical staging workflow

```text
.github/workflows/lifespace-console-staging-provision.yml
```

It remains staging-only and performs:

```text
frozen workspace install + repository checks
-> Core migrations/deploy/convergence
-> Identity migrations/deploy/convergence
-> Console application/AUD reconciliation
-> optional platform-admin/Core-executor provisioning
-> CLOUDFLARE_ENV=staging Vite build
-> Worker deploy using generated config and ephemeral secrets
-> hostname check
-> revoke superseded credentials/tokens only after successful deploy
-> remove ephemeral secret file
```

### Session-only first-use run

Run with `platform_admin_user_id` blank only when the current Access principal still needs to be explicitly registered/linked and its staging `usr_*` is unknown.

This mode installs only the Identity application credential. Platform pages that require actor proof/Core executor are expected to remain unavailable until full-admin provisioning.

### Full platform-admin run

Run again with the exact staging `usr_*` after it has been resolved. The workflow then reconciles:

- `platform_administrators` assignment;
- exact-scope Console Core service executor;
- fresh one-time `lsa_*` and `lsp_pat_*` credentials;
- Worker secrets through an ephemeral mode-0600 file.

The workflow must never infer the user from email and must never use a production user/resource as a substitute.

## Verification

Before this slice is Ready:

1. `pnpm install --frozen-lockfile` and full `pnpm check` pass;
2. React/Worker TypeScript and Vite build pass;
3. staging deploy uses the generated Vite deployment configuration;
4. missing Access assertion fails safely;
5. unlinked Access principal is explicit and never email-auto-created/merged;
6. non-admin actor is denied;
7. actor/executor application mismatch is denied;
8. browser source/network responses contain no Access/LifeSpace/actor/executor bearer material;
9. real staging browser verification covers Overview, Applications, Models, Users, Spaces, Audit and System;
10. production remains untouched.

Canonical platform/security specification: `docs/lifespace-console-mvp.md`.
