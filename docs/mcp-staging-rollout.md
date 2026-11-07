# Core-owned OAuth MCP Staging rollout (owner-controlled)

**Status: release candidate; not yet deployed or E2E-accepted.** This is a cross-repository
integration gate, not a new Connection Registry, Cloudflare Managed OAuth or Production launch.

## Expected service graph

```text
MCP Client → https://core-staging.aisr.online/mcp/{mcp_*}
           → Core staging: live enabled Server check
           → MCP_ADAPTER (private Service Binding)
           → lifespace-mcp-adapter-staging (no public URL)
           → IDENTITY: lifespace-identity-staging (OAuth introspection, short-lived Agent Direct JWT)
           → CORE: lifespace-core-staging (selected Space, per-model Grant, per-tool query)
Authorization browser: auth-staging.aisr.online → account-staging.aisr.online
```

The public endpoint and its RFC 9728 document use **the same exact Core host and
Server ID**. Account browser SSO remains behind Cloudflare Access; an MCP Resource
request **must not** be intercepted by an Access sign-in redirect. Only Identity
accepts the opaque public OAuth token; the Adapter cannot bypass Core Grants.

## Prerequisites (no deployment unless all satisfied)

1. Review and merge **LifeSpace #480 before dependent #485**, and **Adapters #29
   before dependent #30**. Do not deploy one stack on an old parent revision.
2. Both repositories' latest combined CI must pass, including synthetic 20-model
   batch tests, no-token/invalid-token metadata challenge and disabled/removed
   tool tests. The Cloudflare Worker-to-Worker request budget is 32 invocations.
3. In **lifespace-adapters**, the owner must configure a protected GitHub
   `staging` Environment containing `CLOUDFLARE_API_TOKEN`,
   `CLOUDFLARE_ACCOUNT_ID` and a random, 32+-character
   `LIFESPACE_STAGING_OAUTH_RESOURCE_SERVER_SECRET`. This **same** value
   must also be installed in **LifeSpace Identity Staging** as
   `OAUTH_RESOURCE_SERVER_SECRET`; an Adapter-only secret does not suffice.
   Never expose, commit or print the value.
4. Confirm `lifespace-core-staging` and `lifespace-identity-staging` exist
   in the **same Cloudflare account**. Preserve HomeMew/n8n existing production
   Service and Agent credentials. Core/Identity's shared internal secret must
   remain converged. Verify Current Core MCP schema is already migrated.

## Exact release order

1. Run the *owner-only manual* **Deploy private LifeSpace MCP adapter staging**
   GitHub workflow in `lifespace-adapters` on reviewed `main`. It uses
   `adapters/mcp/wrangler.staging.jsonc`, disables workers.dev and previews,
   declares no routes, binds private CORE and IDENTITY, and puts the Resource
   Server secret without logging it. A failure here blocks the later Core deploy.
2. Confirm the secret is installed on Identity Staging. Deploy the reviewed
   LifeSpace **Identity/Core** `main` using the normal protected platform
   Staging release. Core staging alone adds the `MCP_ADAPTER` binding to
   `lifespace-mcp-adapter-staging`; **Production Core has no such binding**.
   The Identity staging `CORE` binding resolves current `mcp_*` enabled
   state before OAuth/Consent.
3. Create/enable a harmless `mcp_*` Server with one read-only published model
   on an isolated Staging Space/Agent. Ensure Account shows the actual
   Application, Space, Agent, execution mode and *requested* read capability.
   An Agent Direct read does not imply User Delegation. Do not reuse real user data.
4. Set `LIFESPACE_STAGING_MCP_RESOURCE_URI` to the exact
   `https://core-staging.aisr.online/mcp/{mcp_*}` URL and run
   `node infra/scripts/verify-staging-mcp-server-wire.mjs`. Passing checks
   only RFC 9728 document, Identity issuer+PKCE metadata, Bearer 401 challenge
   and invalid-token denial — **not OAuth/Consent/data E2E**.
5. Run a *real* registered Staging OAuth client through Authorization Code+PKCE,
   Account browser Consent, token exchange, stateless `server/discover` /
   `tools/list` / `tools/call` (or legacy `initialize`), and a bounded
   Core read-only query. Verify the client is unverified in Account UI.
   Validate wrong Server audience, cross-Space, disabled Server, revoked
   authorization, refresh-token replay, changed query operation, invalid
   `Mcp-Name`, and OAuth metadata mismatch all fail closed.
6. CIMD remains **disabled unless** `OAUTH_CIMD_ENABLED=1` and the exact
   `OAUTH_CIMD_ALLOWED_CLIENT_IDS` operator list is installed. Do not enable
   public anonymous client document discovery without a production-grade
   SSRF/rate-limit review. Staging can initially use an explicitly pre-registered
   OAuth test client; DCR is limited to Staging.

## Explicitly out of scope

- No Production Worker, route, OAuth secret, D1, Space, or Data Grant mutation.
- No new `conn_*`, Account database, OAuth-managed User Delegation, or
  Cloudflare Managed OAuth.
- No assumption that green CI proves live ChatGPT/Claude interoperability.
- Do not promote this work while the private Worker or client registration
  interoperability is missing.
