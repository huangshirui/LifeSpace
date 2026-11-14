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
// Only fixed failure categories are emitted to operational logs by the caller.
// Never include the remote URL, response body, DNS answers or exception text.
export type CimdFailureReason =
  | "invalid_client_id" | "dns_transport" | "dns_http" | "dns_response"
  | "dns_target_denied" | "dns_empty" | "metadata_transport" | "metadata_http"
  | "metadata_media_type" | "metadata_size" | "metadata_body" | "metadata_invalid";
export type CimdFailure = { ok: false; reason: CimdFailureReason; retryable: boolean; status?: number };
export type CimdMetadataResult = { ok: true; metadata: PublicOAuthClientMetadata; freshUntilMs: number | null } | CimdFailure;

// RFC 9111 freshness, deliberately conservative: only explicitly public,
// unvarying responses with a valid max-age may be reused across isolates.
// Never override the publisher's shorter lifetime or extend on cache reads.
export const CIMD_MAX_FRESHNESS_MS = 300_000;
export function cimdFreshUntil(headers: Headers, requestStartedMs: number, responseReceivedMs: number): number | null {
  const control = headers.get("cache-control");
  if (!control || headers.get("vary") || headers.has("set-cookie")) return null;
  const directives = control.split(",").map(value => value.trim().toLowerCase());
  // Decline unusual quoted extension values instead of misparsing commas.
  if (directives.some(value => !/^[a-z][a-z0-9_-]*(?:\s*=\s*(?:[a-z0-9_-]+|"\d+"))?$/u.test(value))) return null;
  if (!directives.includes("public") || directives.some(value =>
    /^(?:no-store|no-cache|private)(?:\s*=|$)/u.test(value))) return null;
  const ages = (name: string): number[] | null => {
    const found = directives.filter(value => value.split("=")[0]?.trim() === name);
    if (found.length > 1) return null;
    if (!found.length) return [];
    const match = /^(?:max-age|s-maxage)\s*=\s*(?:"(\d+)"|(\d+))$/u.exec(found[0]);
    if (!match) return null;
    const seconds = Number(match[1] ?? match[2]);
    return Number.isSafeInteger(seconds) && seconds >= 0 ? [seconds] : null;
  };
  const maxAge = ages("max-age"), sharedAge = ages("s-maxage");
  if (!maxAge || maxAge.length !== 1 || !sharedAge) return null;
  const ageHeader = headers.get("age");
  if (ageHeader !== null && !/^\d+$/u.test(ageHeader)) return null;
  const age = Number(ageHeader ?? "0");
  if (!Number.isSafeInteger(age) || age < 0) return null;
  const dateHeader = headers.get("date");
  const dateMs = dateHeader ? Date.parse(dateHeader) : responseReceivedMs;
  if (!Number.isFinite(dateMs)) return null;
  const apparentAge = Math.max(0, responseReceivedMs - dateMs);
  const correctedAge = age * 1000 + Math.max(0, responseReceivedMs - requestStartedMs);
  const lifetime = Math.min(CIMD_MAX_FRESHNESS_MS, maxAge[0] * 1000, ...sharedAge.map(v => v * 1000));
  const remaining = lifetime - Math.max(apparentAge, correctedAge);
  return remaining > 0 ? responseReceivedMs + remaining : null;
}
const failure = (reason: CimdFailureReason, retryable = false, status?: number): CimdFailure =>
  ({ ok: false, reason, retryable, ...(status === undefined ? {} : { status }) });
const transientHttp = (status: number) =>
  status === 408 || status === 429 || [500, 502, 503, 504].includes(status);

type DnsResult = { ok: true; count: number } | CimdFailure;
async function precheckCimdDnsResult(host: string, fetcher: typeof fetch): Promise<DnsResult> {
  const query = async (family: 4 | 6): Promise<DnsResult> => {
    const type = family === 4 ? 1 : 28;
    const url = "https://cloudflare-dns.com/dns-query?name=" + encodeURIComponent(host) + "&type=" + type;
    let response: Response;
    try {
      // Workers does not implement redirect:"error". Never follow a resolver redirect.
      response = await fetcher(url, { method:"GET", redirect:"manual", signal:AbortSignal.timeout(2000),
        headers:{accept:"application/dns-json"} });
    } catch { return failure("dns_transport", true); }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return failure("dns_http", transientHttp(response.status), response.status);
    }
    let raw: string;
    try { raw = await response.text(); }
    catch { return failure("dns_transport", true); }
    if (raw.length > 16384) return failure("dns_response");
    let result: {Status?: number; TC?: boolean; Answer?: Array<{type:number;data:unknown}>};
    try { result = JSON.parse(raw); } catch { return failure("dns_response"); }
    if (!result || typeof result !== "object" || Array.isArray(result)
      || result.TC === true || (result.Answer !== undefined && !Array.isArray(result.Answer))) {
      return failure("dns_response");
    }
    const answers = result.Answer ?? [];
    if (answers.length > 32 || answers.some(a => !a || (a.type !== 5 && (a.type !== type || !ordinaryPublicIp(a.data,family))))) {
      return failure("dns_target_denied");
    }
    if (result.Status !== 0) return failure("dns_response", result.Status === 2);
    return {ok:true,count:answers.filter(a => a.type === type).length};
  };
  const [a, aaaa] = await Promise.all([query(4),query(6)]);
  // An unsafe/malformed answer must not be retried even if the other family
  // simultaneously encountered a transient transport failure.
  for (const result of [a, aaaa]) if (!result.ok && !result.retryable) return result;
  if (!a.ok) return a;
  if (!aaaa.ok) return aaaa;
  const count = a.count + aaaa.count;
  return count > 0 ? {ok:true,count} : failure("dns_empty");
}

export async function precheckCimdDns(host: string, fetcher: typeof fetch): Promise<boolean> {
  return (await precheckCimdDnsResult(host, fetcher)).ok;
}

// A single bounded DNS + HTTPS attempt. Only a successfully parsed document
// with explicit HTTP freshness may be reused; never cache or retry errors.
export async function fetchClientMetadataResult(
  clientId: string,
  fetcher: typeof fetch = fetch,
): Promise<CimdMetadataResult> {
  if (!cimdClientId(clientId)) return failure("invalid_client_id");
  const dns = await precheckCimdDnsResult(new URL(clientId).hostname, fetcher);
  if (!dns.ok) return dns;
  let response: Response;
  const requestStartedMs = Date.now();
  try {
    response = await fetcher(clientId, {
      method: "GET", redirect: "manual", signal: AbortSignal.timeout(5000),
      headers: { accept: "application/json" },
    });
  } catch { return failure("metadata_transport", true); }
  const responseReceivedMs = Date.now();
  // Never follow redirects or accept an invalid response.
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return failure("metadata_http", transientHttp(response.status), response.status);
  }
  if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/iu.test(response.headers.get("content-type") || "")) {
    await response.body?.cancel().catch(() => undefined);
    return failure("metadata_media_type");
  }
  if (Number(response.headers.get("content-length") || "0") > MAX_DOCUMENT_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return failure("metadata_size");
  }
  const reader = response.body?.getReader();
  if (!reader) return failure("metadata_body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_DOCUMENT_BYTES) {
        await reader.cancel().catch(() => undefined);
        return failure("metadata_size");
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return failure("metadata_transport", true);
  }
  try {
    const all = new Uint8Array(length);
    let offset = 0;
    for (const part of chunks) { all.set(part, offset); offset += part.length; }
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(all)) as unknown;
    const metadata = parseClientMetadata(clientId, data);
    return metadata ? {ok:true,metadata,freshUntilMs:cimdFreshUntil(response.headers,requestStartedMs,responseReceivedMs)} : failure("metadata_invalid");
  } catch { return failure("metadata_invalid"); }
}

export async function fetchClientMetadata(
  clientId: string,
  fetcher: typeof fetch = fetch,
): Promise<PublicOAuthClientMetadata | null> {
  const result = await fetchClientMetadataResult(clientId, fetcher);
  return result.ok ? result.metadata : null;
}
