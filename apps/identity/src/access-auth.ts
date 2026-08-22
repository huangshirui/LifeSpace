type AccessJwtHeader = {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
};

type AccessJwtPayload = {
  iss?: unknown;
  sub?: unknown;
  aud?: unknown;
  email?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iat?: unknown;
  type?: unknown;
};

type AccessJwk = JsonWebKey & {
  kid?: string;
  alg?: string;
  use?: string;
};

type JwksResponse = { keys?: AccessJwk[] };

type CachedJwks = {
  expiresAt: number;
  keys: Map<string, AccessJwk>;
};

export type VerifiedAccessAssertion = {
  issuer: string;
  subject: string;
  audiences: string[];
  email: string | null;
  expiresAt: number;
};

export type AccessAssertionFetch = typeof fetch;

export class AccessAssertionError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid" | "not_configured" | "unavailable" = "invalid",
  ) {
    super(message);
    this.name = "AccessAssertionError";
  }
}

const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;
const jwksCache = new Map<string, CachedJwks>();

function base64UrlBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  let decoded: string;
  try {
    decoded = atob(normalized);
  } catch {
    throw new AccessAssertionError("Access assertion encoding is invalid");
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function decodeJson<T>(value: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlBytes(value))) as T;
  } catch (error) {
    if (error instanceof AccessAssertionError) throw error;
    throw new AccessAssertionError("Access assertion JSON is invalid");
  }
}

export function configuredAccessIssuer(teamDomain: string | undefined): string {
  if (!teamDomain?.trim()) {
    throw new AccessAssertionError("Cloudflare Access team domain is not configured", "not_configured");
  }
  const raw = teamDomain.trim().match(/^https?:\/\//i) ? teamDomain.trim() : `https://${teamDomain.trim()}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AccessAssertionError("Cloudflare Access team domain is invalid", "not_configured");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new AccessAssertionError("Cloudflare Access team domain must be an HTTPS origin", "not_configured");
  }
  return url.origin;
}

function parseAudiences(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.trim())) {
    return [...new Set(value.map((entry) => (entry as string).trim()))];
  }
  throw new AccessAssertionError("Access assertion audience is invalid");
}

async function loadJwks(issuer: string, fetcher: AccessAssertionFetch, forceRefresh: boolean): Promise<Map<string, AccessJwk>> {
  const cached = jwksCache.get(issuer);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.keys;

  let response: Response;
  try {
    response = await fetcher(`${issuer}/cdn-cgi/access/certs`, {
      headers: { accept: "application/json" },
    });
  } catch {
    throw new AccessAssertionError("Cloudflare Access signing keys are unavailable", "unavailable");
  }
  if (!response.ok) {
    throw new AccessAssertionError("Cloudflare Access signing keys are unavailable", "unavailable");
  }

  let body: JwksResponse;
  try {
    body = await response.json<JwksResponse>();
  } catch {
    throw new AccessAssertionError("Cloudflare Access signing keys are invalid", "unavailable");
  }
  if (!Array.isArray(body.keys)) {
    throw new AccessAssertionError("Cloudflare Access signing keys are invalid", "unavailable");
  }

  const keys = new Map<string, AccessJwk>();
  for (const key of body.keys) {
    if (typeof key?.kid !== "string" || !key.kid || key.kty !== "RSA") continue;
    if (key.alg && key.alg !== "RS256") continue;
    if (key.use && key.use !== "sig") continue;
    keys.set(key.kid, key);
  }
  if (!keys.size) {
    throw new AccessAssertionError("Cloudflare Access signing keys are invalid", "unavailable");
  }
  jwksCache.set(issuer, { expiresAt: Date.now() + JWKS_CACHE_TTL_MS, keys });
  return keys;
}

async function signingKey(issuer: string, kid: string, fetcher: AccessAssertionFetch): Promise<CryptoKey> {
  let keys = await loadJwks(issuer, fetcher, false);
  let jwk = keys.get(kid);
  if (!jwk) {
    keys = await loadJwks(issuer, fetcher, true);
    jwk = keys.get(kid);
  }
  if (!jwk) throw new AccessAssertionError("Access assertion signing key is unknown");
  try {
    return await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new AccessAssertionError("Cloudflare Access signing key cannot be imported", "unavailable");
  }
}

export async function verifyAccessAssertion(
  assertion: string,
  options: { teamDomain: string | undefined; fetcher?: AccessAssertionFetch; nowSeconds?: number },
): Promise<VerifiedAccessAssertion> {
  if (typeof assertion !== "string" || assertion.length < 32 || assertion.length > 32768) {
    throw new AccessAssertionError("Access assertion is invalid");
  }
  const parts = assertion.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new AccessAssertionError("Access assertion is invalid");
  }

  const issuer = configuredAccessIssuer(options.teamDomain);
  const header = decodeJson<AccessJwtHeader>(parts[0]);
  const payload = decodeJson<AccessJwtPayload>(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {
    throw new AccessAssertionError("Access assertion algorithm or key identifier is invalid");
  }
  if (payload.iss !== issuer) throw new AccessAssertionError("Access assertion issuer is invalid");
  if (typeof payload.sub !== "string" || !payload.sub.trim() || payload.sub.length > 512) {
    throw new AccessAssertionError("Access assertion subject is invalid");
  }
  if (payload.type !== undefined && payload.type !== "app") {
    throw new AccessAssertionError("Access assertion type is invalid");
  }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= now) {
    throw new AccessAssertionError("Access assertion has expired");
  }
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf > now + CLOCK_SKEW_SECONDS)) {
    throw new AccessAssertionError("Access assertion is not active yet");
  }
  if (payload.iat !== undefined && (typeof payload.iat !== "number" || payload.iat > now + CLOCK_SKEW_SECONDS)) {
    throw new AccessAssertionError("Access assertion issued-at time is invalid");
  }

  const audiences = parseAudiences(payload.aud);
  const key = await signingKey(issuer, header.kid, options.fetcher ?? fetch);
  const verified = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    base64UrlBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!verified) throw new AccessAssertionError("Access assertion signature is invalid");

  const email = typeof payload.email === "string" && payload.email.trim() ? payload.email.trim().slice(0, 320) : null;
  return {
    issuer,
    subject: payload.sub.trim(),
    audiences,
    email,
    expiresAt: payload.exp,
  };
}
