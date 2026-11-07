# MCP OAuth: Platform / Application / Account

## Ownership

| Owner | Responsibility |
| --- | --- |
| **LifeSpace Console** | Only two protocol switches (CIMD and DCR) plus one optional **Allowed callback URLs** list. Platform security, abuse protection, logging and client disablement remain server-side. |
| **Application / MCP Server** | Which models, tools, actions, scopes and execution modes the application exposes. Live Core permission checks still apply. |
| **Account** | User chooses Application, Space, Agent, execution mode and data scopes on Consent; user can review and revoke their own authorizations. |

**No platform administrator should need to register each ChatGPT/Claude/user callback URL.**
OAuth client registration never implies a user Grant or Delegation.

## Simplified Console OAuth settings (Identity schema 18)

- **CIMD** switch enables protected automatic discovery of eligible public HTTPS
  Client ID Metadata Documents. Identity validates the document, prevents
  redirects and invalid metadata, pins registered callbacks, imposes a
  Staging admission rate limiter and a bounded D1 client quota. An unverified
  client name is **not** vendor identity proof.
- **DCR** switch enables protected dynamic client registration with validated
  callbacks, rate limit and an atomic D1 client quota.
- **Allowed callback URLs** is **one optional platform-wide exact-match list**.
  Empty (default) means no **additional** platform limitation. With entries,
  the registered client's requested redirect must also be in the list.
  **Every** OAuth authorization and token exchange still checks the
  requesting client's own registered callback exactly, including when
  the platform list is empty. No URL wildcards are accepted. Native local
  loopback redirects follow the existing per-client validation.
- Existing schema 17 strict CIMD/DCR allowlists are retired. Migration
  `0018` disables a previously enabled *restricted* method before switching
  it to automatic mode; an administrator must explicitly re-enable it.
  Existing *open* methods remain enabled. Existing explicitly restricted
  global callback URLs remain in place. This avoids accidentally granting
  broader registration authority on deployment.
- Runtime `OAUTH_CIMD_ENABLED` and `OAUTH_DCR_ENABLED` are independent
  environment kill switches, not user-facing allowlists. Staging has
  `OAUTH_DCR_RATE_LIMITER`; Production does not automatically activate
  open client registration and needs an independent SSRF/DNS rebinding and
  abuse review.

## Expected journey

1. User connects a compatible MCP Server from ChatGPT/Claude/etc.
2. Identity accepts safe automatic client metadata discovery (CIMD) or DCR,
   without a Console visit for that user's callback.
3. Account displays the actual client request and the requested MCP resource.
   User chooses Application/Space/Agent and explicitly consents.
4. Identity issues a resource-bound token. Core restricts the caller to
   the current published MCP tools, application model policy and Grants.
5. User revokes or manages the authorization in Account.

Where supported by the client, RFC 9207 stable ChatGPT OAuth redirect uses
`https://chatgpt.com/connector_platform_oauth_redirect` after Identity
advertises the issuer response parameter and includes matching `iss` on
both successful and user-declined Consent responses. The client must still
register this exact redirect.

## Staging acceptance

Deploy Identity migrations before the Identity Worker, then separately
deploy Console Staging. Confirm the Console has just two switches and one
optional callback field, and that disabled switches remove their OAuth
discovery advertisement. Verify CIMD and DCR auto registration, both
registered callback exactness and optional global callback restrictions,
PKCE, the Account consent and denial callbacks, cross-MCP-resource
isolation, Token revocation, rate limiter failures and client quota.
Production is not approved until the additional outbound-metadata
security and abuse review is complete.
