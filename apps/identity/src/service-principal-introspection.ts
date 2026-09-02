import type { Hono } from "hono";
import type { Bindings, Variables } from "./env";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

type PrincipalStateRow = {
  principalStatus: string;
  applicationStatus: string;
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
  app.get("/introspection/v1/service-principals/:principalId", async (c) => {
    const sharedSecret = c.req.header("x-lifespace-internal-secret") ?? "";
    if (!await internalServiceAuthorized(c.env, sharedSecret)) {
      return c.json(fail("UNAUTHORIZED", "Internal service authentication is required", c.get("requestId")), 401);
    }

    const principalId = c.req.param("principalId");
    if (!/^svc_[A-Za-z0-9]+$/.test(principalId)) return c.json(ok({ active: false }));

    const row = await c.env.DB.prepare(`SELECT sp.status principalStatus,a.status applicationStatus
      FROM service_principals sp
      JOIN applications a ON a.id=sp.application_id
      WHERE sp.id=?`)
      .bind(principalId)
      .first<PrincipalStateRow>();

    return c.json(ok({
      active: row?.principalStatus === "active" && row.applicationStatus === "active",
    }));
  });
}
