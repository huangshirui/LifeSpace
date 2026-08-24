import process from "node:process";

const identityBase = (process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const bootstrapSecret = process.env.LIFESPACE_STAGING_BOOTSTRAP_SECRET ?? "";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
const webApplicationId = (process.env.LIFESPACE_STAGING_WEB_APPLICATION_ID ?? "app_homemew_web_staging").trim();
const coreDatabaseName = (process.env.LIFESPACE_STAGING_CORE_D1_NAME ?? "lifespace-core-staging").trim();

const WEB_MODEL_ACCESS = new Map([
  ["event", "write"],
  ["task", "write"],
  ["day_record", "write"],
  ["wish", "write"],
]);

for (const [name, value] of Object.entries({
  LIFESPACE_STAGING_BOOTSTRAP_SECRET: bootstrapSecret,
  CLOUDFLARE_ACCOUNT_ID: accountId,
  CLOUDFLARE_API_TOKEN: apiToken,
  LIFESPACE_STAGING_WEB_APPLICATION_ID: webApplicationId,
})) {
  if (!value) throw new Error(`${name} is required`);
}
if (bootstrapSecret.length < 32) throw new Error("LIFESPACE_STAGING_BOOTSTRAP_SECRET must contain at least 32 characters");
if (!/^app_[0-9A-Za-z_-]+$/u.test(webApplicationId)) {
  throw new Error("LIFESPACE_STAGING_WEB_APPLICATION_ID must use an app_* identifier");
}

async function parseResponse(response) {
  const raw = await response.text();
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { return raw; }
}

async function identityRequest(path) {
  const response = await fetch(`${identityBase}${path}`, {
    headers: {
      accept: "application/json",
      "x-bootstrap-secret": bootstrapSecret,
    },
  });
  return { response, payload: await parseResponse(response) };
}

async function cloudflare(path, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiToken}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await parseResponse(response);
  if (!response.ok || payload?.success !== true) {
    throw new Error(`Cloudflare request failed: ${method} ${path} -> HTTP ${response.status}`);
  }
  return payload;
}

async function requireStagingWebApplication() {
  const statusResponse = await fetch(`${identityBase}/api/v1/status`);
  const statusPayload = await parseResponse(statusResponse);
  if (statusResponse.status !== 200 || statusPayload?.data?.environment !== "staging") {
    throw new Error("Refusing to provision HomeMew Web model access against a non-staging Identity environment");
  }

  const application = await identityRequest(`/bootstrap/v1/applications/${encodeURIComponent(webApplicationId)}`);
  if (application.response.status !== 200 || application.payload?.data?.id !== webApplicationId) {
    throw new Error(`HomeMew Web staging application must exist before model access provisioning: ${application.response.status}`);
  }
  if (application.payload?.data?.status !== "active") {
    throw new Error(`HomeMew Web staging application must be active before model access provisioning`);
  }
}

async function findCoreDatabaseId() {
  const payload = await cloudflare(`/d1/database?per_page=1000`);
  const database = payload.result?.find((item) => item?.name === coreDatabaseName);
  if (!database?.uuid) throw new Error(`Required staging D1 database does not exist: ${coreDatabaseName}`);
  return database.uuid;
}

async function d1Query(databaseId, sql, params = []) {
  const payload = await cloudflare(`/d1/database/${encodeURIComponent(databaseId)}/query`, {
    method: "POST",
    body: { sql, params },
  });
  const results = Array.isArray(payload.result) ? payload.result : [];
  if (!results.length || results.some((entry) => entry?.success === false)) {
    throw new Error(`D1 query failed for ${coreDatabaseName}`);
  }
  return results.flatMap((entry) => Array.isArray(entry?.results) ? entry.results : []);
}

async function reconcileWebModelAccess() {
  const databaseId = await findCoreDatabaseId();
  const now = new Date().toISOString();

  for (const [modelKey, maxAccess] of WEB_MODEL_ACCESS) {
    await d1Query(databaseId, `INSERT INTO application_model_access(
      application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
    ) VALUES(?,?,?,'service','svc_lifespace_bootstrap',?,?)
    ON CONFLICT(application_id,model_key) DO UPDATE SET max_access=excluded.max_access,updated_at=excluded.updated_at`,
    [webApplicationId, modelKey, maxAccess, now, now]);
  }

  await d1Query(databaseId,
    "DELETE FROM application_model_access WHERE application_id=? AND model_key NOT IN ('event','task','day_record','wish')",
    [webApplicationId]);

  const rows = await d1Query(databaseId,
    "SELECT model_key,max_access FROM application_model_access WHERE application_id=? ORDER BY model_key",
    [webApplicationId]);
  const expected = [...WEB_MODEL_ACCESS.entries()].sort(([left], [right]) => left.localeCompare(right));
  if (rows.length !== expected.length || expected.some(([modelKey, access], index) => rows[index]?.model_key !== modelKey || rows[index]?.max_access !== access)) {
    throw new Error(`HomeMew Web Application × Model Access did not converge: ${JSON.stringify(rows)}`);
  }
  return Object.fromEntries(expected);
}

await requireStagingWebApplication();
const modelAccess = await reconcileWebModelAccess();

console.log(JSON.stringify({
  ok: true,
  environment: "staging",
  webApplication: {
    id: webApplicationId,
    modelAccess,
  },
  productionUntouched: true,
}, null, 2));
