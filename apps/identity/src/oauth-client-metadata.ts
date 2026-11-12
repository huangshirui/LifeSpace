// MCP 2026 Client ID Metadata Documents (CIMD), isolated from OAuth bearer
// issuance. URL client IDs are untrusted public metadata, never proof of vendor
// identity. Explicit opt-in is required before enabling network discovery.
export type PublicOAuthClientMetadata = {
  clientId: string; displayName: string; redirectUris: string[];
};
const MAX_DOCUMENT_BYTES = 8192;
const MAX_CLIENT_ID_LENGTH = 256;
const MAX_REDIRECTS = 8;

export function cimdClientId(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_CLIENT_ID_LENGTH) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.href !== value
    || url.username || url.password || url.hash || url.search
    || url.pathname === "/" || url.port || url.hostname.endsWith(".")) return false;
  const host = url.hostname.toLowerCase();
  if (host.length > 253 || /[^a-z0-9.-]/u.test(host)
    || host.startsWith(".") || host.includes("..")
    || host === "localhost" || host.endsWith(".localhost")
    || ["local", "internal", "test", "invalid", "example"].some(tld => host.endsWith("." + tld))) return false;
  const labels = host.split(".");
  if (labels.length < 2 || labels.some(label => !label || label.length > 63
    || label.startsWith("-") || label.endsWith("-"))
    || !/^[a-z]{2,63}$/u.test(labels.at(-1) || "")) return false;
  return true;
}

// The fixed relay endpoint is deployment-owned, never supplied by an OAuth
// client. The independent secret authenticates only this metadata operation.
export function cimdEgressConfigured(endpoint: unknown, secret: unknown): boolean {
  if (typeof endpoint !== "string" || !cimdClientId(endpoint)
    || typeof secret !== "string" || !/^[a-f0-9]{64}$/u.test(secret)) return false;
  return new URL(endpoint).pathname === "/api/cimd";
}

export async function fetchClientMetadataViaEgress(
  clientId: string, endpoint: string | undefined, secret: string | undefined,
  relayFetch: typeof fetch = fetch,
): Promise<PublicOAuthClientMetadata | null> {
  if (!cimdEgressConfigured(endpoint, secret) || !endpoint || !secret || !cimdClientId(clientId)) return null;
  // Only the trusted deployment endpoint receives the relay credential.
  // The client document itself is never fetched directly by Identity.
  return fetchClientMetadata(clientId, (_input, _init) => relayFetch(endpoint, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(8000),
    headers: { "content-type": "application/json", authorization: "Bearer " + secret },
    body: JSON.stringify({ client_id: clientId }),
  }));
}

export function publicRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 1024) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  const loopback = url.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return (url.protocol === "https:" || loopback) && !url.username && !url.password
    && !url.hash && !url.hostname.includes("*") && url.href === value;
}

export function parseClientMetadata(clientId: string, document: unknown): PublicOAuthClientMetadata | null {
  if (!cimdClientId(clientId) || !document || typeof document !== "object"
    || Array.isArray(document)) return null;
  const data = document as Record<string, unknown>;
  if (data.client_id !== clientId || typeof data.client_name !== "string"
    || !data.client_name.trim() || data.client_name.length > 100
    || !Array.isArray(data.redirect_uris)
    || !data.redirect_uris.length || data.redirect_uris.length > MAX_REDIRECTS
    || !data.redirect_uris.every(publicRedirectUri)
    || new Set(data.redirect_uris).size !== data.redirect_uris.length
    // Transition-era clients may publish both singular preferred auth method
    // and plural methods. The plural set must explicitly allow public "none";
    // the preferred private_key_jwt method does not prohibit using none.
    || (data.token_endpoint_auth_methods_supported !== undefined
      && (!Array.isArray(data.token_endpoint_auth_methods_supported)
        || data.token_endpoint_auth_methods_supported.length > 8
        || !data.token_endpoint_auth_methods_supported.includes("none")
        || data.token_endpoint_auth_methods_supported.some(method => typeof method !== "string")))
    || (data.token_endpoint_auth_methods_supported === undefined
      && data.token_endpoint_auth_method !== undefined && data.token_endpoint_auth_method !== "none")
    || (data.response_types !== undefined && JSON.stringify(data.response_types) !== JSON.stringify(["code"]))
    // Client grant_types describes the client's capabilities, not the
    // authorization server's supported grants. Require an overlap with our
    // authorization-code flow and validate the list shape; additional grant
    // declarations never expand the token endpoint's independent allowlist.
    || (data.grant_types !== undefined && (!Array.isArray(data.grant_types)
      || data.grant_types.length > 16 || new Set(data.grant_types).size !== data.grant_types.length
      || data.grant_types.some(v => typeof v !== "string" || !/^[\x21-\x7e]{1,256}$/u.test(v))
      || !data.grant_types.includes("authorization_code")))) return null;
  return {
    clientId, displayName: data.client_name.trim(),
    redirectUris: [...data.redirect_uris as string[]],
  };
}

export async function fetchClientMetadata(
  clientId: string,
  fetcher: typeof fetch,
): Promise<PublicOAuthClientMetadata | null> {
  if (!cimdClientId(clientId)) return null;
  let response: Response;
  try {
    response = await fetcher(clientId, {
      method: "GET", redirect: "manual", signal: AbortSignal.timeout(5000),
      headers: { accept: "application/json" },
    });
  } catch { return null; }
  // Never follow redirects to localhost, metadata-controlled redirects, or
  // a second host. The caller may never override DNS/routing via a header.
  if (response.status !== 200
    || !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/iu.test(
      response.headers.get("content-type") || "")
    || Number(response.headers.get("content-length") || "0") > MAX_DOCUMENT_BYTES) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_DOCUMENT_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    const all = new Uint8Array(length);
    let offset = 0;
    for (const part of chunks) { all.set(part, offset); offset += part.byteLength; }
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(all)) as unknown;
    return parseClientMetadata(clientId, data);
  } catch { return null; }
}
