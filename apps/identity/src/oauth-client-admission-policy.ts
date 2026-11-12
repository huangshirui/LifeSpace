// Identity owns platform-level client admission. Console edits policy, but
// per-user authority remains in Account Consent and Core grants.
import { cimdClientId, publicRedirectUri } from "./oauth-client-metadata";

// Only two feature switches and one optional shared callback list are
// user-configurable. Per-client OAuth callback registration remains mandatory.
export type OAuthClientAdmissionPolicy = {
  cimdEnabled: boolean;
  dcrEnabled: boolean;
  callbackUris: string[];
  revision: number;
  updatedAt: string;
};
type PolicyRow = {
  cimd_enabled: number; dcr_enabled: number;
  cimd_mode: string; dcr_mode: string; callback_mode: string;
  callback_uris_json: string; revision: number; updated_at: string;
};
const MAX_RULES = 100;

export function dcrRedirectUri(value: unknown): value is string {
  if (!publicRedirectUri(value)) return false;
  try {
    const url = new URL(value);
    // Native loopback HTTP redirects are permitted only for loopback hosts.
    if (url.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
      || host.endsWith(".internal") || host.endsWith(".invalid") || host.endsWith(".onion")
      || /^\d+(?:\.\d+){3}$/u.test(host) || host.startsWith("[")) return false;
    return host.includes(".") && !host.includes("*");
  } catch { return false; }
}


function readCallbacks(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length > MAX_RULES
    || !parsed.every(dcrRedirectUri) || new Set(parsed).size !== parsed.length) {
    throw new Error("Invalid stored OAuth callback policy");
  }
  return parsed as string[];
}

export async function loadOAuthClientAdmissionPolicy(db: D1Database): Promise<OAuthClientAdmissionPolicy> {
  const row = await db.prepare(
    "SELECT cimd_enabled,dcr_enabled,cimd_mode,dcr_mode,callback_mode,callback_uris_json,revision,updated_at "
    + "FROM oauth_client_admission_policy WHERE id=1"
  ).first<PolicyRow>();
  // Schema 18 explicitly migrates retired strict admission modes. If the
  // migration was skipped, deny all instead of silently opening registration.
  if (!row || ![0, 1].includes(row.cimd_enabled) || ![0, 1].includes(row.dcr_enabled)
    || row.cimd_mode !== "open" || row.dcr_mode !== "open"
    || !["client", "restricted"].includes(row.callback_mode)
    || !Number.isSafeInteger(row.revision) || row.revision < 1) {
    throw new Error("Simplified OAuth admission policy migration is required");
  }
  const callbackUris = readCallbacks(row.callback_uris_json);
  if ((row.callback_mode === "client" && callbackUris.length > 0)
    || (row.callback_mode === "restricted" && callbackUris.length === 0)) {
    throw new Error("Inconsistent OAuth callback policy");
  }
  return {
    cimdEnabled: row.cimd_enabled === 1,
    dcrEnabled: row.dcr_enabled === 1,
    callbackUris,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

export function validateOAuthClientAdmissionPolicy(value: unknown): Omit<OAuthClientAdmissionPolicy, "revision" | "updatedAt"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(k => !["cimdEnabled", "dcrEnabled", "callbackUris"].includes(k))
    || typeof input.cimdEnabled !== "boolean" || typeof input.dcrEnabled !== "boolean") return null;
  const callbacks = input.callbackUris;
  if (!Array.isArray(callbacks) || callbacks.length > MAX_RULES
    || !callbacks.every(dcrRedirectUri) || new Set(callbacks).size !== callbacks.length) return null;
  return {
    cimdEnabled: input.cimdEnabled,
    dcrEnabled: input.dcrEnabled,
    callbackUris: callbacks as string[],
  };
}

export function mayUseCimd(policy: OAuthClientAdmissionPolicy, clientId: string): boolean {
  return policy.cimdEnabled && cimdClientId(clientId);
}

export function mayRegisterDcr(policy: OAuthClientAdmissionPolicy, redirects: string[]): boolean {
  return policy.dcrEnabled && redirects.length > 0 && redirects.every(dcrRedirectUri);
}

export function callbackAllowed(policy: OAuthClientAdmissionPolicy, redirect: string): boolean {
  return dcrRedirectUri(redirect)
    && (policy.callbackUris.length === 0 || policy.callbackUris.includes(redirect));
}
