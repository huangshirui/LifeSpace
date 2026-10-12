import type { Hono } from "hono";
import type { Bindings, Variables } from "./env";
import { measurePerformancePhase } from "./performance-timing";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

type PrincipalStateRow = {
  principalStatus: string;
  applicationStatus: string;
  displayName: string;
};

const ok = <T>(data: T) => ({ data });
const fail = (code: string, message: string, requestId: string) => ({ error: { code, message, requestId } });

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

function constantTimeEqualDigest(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index] ^ right[index];
  return diff === 0;
}

async function internalServiceAuthorized(env: Bindings, presented: string): Promise<boolean> {
  if (!env.CORE_IDENTITY_SHARED_SECRET || !presented) return false;
  return constantTimeEqualDigest(
    await sha256(presented),
    await sha256(env.CORE_IDENTITY_SHARED_SECRET),
  );
}

export function registerServicePrincipalIntrospectionRoutes(app: App): void {
  app.post("/introspection/v1/recurrence-roots", async (c) => {
    if (!await internalServiceAuthorized(c.env, c.req.header("x-lifespace-internal-secret") ?? "")) return c.json(fail("UNAUTHORIZED", "Internal service authentication is required", c.get("requestId")), 401);
    const body = await c.req.json<unknown>().catch(() => null);
    const roots = body && typeof body === "object" && !Array.isArray(body) ? (body as { roots?: unknown }).roots : null;
    if (!Array.isArray(roots) || !roots.length || roots.length > 40 || roots.some(root => !root || typeof root !== "object" || Object.keys(root).some(k => !["type", "id", "applicationId"].includes(k)) || !["user", "service", "agent"].includes(root.type) || typeof root.id !== "string" || root.id.length > 100 || typeof root.applicationId !== "string" || root.applicationId.length > 100)) return c.json(fail("INVALID_REQUEST", "Expected 1-40 bounded enrolled roots", c.get("requestId")), 400);
    const results = await c.env.DB.batch<{ allowed_scopes: string; max_scopes: string }>(roots.map(root => c.env.DB.prepare(`SELECT a.allowed_scopes,
      CASE WHEN ?='service' THEN (SELECT max_scopes FROM service_principals WHERE id=? AND application_id=a.id AND status='active') ELSE a.allowed_scopes END max_scopes
      FROM applications a WHERE a.id=? AND a.status='active' AND (
        (?='user' AND EXISTS(SELECT 1 FROM users WHERE id=? AND status='active')) OR
        (?='service' AND EXISTS(SELECT 1 FROM service_principals WHERE id=? AND application_id=a.id AND status='active')) OR
        (?='agent' AND EXISTS(SELECT 1 FROM agents g JOIN agent_applications ga ON ga.agent_id=g.id WHERE g.id=? AND g.status='active' AND ga.application_id=a.id AND ga.status='active')))
      `).bind(root.type, root.id, root.applicationId, root.type, root.id, root.type, root.id, root.type, root.id)));
    return c.json(ok({ roots: roots.map((root, index) => {
      const row = results[index]?.results[0];
      if (!row) return { ...root, active: false, scopes: [] };
      const applicationScopes = JSON.parse(row.allowed_scopes) as string[];
      const maxScopes = JSON.parse(row.max_scopes) as string[];
      return { ...root, active: true, scopes: applicationScopes.filter(scope => maxScopes.includes(scope)) };
    }) }));
  });
  app.get("/introspection/v1/service-principals/:principalId", async (c) => {
    const sharedSecret = c.req.header("x-lifespace-internal-secret") ?? "";
    if (!await internalServiceAuthorized(c.env, sharedSecret)) {
      return c.json(fail("UNAUTHORIZED", "Internal service authentication is required", c.get("requestId")), 401);
    }

    const principalId = c.req.param("principalId");
    if (!/^svc_[A-Za-z0-9]+$/.test(principalId)) return c.json(ok({ active: false }));

    const row = await measurePerformancePhase(c, "identity.service_principal_lookup", () =>
      c.env.DB.prepare(`SELECT sp.status principalStatus,a.status applicationStatus,sp.display_name displayName
        FROM service_principals sp
        JOIN applications a ON a.id=sp.application_id
        WHERE sp.id=?`)
        .bind(principalId)
        .first<PrincipalStateRow>(),
    );

    const active = row?.principalStatus === "active" && row.applicationStatus === "active";
    return c.json(ok(active ? { active: true, displayName: row.displayName } : { active: false }));
  });
}
