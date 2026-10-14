import type { Bindings } from "./env";
import { ApiError } from "./http";
import {
  configuredExternalProviderKeys,
  resolveExternalProviderRoute,
} from "./external-provider-router";
import { ExternalError, boundedString, objectInput } from "./external-model";

export type ExternalConnectionRow = {
  id: string;
  space_id: string;
  provider_key: string;
  credential_ref: string;
  status: "active" | "disabled";
  display_name: string | null;
  access_mode: "read" | "write" | null;
  created_by_user_id: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ExternalProviderDescriptor = {
  key: string;
  displayName: string;
  credential: { type: string; displayName: string };
  resource: { type: string; displayName: string };
  access: Array<"read" | "write">;
};

type ConnectionAdapterRequest = {
  operation: "describe" | "create" | "update" | "delete" | "listResources";
  providerKey?: string;
  credentialRef?: string;
  credential?: Record<string, unknown>;
  access?: "read" | "write";
  input?: Record<string, unknown>;
};

const errorStatus: Record<string, 400 | 404 | 409 | 422 | 429 | 502 | 503> = {
  EXTERNAL_UNAVAILABLE: 503,
  EXTERNAL_ACCESS_DENIED: 503,
  EXTERNAL_RESOURCE_UNAVAILABLE: 404,
  EXTERNAL_RATE_LIMITED: 429,
  EXTERNAL_VALIDATION_FAILED: 422,
  EXTERNAL_CONTRACT_INVALID: 502,
  EXTERNAL_WRITE_UNKNOWN: 502,
};

async function responsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > 1_000_000) throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
  try { return JSON.parse(text || "null"); }
  catch { throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502); }
}

export async function callExternalConnectionAdapter(
  env: Bindings,
  request: ConnectionAdapterRequest,
): Promise<unknown> {
  const configured = configuredExternalProviderKeys(env);
  const providerKey = request.providerKey ?? (configured.length === 1 ? configured[0] : undefined);
  if (!providerKey)
    throw new ApiError("EXTERNAL_PROVIDER_UNAVAILABLE", "External provider is not configured", 422);
  const route = resolveExternalProviderRoute(env, providerKey);
  if (!route) throw new ExternalError("EXTERNAL_UNAVAILABLE", 503);
  let response: Response;
  try {
    response = await route.adapter.fetch(
      "https://external-adapter.internal/internal/v1/external-connections",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lifespace-internal-secret": route.sharedSecret,
        },
        body: JSON.stringify({ contractVersion: 1, ...request, providerKey }),
        signal: AbortSignal.timeout(30000),
      },
    );
  } catch {
    throw new ExternalError("EXTERNAL_UNAVAILABLE", 503);
  }
  const parsed = await responsePayload(response) as {
    contractVersion?: number;
    data?: unknown;
    error?: { code?: string; retrySafe?: boolean };
  } | null;
  if (!parsed || parsed.contractVersion !== 1) throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
  if (!response.ok || parsed.error) {
    const code = parsed.error?.code;
    throw new ExternalError(
      code && errorStatus[code] ? code : "EXTERNAL_UNAVAILABLE",
      code && errorStatus[code] ? errorStatus[code]! : 503,
      parsed.error?.retrySafe === true,
    );
  }
  return parsed.data;
}

export async function listExternalProviderDescriptors(env: Bindings): Promise<ExternalProviderDescriptor[]> {
  const items: ExternalProviderDescriptor[] = [];
  for (const providerKey of configuredExternalProviderKeys(env)) {
    const descriptor = validateProviderDescriptor(
      await callExternalConnectionAdapter(env, { operation: "describe", providerKey }),
    );
    if (descriptor.key !== providerKey)
      throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
    items.push(descriptor);
  }
  return items;
}

export function validateProviderDescriptor(value: unknown): ExternalProviderDescriptor {
  const input = objectInput(value);
  const key = boundedString(input.key, "provider key", 32);
  const displayName = boundedString(input.displayName, "provider displayName", 80);
  if (!/^[a-z][a-z0-9_-]{1,31}$/u.test(key)) throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
  const credential = objectInput(input.credential);
  const resource = objectInput(input.resource);
  const credentialType = boundedString(credential.type, "credential type", 64);
  const credentialDisplayName = boundedString(credential.displayName, "credential displayName", 80);
  const resourceType = boundedString(resource.type, "resource type", 64);
  const resourceDisplayName = boundedString(resource.displayName, "resource displayName", 80);
  if (!Array.isArray(input.access) || input.access.length < 1 || input.access.some((item) => item !== "read" && item !== "write"))
    throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
  return {
    key,
    displayName,
    credential: { type: credentialType, displayName: credentialDisplayName },
    resource: { type: resourceType, displayName: resourceDisplayName },
    access: [...new Set(input.access)] as Array<"read" | "write">,
  };
}

export function validateConnectionProjection(value: unknown): { read: true; write: boolean } {
  const input = objectInput(value);
  if (input.read !== true || typeof input.write !== "boolean") throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
  return { read: true, write: input.write };
}

export function validateConnectionResources(value: unknown) {
  const input = objectInput(value);
  if (!Array.isArray(input.items) || input.items.length > 100) throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
  const items = input.items.map((raw) => {
    const item = objectInput(raw);
    return {
      id: boundedString(item.id, "resource id", 256),
      type: boundedString(item.type, "resource type", 64),
      displayName: boundedString(item.displayName, "resource displayName", 256),
    };
  });
  const nextCursor = input.nextCursor === null || input.nextCursor === undefined
    ? null
    : boundedString(input.nextCursor, "nextCursor", 2048);
  return { items, nextCursor };
}

export async function getExternalConnection(env: Bindings, id: string): Promise<ExternalConnectionRow | null> {
  return env.DB.prepare(
    "SELECT id,space_id,provider_key,credential_ref,status,display_name,access_mode,created_by_user_id,revoked_at,created_at,updated_at FROM external_sources WHERE id=?",
  ).bind(id).first<ExternalConnectionRow>();
}

export async function listExternalConnections(env: Bindings, spaceId: string): Promise<ExternalConnectionRow[]> {
  const result = await env.DB.prepare(
    "SELECT id,space_id,provider_key,credential_ref,status,display_name,access_mode,created_by_user_id,revoked_at,created_at,updated_at FROM external_sources WHERE space_id=? ORDER BY created_at,id LIMIT 100",
  ).bind(spaceId).all<ExternalConnectionRow>();
  return result.results;
}

export function isDynamicExternalConnection(connection: Pick<ExternalConnectionRow, "credential_ref">): boolean {
  return /^cnx_[a-f0-9]{32}$/u.test(connection.credential_ref);
}

export function externalConnectionDto(connection: ExternalConnectionRow) {
  const dynamic = isDynamicExternalConnection(connection);
  return {
    id: connection.id,
    spaceId: connection.space_id,
    providerKey: connection.provider_key,
    displayName: connection.display_name ?? `${connection.provider_key} connection`,
    access: connection.access_mode,
    status: connection.revoked_at ? "revoked" : connection.status,
    managementMode: dynamic ? "dynamic" : "deployment",
    resourceDiscovery: dynamic,
    createdAt: connection.created_at,
    updatedAt: connection.updated_at,
  };
}

export function validateConnectionDisplayName(value: unknown): string {
  const displayName = boundedString(value, "displayName", 100).trim();
  if (!displayName) throw new ApiError("VALIDATION_ERROR", "displayName is invalid", 422);
  return displayName;
}

export function validateConnectionCredential(value: unknown): Record<string, unknown> {
  const credential = objectInput(value);
  const serialized = JSON.stringify(credential);
  if (serialized.length > 16_384 || Object.keys(credential).length > 8)
    throw new ApiError("VALIDATION_ERROR", "credential is invalid", 422);
  return credential;
}
