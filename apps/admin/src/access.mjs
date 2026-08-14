let cachedKeys = null;
let cachedUntil = 0;

function base64UrlBytes(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function jsonSegment(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlBytes(value)));
}

function audienceIncludes(value, expected) {
  return typeof value === "string" ? value === expected : Array.isArray(value) && value.includes(expected);
}

function normalizeTeamDomain(value) {
  if (!value) throw new Error("CF_ACCESS_TEAM_DOMAIN is not configured");
  const withScheme = /^https?:\/\//u.test(value) ? value : `https://${value}`;
  return withScheme.replace(/\/+$/u, "");
}

async function accessKeys(teamDomain) {
  const now = Date.now();
  if (cachedKeys && cachedUntil > now) return cachedKeys;
  const response = await fetch(`${teamDomain}/cdn-cgi/access/certs`, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!response.ok) throw new Error(`Cloudflare Access cert fetch failed with ${response.status}`);
  const payload = await response.json();
  const keys = Array.isArray(payload.keys) ? payload.keys : [];
  if (!keys.length) throw new Error("Cloudflare Access returned no signing keys");
  cachedKeys = keys;
  cachedUntil = now + 5 * 60 * 1000;
  return keys;
}

export function decodeAccessJwt(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Cloudflare Access JWT is malformed");
  return { parts, header: jsonSegment(parts[0]), payload: jsonSegment(parts[1]) };
}

export async function verifyAccessJwt(token, env) {
  if (!token) throw new Error("Cloudflare Access JWT is required");
  const teamDomain = normalizeTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  if (!env.CF_ACCESS_AUD) throw new Error("CF_ACCESS_AUD is not configured");

  const { parts, header, payload } = decodeAccessJwt(token);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Cloudflare Access JWT signing header is invalid");
  const keys = await accessKeys(teamDomain);
  const jwk = keys.find((candidate) => candidate.kid === header.kid);
  if (!jwk) {
    cachedKeys = null;
    cachedUntil = 0;
    throw new Error("Cloudflare Access signing key is unknown");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    base64UrlBytes(parts[2]),
    signingInput,
  );
  if (!valid) throw new Error("Cloudflare Access JWT signature is invalid");

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) throw new Error("Cloudflare Access JWT is expired");
  if (typeof payload.nbf === "number" && payload.nbf > now + 30) throw new Error("Cloudflare Access JWT is not active yet");
  if (payload.iss !== teamDomain) throw new Error("Cloudflare Access JWT issuer is invalid");
  if (!audienceIncludes(payload.aud, env.CF_ACCESS_AUD)) throw new Error("Cloudflare Access JWT audience is invalid");
  if (typeof payload.email !== "string" || !payload.email.trim()) throw new Error("Cloudflare Access JWT has no operator email");

  return { email: payload.email.trim(), subject: typeof payload.sub === "string" ? payload.sub : null };
}

export async function requireAccess(request, env) {
  if (env.ENVIRONMENT === "local" && request.headers.get("x-lifespace-local-admin") === "1") {
    return { email: "local-admin@lifespace.invalid", subject: "local-admin" };
  }
  return verifyAccessJwt(request.headers.get("cf-access-jwt-assertion") ?? "", env);
}
