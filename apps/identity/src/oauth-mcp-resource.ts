import type { Bindings } from "./env";

// Core Server IDs are opaque; only Core is authoritative for existence and
// enabled state. Identity enforces exact, environment-bound OAuth audiences.
const MCP_PATH = /^\/mcp\/mcp_[a-f0-9]{32}$/u;

function dynamicOrigin(env: Bindings): string | null {
  const raw = env.OAUTH_MCP_RESOURCE_ORIGIN;
  if (typeof raw !== "string") return null;
  let uri: URL;
  try { uri = new URL(raw); } catch { return null; }
  if (uri.protocol !== "https:" || uri.username || uri.password
    || uri.pathname !== "/" || uri.search || uri.hash || uri.hostname.includes("*")) return null;
  const origin = uri.origin;
  if (env.ENVIRONMENT === "staging" && origin !== "https://core-staging.aisr.online") return null;
  if (env.ENVIRONMENT === "production" && origin !== "https://core.aisr.online") return null;
  return origin;
}

function dynamicResource(env: Bindings, resource: string): boolean {
  const origin = dynamicOrigin(env);
  if (!origin) return false;
  let uri: URL;
  try { uri = new URL(resource); } catch { return false; }
  return uri.origin === origin && uri.href === resource
    && !uri.username && !uri.password && !uri.search && !uri.hash
    && MCP_PATH.test(uri.pathname);
}

export function configuredOAuthResource(env: Bindings, value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1024) return null;
  let uri: URL;
  try { uri = new URL(value); } catch { return null; }
  if (uri.protocol !== "https:" || uri.username || uri.password || uri.hash
    || uri.hostname.includes("*") || uri.href !== value) return null;
  if (dynamicResource(env, value)) return value;
  return (env.OAUTH_ALLOWED_RESOURCES || "").split(/\s+/u).filter(Boolean).includes(value)
    ? value : null;
}

export async function liveOAuthResource(env: Bindings, value: unknown): Promise<boolean> {
  const resource = configuredOAuthResource(env, value);
  if (!resource) return false;
  // Legacy explicit allowlisted test resources do not require Core validation.
  // Canonical dynamic mcp_* Resources ALWAYS require live Core confirmation,
  // even if also present in the fixed historical allowlist.
  if (!dynamicResource(env, resource)) return true;
  if (!env.CORE || !env.CORE_IDENTITY_SHARED_SECRET) return false;
  try {
    const response = await env.CORE.fetch("https://core.internal/internal/v1/oauth/mcp-resource/validate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lifespace-internal-secret": env.CORE_IDENTITY_SHARED_SECRET,
      },
      body: JSON.stringify({ resource }),
    });
    if (!response.ok) return false;
    const result = await response.json<{ data?: { active?: boolean; resource?: string } }>().catch(() => null);
    return result?.data?.active === true && result.data.resource === resource;
  } catch { return false; }
}
