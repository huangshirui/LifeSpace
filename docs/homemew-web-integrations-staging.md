# HomeMew Web external integrations — staging provisioning

Updated: 2026-08-24

## Status

W4 HomeMew Web external-integration runtime is provisioned through the existing LifeSpace-owned staging workflow:

```text
.github/workflows/homemew-web-staging-provision.yml
```

This document describes staging only. It does not authorize or perform any production change.

## Authority split

HomeMew Web uses two distinct LifeSpace application contexts.

### Browser Web application

```text
app_homemew_web_staging
```

Its normal browser session continues to request the ordinary HomeMew Web scopes only. The registered application scope ceiling additionally includes:

```text
grants:manage
```

That extra ceiling exists solely so the same-origin HomeMew integration BFF can perform an on-demand Cloudflare Access -> LifeSpace exchange for:

```text
profile:read grants:manage
```

The ambient browser session does not receive `grants:manage`.

### Dedicated integrations application

```text
app_homemew_integrations_staging
```

This application is a trusted server-side application context used by the HomeMew BFF to create and manage service principals and their opaque `lsp_pat_*` credentials through Identity self-service APIs.

Its exact stable scope ceiling is:

```text
resources:read
resources:write
```

It is not granted `grants:manage`, Space-management scopes, platform-admin scopes or model-administration scopes.

The application credential is an `lsa_*` held only by the HomeMew Worker as:

```text
LIFESPACE_INTEGRATIONS_APPLICATION_CREDENTIAL
```

Browser JavaScript never receives this value.

## Application × Model Access

The dedicated integrations application has a platform ceiling of:

| Model | Maximum access |
| --- | --- |
| `event` | `write` |
| `task` | `write` |
| `day_record` | `write` |

No `wish` access is provisioned for this W4 surface.

This catalog ceiling does not itself grant a service principal access to household data. A HomeMew household administrator must still create explicit model-scoped Data Grants for the service principal in the selected Space.

## Effective external-system authority

A generated `lsp_pat_*` can operate only at the intersection of:

```text
active service principal
∩ token scopes
∩ integrations application scope ceiling
∩ Application × Model Access
∩ current model-scoped Data Grants
∩ published model capability/policy
```

HomeMew does not create hidden Space membership for external systems.

## Provisioning flow

`infra/scripts/prepare-staging-homemew-web-integrations.mjs` is idempotent and staging-gated. It:

1. verifies the target Identity environment is staging;
2. ensures `app_homemew_web_staging` can request `grants:manage` on demand;
3. creates/reconciles `app_homemew_integrations_staging` with only `resources:read/write`;
4. rotates a one-time `lsa_*` application credential;
5. reconciles Core Application × Model Access for `event`, `task` and `day_record` only;
6. installs the credential directly into `homemew-web-staging` through the Cloudflare Worker Secrets API;
7. proves the credential can reach its own Identity service-principal management surface;
8. revokes superseded integrations application credentials only after replacement installation and verification.

The workflow separately preserves the existing base HomeMew Web application credential and Web session-secret provisioning.

## Staging acceptance

Platform provisioning is complete when the LifeSpace staging workflow passes and HomeMew staging reports:

```text
Base runtime secrets: ready
W4 integrations runtime: configured
```

Full W4 product acceptance then additionally requires an authenticated HomeMew household administrator to:

1. create an external system;
2. select model permissions;
3. create an opaque `lsp_pat_*` token;
4. verify n8n/curl read and write operations allowed by those Grants;
5. verify an ungranted model/operation is denied;
6. verify token rotation/revocation and principal disablement remove authority as designed.

## Production boundary

No production LifeSpace application, Core catalog, Worker secret, route or HomeMew traffic is changed by this staging workflow. Production provisioning requires a separate explicit rollout decision after staging acceptance.
