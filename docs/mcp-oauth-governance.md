# MCP OAuth: Platform / Application / Account ownership

**Decision (2026-11-07):** ordinary users connect a compatible third-party
client without opening a platform-admin ticket or asking Console to approve a
callback URL for each MCP connection.

## Three levels of authority

| Owner | Policy / action |
| --- | --- |
| LifeSpace **Console** | Enables supported OAuth client admission methods (CIMD, DCR), chooses protected automatic vs restricted mode, configures optional global exact callback restrictions, audits administrators, limits abuse and disables suspicious clients. Does **not** grant access to user information. |
| **Application** / MCP Server settings | Controls which Application-owned MCP Server, models, tools, actions and maximum grants are published. Core applies current live Server and model policy on each invocation. Does **not** register an OAuth client for each user. |
| **Account** | On each OAuth Consent transaction shows unverified client origin and exact requested MCP Resource; user chooses Application, Space, Agent execution mode and scopes. User manages and revokes their own resulting authorizations/connections. No platform administrator is needed. |

Client **registration** (CIMD metadata discovery or DCR) is not user authorization.
A self-reported DCR client name is not proof of owning the vendor brand.
CIMD metadata is untrusted public information; the browser Consent must show
actual redirect origin and not silently grant User Delegation.

## Global platform registration policy (Identity schema 17)

Stored in Identity D1 and edited from Console → Platform → OAuth 客户端,
using Platform Admin permission, optimistic revision checking and audit.

- **CIMD**: enabled + `restricted` means exact approved metadata-document
  Client IDs; enabled + `open` means accept a syntactically valid public HTTPS
  Client ID URL, fetch strict JSON with no redirects, timeout and body cap,
  require exact Client ID and registered redirect. In Staging, public
  discovery is rate-limited; all client records have an atomic 1000-entry cap.
- **DCR**: enabled + `restricted` means exact permitted registration
  callbacks; enabled + `open` means a new client can register a validated
  public HTTPS or local native-loopback URI without advance per-user
  registration at Console. In Staging, DCR is rate-limited and capped at
  1000 registered clients; Production has a separate kill switch.
- **Allowed callback URLs**: common optional **additional** restriction:
  `client` (default) validates only the exact callbacks registered with
  that OAuth Client, or `restricted` (extra global exact-match entries)
  which applies equally to CIMD, DCR and pre-registered clients. Neither
  mode accepts `*` domain/path wildcards at authorization or token exchange.
  RFC 8252 native loopback HTTP URIs are allowed and remain scoped to the
  particular client registration.
- Migration from schema 16 preserves all existing strict allowlists and
  enabled flags; new modes default `restricted` and `client`.
  An administrator must explicitly select `open`; nothing is automatically
  promoted to open registration or Production.

## ChatGPT callback (2026)

When the OAuth issuer advertises `authorization_response_iss_parameter_supported:
true`, ChatGPT may use its stable `https://chatgpt.com/connector_platform_oauth_redirect`
and CIMD Client ID `https://chatgpt.com/oauth/client.json`.
Old connectors may continue using a callback-specific path. Do **not**
configure `https://chatgpt.com/connector/oauth/<id>` as a new global Console
requirement. The selected callback still must be in that client's current
registered redirect list; Identity emits the fixed configured `iss` on
OAuth authorization redirects, never reflecting the HTTP Host header.

## Release/acceptance gates

New schema version 17 requires Identity migrations before Identity Worker.
Console must deploy separately. Safely test in Staging: metadata discoverability,
CIMD direct URL, DCR without preconfigured callback, PKCE and redirect exactness,
live Account Consent and read-only Core query, revoked/disabled clients,
wrong MCP Server audience, cross-Space permissions, callback-policy changes,
rate-limit failures and quota exhaustion. Do not declare open-mode Production
approved without a separate SSRF/DNS rebinding and abuse review. Do not migrate
old `conn_*` architecture or create a new generic Connection Registry.
