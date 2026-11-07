// Identity is the authority for public OAuth client admission configuration.
// Console configures these exact-match lists through a privileged audited API.
// Admission is not client authentication, OAuth Consent, or Core data access.
import { cimdClientId, publicRedirectUri } from "./oauth-client-metadata";

export type OAuthClientAdmissionPolicy = {
  cimdEnabled: boolean;
  dcrEnabled: boolean;
  cimdClientIds: string[];
  dcrRedirectUris: string[];
  revision: number;
  updatedAt: string;
};
type PolicyRow = {
  cimd_enabled: number; dcr_enabled: number;
  cimd_client_ids_json: string; dcr_redirect_uris_json: string;
  revision: number; updated_at: string;
};

const MAX_RULES = 100;

export function dcrRedirectUri(value: unknown): value is string {
  if (!publicRedirectUri(value)) return false;
  // Current DCR redirect validation deliberately excludes localhost hostname;
  // numeric loopback is supported, and may include a native client port.
  try { return new URL(value).hostname !== "localhost"; } catch { return false; }
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
    "SELECT cimd_enabled,dcr_enabled,cimd_client_ids_json,dcr_redirect_uris_json,revision,updated_at "
      + "FROM oauth_client_admission_policy WHERE id=1"
  ).first<PolicyRow>();
  if (!row || ![0, 1].includes(row.cimd_enabled) || ![0, 1].includes(row.dcr_enabled)
    || !Number.isSafeInteger(row.revision) || row.revision < 1) {
    throw new Error("OAuth admission policy is not installed");
  }
  return {
    cimdEnabled: row.cimd_enabled === 1,
    dcrEnabled: row.dcr_enabled === 1,
    cimdClientIds: readRules(row.cimd_client_ids_json, cimdClientId),
    dcrRedirectUris: readRules(row.dcr_redirect_uris_json, dcrRedirectUri),
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

export function validateOAuthClientAdmissionPolicy(value: unknown): Omit<OAuthClientAdmissionPolicy, "revision" | "updatedAt"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["cimdEnabled", "dcrEnabled", "cimdClientIds", "dcrRedirectUris"].includes(key))
    || typeof input.cimdEnabled !== "boolean" || typeof input.dcrEnabled !== "boolean") return null;
  const cimd = input.cimdClientIds;
  const dcr = input.dcrRedirectUris;
  if (!Array.isArray(cimd) || !Array.isArray(dcr)
    || cimd.length > MAX_RULES || dcr.length > MAX_RULES
    || !cimd.every(cimdClientId) || !dcr.every(dcrRedirectUri)
    || new Set(cimd).size !== cimd.length || new Set(dcr).size !== dcr.length
    || (input.cimdEnabled && cimd.length === 0)
    || (input.dcrEnabled && dcr.length === 0)) return null;
  return {
    cimdEnabled: input.cimdEnabled,
    dcrEnabled: input.dcrEnabled,
    cimdClientIds: cimd as string[],
    dcrRedirectUris: dcr as string[],
  };
}

export function mayUseCimd(policy: OAuthClientAdmissionPolicy, clientId: string): boolean {
  return policy.cimdEnabled && policy.cimdClientIds.includes(clientId);
}

export function mayRegisterDcr(policy: OAuthClientAdmissionPolicy, redirects: string[]): boolean {
  return policy.dcrEnabled && redirects.length > 0
    && redirects.every(uri => policy.dcrRedirectUris.includes(uri));
}
