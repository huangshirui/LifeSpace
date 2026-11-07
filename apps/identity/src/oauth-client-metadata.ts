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

// A valid HTTPS URL is NOT sufficient to authorize an outbound fetch from
// Identity. Only operator-pinned, exact metadata document IDs are eligible.
// Host-only matching and suffix wildcard rules would reintroduce SSRF.
export function approvedCimdClientId(clientId: unknown, allowlist: unknown): clientId is string {
  if (!cimdClientId(clientId) || typeof allowlist !== "string" || allowlist.length > 8192) return false;
  const allowed = allowlist.split(/\\s+/u).filter(Boolean);
  if (allowed.length === 0 || allowed.length > 100 || new Set(allowed).size !== allowed.length) return false;
  return allowed.every(cimdClientId) && allowed.includes(clientId);
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
    || (data.token_endpoint_auth_method !== undefined && data.token_endpoint_auth_method !== "none")
    || (data.response_types !== undefined && JSON.stringify(data.response_types) !== JSON.stringify(["code"]))
    || (data.grant_types !== undefined && (!Array.isArray(data.grant_types)
      || data.grant_types.some(v => v !== "authorization_code" && v !== "refresh_token")
      || !data.grant_types.includes("authorization_code")))) return null;
  return {
    clientId, displayName: data.client_name.trim(),
    redirectUris: [...data.redirect_uris as string[]],
  };
}

export async function fetchClientMetadata(
  clientId: string,
  fetcher: typeof fetch = fetch,
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
