# LifeSpace Admin Agent Instructions

`apps/admin` is the owner-controlled LifeSpace platform control plane. It is protected by Cloudflare Access and acts as a same-origin BFF for privileged platform administration.

## Boundaries

- Browser JavaScript must never receive Identity bootstrap secrets, Core service tokens, signing keys, or other platform-administration credentials.
- Every privileged `/api/*` request must verify the Cloudflare Access JWT in `Cf-Access-Jwt-Assertion`; do not trust a client-supplied email header as authentication.
- Admin may call Identity and Core only through authenticated service interfaces / Cloudflare Service Bindings. It must never bind or query Identity/Core D1 databases directly.
- Application registration is orchestration, not a new source of truth: Identity remains authoritative for Application/credential state and Core remains authoritative for Application × Model Access.
- A failed multi-service onboarding must fail closed. Compensate Identity state when Core authorization configuration fails; never report a partially configured application as ready.
- Newly created secrets are displayed exactly once and must not be logged or persisted by Admin.
- Keep staging and production Access applications, Worker bindings and secrets isolated.

## MVP scope

The first Admin surface intentionally prioritizes the application-onboarding path:

1. authenticate the operator with Cloudflare Access;
2. read published models from Core;
3. create a registered Application in Identity;
4. create a one-time `lsa_*` credential when a trusted backend is requested;
5. configure the application's Core model-access catalog;
6. return the resulting application id and one-time secret to the operator.

Broader dashboards, Data Explorer, AI Model Designer and full application lifecycle UI may be layered on the same BFF later without weakening these boundaries.
