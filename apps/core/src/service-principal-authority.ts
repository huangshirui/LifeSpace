import type { Bindings } from "./env";

export type ServicePrincipalAuthority =
  | { active: false }
  | { active: true; displayName?: string };

export async function servicePrincipalAuthority(env: Bindings, principalId: string): Promise<ServicePrincipalAuthority> {
  if (!env.IDENTITY || !env.CORE_IDENTITY_SHARED_SECRET) {
    throw new Error("Identity service principal introspection is not configured");
  }

  let response: Response;
  try {
    response = await env.IDENTITY.fetch(
      `https://identity.internal/introspection/v1/service-principals/${encodeURIComponent(principalId)}`,
      {
        headers: { "x-lifespace-internal-secret": env.CORE_IDENTITY_SHARED_SECRET },
      },
    );
  } catch {
    throw new Error("Identity service principal introspection is unavailable");
  }

  if (!response.ok) throw new Error(`Identity service principal introspection returned HTTP ${response.status}`);
  const payload = await response.json<{ data?: { active?: boolean; displayName?: unknown } }>().catch(() => null);
  if (typeof payload?.data?.active !== "boolean") {
    throw new Error("Identity service principal introspection returned an invalid response");
  }
  if (!payload.data.active) return { active: false };
  const displayName = typeof payload.data.displayName === "string" && payload.data.displayName.trim()
    ? payload.data.displayName.trim()
    : undefined;
  return { active: true, ...(displayName ? { displayName } : {}) };
}

export async function servicePrincipalIsActive(env: Bindings, principalId: string): Promise<boolean> {
  return (await servicePrincipalAuthority(env, principalId)).active;
}
