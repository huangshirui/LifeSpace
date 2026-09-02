import type { Bindings } from "./env";

export async function servicePrincipalIsActive(env: Bindings, principalId: string): Promise<boolean> {
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
  const payload = await response.json<{ data?: { active?: boolean } }>().catch(() => null);
  if (typeof payload?.data?.active !== "boolean") {
    throw new Error("Identity service principal introspection returned an invalid response");
  }
  return payload.data.active;
}
