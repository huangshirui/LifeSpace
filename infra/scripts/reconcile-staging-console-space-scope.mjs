import process from "node:process";

const identityBase = (process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const bootstrapSecret = process.env.LIFESPACE_STAGING_BOOTSTRAP_SECRET ?? "";
const applicationId = process.env.LIFESPACE_STAGING_CONSOLE_APPLICATION_ID ?? "app_lifespace_console_staging";

const EXPECTED_SCOPES = [
  "profile:read",
  "spaces:manage",
  "platform:admin",
  "applications:manage",
  "services:manage",
  "identities:read",
  "models:manage",
  "spaces:inspect",
  "audit:read",
];

if (identityBase !== "https://auth-staging.aisr.online") throw new Error("Console scope reconciliation is staging-only");
if (bootstrapSecret.length < 32) throw new Error("LIFESPACE_STAGING_BOOTSTRAP_SECRET must contain at least 32 characters");
if (!/^app_[0-9A-Za-z_-]+$/u.test(applicationId)) throw new Error("Console application id is invalid");
console.log(`::add-mask::${bootstrapSecret}`);

async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(`${identityBase}${path}`, {
    method,
    headers: {
      accept: "application/json",
      "x-bootstrap-secret": bootstrapSecret,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

const before = await request(`/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`);
if (before.response.status !== 200 || before.payload?.data?.id !== applicationId) {
  throw new Error(`Could not load staging Console application: HTTP ${before.response.status}`);
}
if (before.payload.data.trustedBackend !== true || before.payload.data.status !== "active") {
  throw new Error("Staging Console application must be an active trusted backend before scope reconciliation");
}

let changed = false;
if (!sameStringSet(before.payload.data.allowedScopes, EXPECTED_SCOPES)) {
  const patched = await request(`/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`, {
    method: "PATCH",
    body: { allowedScopes: EXPECTED_SCOPES },
  });
  if (patched.response.status !== 200 || !sameStringSet(patched.payload?.data?.allowedScopes, EXPECTED_SCOPES)) {
    throw new Error(`Console application scope reconciliation failed: HTTP ${patched.response.status}`);
  }
  changed = true;
}

const after = await request(`/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`);
if (after.response.status !== 200 || !sameStringSet(after.payload?.data?.allowedScopes, EXPECTED_SCOPES)) {
  throw new Error("Staging Console application scope ceiling did not converge");
}
if (!after.payload.data.allowedScopes.includes("spaces:manage")) throw new Error("spaces:manage is absent after reconciliation");

console.log(JSON.stringify({
  ok: true,
  environment: "staging",
  applicationId,
  changed,
  spacesManage: true,
  credentialRotated: false,
  productionTouched: false,
}));
