import type { Bindings } from "./env";
import { ApiError } from "./http";

export type ExternalProviderRoute = {
  providerKey: string;
  bindingName: string;
  sharedSecretName: string;
  adapter: Fetcher;
  sharedSecret: string;
};

type RouteConfig = {
  binding: string;
  sharedSecret: string;
};

type RouteMap = Record<string, RouteConfig>;

let cachedRaw: string | undefined;
let cachedRoutes: RouteMap = {};

function parseRoutes(raw: string | undefined): RouteMap {
  if (!raw) return {};
  if (raw === cachedRaw) return cachedRoutes;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError("EXTERNAL_UNAVAILABLE", "External provider routing is invalid", 503);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new ApiError("EXTERNAL_UNAVAILABLE", "External provider routing is invalid", 503);
  const routes: RouteMap = {};
  for (const [providerKey, value] of Object.entries(parsed)) {
    if (!/^[a-z][a-z0-9_-]{1,31}$/u.test(providerKey) || !value || typeof value !== "object" || Array.isArray(value))
      throw new ApiError("EXTERNAL_UNAVAILABLE", "External provider routing is invalid", 503);
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["binding", "sharedSecret"].includes(key)))
      throw new ApiError("EXTERNAL_UNAVAILABLE", "External provider routing is invalid", 503);
    const binding = record.binding;
    const sharedSecret = record.sharedSecret;
    if (
      typeof binding !== "string" ||
      !/^EXTERNAL_ADAPTER_[A-Z0-9_]{2,64}$/u.test(binding) ||
      typeof sharedSecret !== "string" ||
      !/^EXTERNAL_ADAPTER_[A-Z0-9_]{2,64}_SHARED_SECRET$/u.test(sharedSecret)
    )
      throw new ApiError("EXTERNAL_UNAVAILABLE", "External provider routing is invalid", 503);
    routes[providerKey] = { binding, sharedSecret };
  }
  cachedRaw = raw;
  cachedRoutes = routes;
  return routes;
}

function envValue(env: Bindings, name: string): unknown {
  return (env as unknown as Record<string, unknown>)[name];
}

function legacyNotionRoute(env: Bindings): ExternalProviderRoute | null {
  if (
    env.EXTERNAL_PROVIDER_ROUTES ||
    !env.EXTERNAL_ADAPTER ||
    typeof env.EXTERNAL_ADAPTER.fetch !== "function" ||
    typeof env.EXTERNAL_ADAPTER_SHARED_SECRET !== "string" ||
    env.EXTERNAL_ADAPTER_SHARED_SECRET.length < 32
  ) return null;
  return {
    providerKey: "notion",
    bindingName: "EXTERNAL_ADAPTER",
    sharedSecretName: "EXTERNAL_ADAPTER_SHARED_SECRET",
    adapter: env.EXTERNAL_ADAPTER,
    sharedSecret: env.EXTERNAL_ADAPTER_SHARED_SECRET,
  };
}

export function configuredExternalProviderKeys(env: Bindings): string[] {
  const routes = parseRoutes(env.EXTERNAL_PROVIDER_ROUTES);
  const configured = Object.entries(routes)
    .filter(([, route]) => {
      const adapter = envValue(env, route.binding);
      const secret = envValue(env, route.sharedSecret);
      return Boolean(adapter && typeof (adapter as Fetcher).fetch === "function" && typeof secret === "string" && secret.length >= 32);
    })
    .map(([providerKey]) => providerKey);
  if (!configured.length && legacyNotionRoute(env)) configured.push("notion");
  return configured.sort();
}

export function hasExternalProviderRoute(env: Bindings, providerKey: string): boolean {
  try {
    return resolveExternalProviderRoute(env, providerKey, false) !== null;
  } catch {
    return false;
  }
}

export function resolveExternalProviderRoute(
  env: Bindings,
  providerKey: string,
  required = true,
): ExternalProviderRoute | null {
  const routes = parseRoutes(env.EXTERNAL_PROVIDER_ROUTES);
  const config = routes[providerKey];
  if (!config) {
    const legacy = providerKey === "notion" ? legacyNotionRoute(env) : null;
    if (legacy) return legacy;
    if (required) throw new ApiError("EXTERNAL_PROVIDER_UNAVAILABLE", "External provider is not configured", 422);
    return null;
  }
  const adapter = envValue(env, config.binding);
  const secret = envValue(env, config.sharedSecret);
  if (!adapter || typeof (adapter as Fetcher).fetch !== "function" || typeof secret !== "string" || secret.length < 32) {
    if (required) throw new ApiError("EXTERNAL_UNAVAILABLE", "External provider is unavailable", 503);
    return null;
  }
  return {
    providerKey,
    bindingName: config.binding,
    sharedSecretName: config.sharedSecret,
    adapter: adapter as Fetcher,
    sharedSecret: secret,
  };
}

export function externalProviderRouteConfig(env: Bindings): Readonly<RouteMap> {
  return parseRoutes(env.EXTERNAL_PROVIDER_ROUTES);
}
