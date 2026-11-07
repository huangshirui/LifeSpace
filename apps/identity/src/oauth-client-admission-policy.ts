// Identity owns platform-level client admission. Console edits policy, but
// per-user authority remains in Account Consent and Core grants.
import { cimdClientId, publicRedirectUri } from "./oauth-client-metadata";

export type AdmissionMode = "restricted" | "open";
export type CallbackMode = "client" | "restricted";
export type OAuthClientAdmissionPolicy = {
  cimdEnabled: boolean;
  dcrEnabled: boolean;
  cimdMode: AdmissionMode;
  dcrMode: AdmissionMode;
  callbackMode: CallbackMode;
  cimdClientIds: string[];
  dcrRedirectUris: string[];
  callbackUris: string[];
  revision: number;
  updatedAt: string;
};
type PolicyRow = {
  cimd_enabled: number; dcr_enabled: number;
  cimd_mode: string; dcr_mode: string; callback_mode: string;
  cimd_client_ids_json: string; dcr_redirect_uris_json: string;
  callback_uris_json: string;
  revision: number; updated_at: string;
};
const MAX_RULES = 100;

export function dcrRedirectUri(value: unknown): value is string {
  if (!publicRedirectUri(value)) return false;
  try {
    const url = new URL(value);
    // Native loopback HTTP redirects are permitted only for loopback hosts.
    if (url.protocol === "http:") return ["127.0.0.1", "[::1]"].includes(url.hostname);
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
      || host.endsWith(".internal") || host.endsWith(".test") || host.endsWith(".invalid")
      || host.endsWith(".example") || host.endsWith(".onion")
      || /^\d+(?:\.\d+){3}$/u.test(host) || host.startsWith("[")) return false;
    return host.includes(".") && !host.includes("*");
  } catch { return false; }
}

function readRules(raw: string, validate: (s: unknown) => s is string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length > MAX_RULES
    || !parsed.every(validate) || new Set(parsed).size !== parsed.length) {
    throw new Error("Invalid stored OAuth admission policy");
  }
  return parsed as string[];
}

export async function loadOAuthClientAdmissionPolicy(db: D1Database): Promise<OAuthClientAdmissionPolicy> {
  const row = await db.prepare(
    "SELECT cimd_enabled,dcr_enabled,cimd_mode,dcr_mode,callback_mode,"
      + "cimd_client_ids_json,dcr_redirect_uris_json,callback_uris_json,revision,updated_at "
      + "FROM oauth_client_admission_policy WHERE id=1"
  ).first<PolicyRow>();
  if (!row || ![0, 1].includes(row.cimd_enabled) || ![0, 1].includes(row.dcr_enabled)
    || !["restricted", "open"].includes(row.cimd_mode)
    || !["restricted", "open"].includes(row.dcr_mode)
    || !["client", "restricted"].includes(row.callback_mode)
    || !Number.isSafeInteger(row.revision) || row.revision < 1) {
    throw new Error("OAuth admission policy is not installed");
  }
  return {
    cimdEnabled: row.cimd_enabled === 1,
    dcrEnabled: row.dcr_enabled === 1,
    cimdMode: row.cimd_mode as AdmissionMode,
    dcrMode: row.dcr_mode as AdmissionMode,
    callbackMode: row.callback_mode as CallbackMode,
    cimdClientIds: readRules(row.cimd_client_ids_json, cimdClientId),
    dcrRedirectUris: readRules(row.dcr_redirect_uris_json, dcrRedirectUri),
    callbackUris: readRules(row.callback_uris_json, dcrRedirectUri),
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

export function validateOAuthClientAdmissionPolicy(value: unknown): Omit<OAuthClientAdmissionPolicy, "revision" | "updatedAt"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => ![
    "cimdEnabled", "dcrEnabled", "cimdMode", "dcrMode", "callbackMode",
    "cimdClientIds", "dcrRedirectUris", "callbackUris",
  ].includes(key))
    || typeof input.cimdEnabled !== "boolean" || typeof input.dcrEnabled !== "boolean"
    || !["restricted", "open"].includes(input.cimdMode as string)
    || !["restricted", "open"].includes(input.dcrMode as string)
    || !["client", "restricted"].includes(input.callbackMode as string)) return null;

  const cimd = input.cimdClientIds;
  const dcr = input.dcrRedirectUris;
  const callbacks = input.callbackUris;
  if (!Array.isArray(cimd) || !Array.isArray(dcr) || !Array.isArray(callbacks)
    || [cimd, dcr, callbacks].some(list => list.length > MAX_RULES || new Set(list).size !== list.length)
    || !cimd.every(cimdClientId) || !dcr.every(dcrRedirectUri)
    || !callbacks.every(dcrRedirectUri)
    || (input.cimdEnabled && input.cimdMode === "restricted" && cimd.length === 0)
    || (input.dcrEnabled && input.dcrMode === "restricted" && dcr.length === 0)
    || (input.callbackMode === "restricted" && callbacks.length === 0)) return null;
  return {
    cimdEnabled: input.cimdEnabled,
    dcrEnabled: input.dcrEnabled,
    cimdMode: input.cimdMode as AdmissionMode,
    dcrMode: input.dcrMode as AdmissionMode,
    callbackMode: input.callbackMode as CallbackMode,
    cimdClientIds: cimd as string[],
    dcrRedirectUris: dcr as string[],
    callbackUris: callbacks as string[],
  };
}

export function mayUseCimd(policy: OAuthClientAdmissionPolicy, clientId: string): boolean {
  return policy.cimdEnabled && cimdClientId(clientId)
    && (policy.cimdMode === "open" || policy.cimdClientIds.includes(clientId));
}

export function mayRegisterDcr(policy: OAuthClientAdmissionPolicy, redirects: string[]): boolean {
  return policy.dcrEnabled && redirects.length > 0
    && redirects.every(uri => dcrRedirectUri(uri)
      && (policy.dcrMode === "open" || policy.dcrRedirectUris.includes(uri)));
}

// One optional platform-wide restriction, shared by CIMD, DCR and pre-registered
// clients. In client mode, the client-specific registered redirect list remains
// mandatory; there is NEVER a wildcard at token or authorization time.
export function callbackAllowed(policy: OAuthClientAdmissionPolicy, redirect: string): boolean {
  return dcrRedirectUri(redirect)
    && (policy.callbackMode === "client" || policy.callbackUris.includes(redirect));
}
