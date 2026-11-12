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
  const allowed = allowlist.split(/\s+/u).filter(Boolean);
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

// Defense in depth only: DNS preflight does not pin the address used by fetch.
 // Cloudflare strict-public global fetch is the connection/network boundary.
const V4_SPECIAL = [
  ["0.0.0.0",8], ["10.0.0.0",8], ["100.64.0.0",10], ["127.0.0.0",8],
  ["169.254.0.0",16], ["172.16.0.0",12], ["192.0.0.0",24], ["192.0.2.0",24],
  ["192.31.196.0",24], ["192.52.193.0",24], ["192.88.99.0",24], ["192.168.0.0",16],
  ["192.175.48.0",24], ["198.18.0.0",15], ["198.51.100.0",24],
  ["203.0.113.0",24], ["224.0.0.0",4], ["240.0.0.0",4],
] as const;
const V6_SPECIAL = [
  ["2001::",23], ["2001:db8::",32], ["2002::",16], ["2620:4f:8000::",48], ["3fff::",20],
] as const;
function ipv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some(p => !/^(0|[1-9][0-9]{0,2})$/u.test(p) || Number(p) > 255)) return null;
  return parts.map(Number);
}
function ipv6(value: string): number[] | null {
  if (!/^[0-9a-f:]+$/iu.test(value)) return null;
  let normalized: string;
  try { normalized = new URL("https://[" + value + "]/").hostname.slice(1,-1); } catch { return null; }
  const [left, right] = normalized.split("::");
  const a = left ? left.split(":") : [];
  const b = right ? right.split(":") : [];
  const words = right === undefined ? a : [...a, ...Array(8-a.length-b.length).fill("0"), ...b];
  if (words.length !== 8) return null;
  return words.flatMap(word => { const n = parseInt(word,16); return [n >> 8,n & 255]; });
}
function inPrefix(address: number[], base: number[], bits: number): boolean {
  return address.every((byte,i) => {
    const n = Math.max(0,Math.min(8,bits-i*8));
    const mask = (255 << (8-n)) & 255;
    return (byte & mask) === (base[i] & mask);
  });
}
export function ordinaryPublicIp(value: unknown, family: 4 | 6): boolean {
  if (typeof value !== "string") return false;
  if (family === 4) {
    const address = ipv4(value);
    return address !== null && !V4_SPECIAL.some(([base,bits]) => inPrefix(address,ipv4(base)!,bits));
  }
  const address = ipv6(value);
  return address !== null && inPrefix(address,ipv6("2000::")!,3)
    && !V6_SPECIAL.some(([base,bits]) => inPrefix(address,ipv6(base)!,bits));
}
export async function precheckCimdDns(host: string, fetcher: typeof fetch): Promise<boolean> {
  try {
    const query = async (family: 4 | 6): Promise<number> => {
      const type = family === 4 ? 1 : 28;
      const url = "https://cloudflare-dns.com/dns-query?name=" + encodeURIComponent(host) + "&type=" + type;
      const response = await fetcher(url, { method:"GET", redirect:"error", signal:AbortSignal.timeout(2000),
        headers:{accept:"application/dns-json"} });
      if (!response.ok) throw Error("DNS_UNAVAILABLE");
      const raw = await response.text();
      if (raw.length > 16384) throw Error("DNS_TOO_LARGE");
      const result = JSON.parse(raw) as {Status?: number; TC?: boolean; Answer?: Array<{type:number;data:unknown}>};
      if (result.Status !== 0 || result.TC === true || (result.Answer !== undefined && !Array.isArray(result.Answer))) throw Error("DNS_UNAVAILABLE");
      const answers = result.Answer ?? [];
      if (answers.length > 32 || answers.some(a => !a || (a.type !== 5 && (a.type !== type || !ordinaryPublicIp(a.data,family))))) throw Error("DNS_TARGET_DENIED");
      return answers.filter(a => a.type === type).length;
    };
    const counts = await Promise.all([query(4),query(6)]);
    return counts[0] + counts[1] > 0;
  } catch { return false; }
}

export async function fetchClientMetadata(
  clientId: string,
  fetcher: typeof fetch = fetch,
): Promise<PublicOAuthClientMetadata | null> {
  if (!cimdClientId(clientId) || !await precheckCimdDns(new URL(clientId).hostname, fetcher)) return null;
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
