import type { Context, Hono } from "hono";
import type { Bindings, Variables } from "./env";
import { requirePlatformAdminActor } from "./platform-admin-auth";
import { loadOAuthClientAdmissionPolicy, validateOAuthClientAdmissionPolicy } from "./oauth-client-admission-policy";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
const BASE = "/internal/v1/platform-admin/oauth/client-admission";
const ok = <T>(data: T) => ({ data });
const fail = (c: Context<AppEnv>, code: string, message: string, status: 400 | 409 | 413 | 422) =>
  c.json({ error: { code, message, requestId: c.get("requestId") } }, status);

export function registerOAuthClientAdmissionAdminRoutes(app: App): void {
  app.get(BASE, async (c) => {
    const actor = await requirePlatformAdminActor(c, "applications:manage");
    if (actor instanceof Response) return actor;
    return c.json(ok(await loadOAuthClientAdmissionPolicy(c.env.DB)), 200, { "cache-control": "no-store" });
  });

  app.put(BASE, async (c) => {
    const actor = await requirePlatformAdminActor(c, "applications:manage");
    if (actor instanceof Response) return actor;
    if (!/^application\/json(?:\s*;|$)/iu.test(c.req.header("content-type") || "")) {
      return fail(c, "INVALID_REQUEST", "JSON content type is required", 400);
    }
    const raw = await c.req.text();
    if (new TextEncoder().encode(raw).byteLength > 16384) {
      return fail(c, "REQUEST_TOO_LARGE", "Admission policy exceeds 16 KiB", 413);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return fail(c, "INVALID_REQUEST", "Valid JSON is required", 400); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fail(c, "INVALID_REQUEST", "JSON object required", 400);
    }
    const input = parsed as Record<string, unknown>;
    if (Object.keys(input).some(key => !["expectedRevision", "cimdEnabled", "dcrEnabled", "cimdClientIds", "dcrRedirectUris"].includes(key))) {
      return fail(c, "INVALID_REQUEST", "Unexpected admission policy field", 400);
    }
    const expectedRevision = input.expectedRevision;
    const changes = { ...input };
    delete changes.expectedRevision;
    const policy = validateOAuthClientAdmissionPolicy(changes);
    if (!policy || !Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 1) {
      return fail(c, "VALIDATION_ERROR", "Invalid exact URLs, feature toggles or revision", 422);
    }
    const stamp = new Date().toISOString();
    const auditId = "paa_" + crypto.randomUUID().replaceAll("-", "");
    const update = c.env.DB.prepare(
      "UPDATE oauth_client_admission_policy SET cimd_enabled=?,dcr_enabled=?,"
      + "cimd_client_ids_json=?,dcr_redirect_uris_json=?,revision=revision+1,"
      + "updated_by_user_id=?,updated_at=? WHERE id=1 AND revision=?"
    ).bind(
      Number(policy.cimdEnabled), Number(policy.dcrEnabled),
      JSON.stringify(policy.cimdClientIds), JSON.stringify(policy.dcrRedirectUris),
      actor.id, stamp, expectedRevision,
    );
    // Successful edits enter the regular Identity Platform Admin audit stream;
    // no untrusted remote metadata is stored in the audit summary.
    const audit = c.env.DB.prepare(
      "INSERT INTO platform_admin_audit("
      + "id,actor_user_id,actor_application_id,actor_token_id,executor_application_id,"
      + "operation,target_type,target_id,summary_json,request_id,result,created_at)"
      + " SELECT ?,?,?,?,?,?,?,?,?,?,'success',? "
      + "WHERE EXISTS (SELECT 1 FROM oauth_client_admission_policy WHERE id=1 AND revision=?)"
    ).bind(
      auditId, actor.id, actor.clientId, actor.tokenId, c.get("currentApplicationId"),
      "oauth_client_admission.update", "oauth_client_admission", "global",
      JSON.stringify({
        cimdEnabled: policy.cimdEnabled, dcrEnabled: policy.dcrEnabled,
        cimdCount: policy.cimdClientIds.length, dcrCount: policy.dcrRedirectUris.length,
      }), c.get("requestId"), stamp, Number(expectedRevision) + 1,
    );
    const results = await c.env.DB.batch([update, audit]);
    if (results[0]?.meta.changes !== 1) {
      return fail(c, "REVISION_CONFLICT", "Admission policy changed; reload before saving", 409);
    }
    return c.json(ok(await loadOAuthClientAdmissionPolicy(c.env.DB)), 200, { "cache-control": "no-store" });
  });
}
