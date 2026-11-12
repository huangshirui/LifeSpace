# CIMD isolated public HTTPS transport / CIMD 安全出站

This is a dependency-free Node.js 24 infrastructure component, not an OAuth
server, public web proxy, LifeSpace application, or authority service.

- POST /api/cimd, authenticated with CIMD_EGRESS_SHARED_SECRET (64 lowercase hex
  characters, generated independently per environment).
- Body: exactly {"client_id":"https://public.example.org/metadata.json"}.
- Successful result: bounded JSON document (max 8192 bytes), with exact client_id.
  No upstream headers, redirects, user credentials, status details or arbitrary
  fetch methods are exposed. All failures fail closed.
- DNS: query A and AAAA, reject the whole result if any address is special-use,
  non-public or malformed. Connect to one of those already verified literal
  IPs, preserve original Host/SNI, verify the original hostname's certificate
  and compare the actual peer address. No second DNS lookup, proxy, redirect
  following or TLS bypass. IANA IPv4/IPv6 special-purpose ranges are blocked;
  IPv6 requires ordinary global unicast.
- Host in an isolated public-network Node runtime with no private network/VPC
  routes, database, Core/Identity credentials or user data. It must support
  ordinary outbound TCP/TLS to public IPv4 and IPv6. Do not use Workers
  node:https emulation or raw Workers sockets (Cloudflare address limitations).
- Identity checks the document again, including callback and public-client
  capabilities. Metadata lookup confers no authorization, grant or token.

## Local check

    node --test infra/cimd-egress/test/*.test.mjs

The deterministic tests verify address classes, mixed DNS answers, literal
connection options, original Host/SNI, certificate and peer checks, no
re-resolution, no redirects, bounded JSON and authentication. They are not
evidence of a deployed provider's actual network path.

## Staging deployment / 上线

The package is portable; a standalone Vercel Node.js 24 project is one
candidate, not a platform dependency. The provided Vercel config assumes the
project root is infra/cimd-egress. Deploy only this directory, with the
independent secret CIMD_EGRESS_SHARED_SECRET injected as a protected runtime
environment variable. Do not link an automatic Git deployment to LifeSpace
Staging/Production; keep release actions explicit. Use an isolated project
without private networking. Actual provider compatibility, including
outbound IPv6, must be verified; do not claim successful production operation
from unit tests alone.

In GitHub LifeSpace Settings -> Environments -> staging:

- Variable LIFESPACE_CIMD_ENABLED=1 (defaults to 0).
- Variable OAUTH_CIMD_EGRESS_URL = exact deployed HTTPS endpoint ending /api/cimd.
- Secret OAUTH_CIMD_EGRESS_SECRET = the same independent relay secret. Generate
  with openssl rand -hex 32; never paste into chat or commit.

Run the canonical owner-dispatched Staging deployment. Before mutating
LifeSpace it checks real relay authentication, public metadata from two
independent hosts and private DNS rejection. It then provisions the dedicated
Worker secret and the deployment-owned endpoint/flag, audits deployed
configuration, and checks real CIMD registration and pending Consent for
both public fixtures, exact callback denial and private-DNS denial. The
script removes only its nonce-bound pending requests; the stable official
client registration may remain. No human consent or token issuance is
manufactured. Existing Token lifecycle acceptance is reused.

If preflight fails, do not activate CIMD; keep LIFESPACE_CIMD_ENABLED=0.
To disable the incident switch, set the variable to 0 and run the canonical
owner deployment. No DNS-edit token is required. Production uses separate
infrastructure and secrets and is not activated by this candidate.
