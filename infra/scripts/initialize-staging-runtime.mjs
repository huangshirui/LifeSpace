import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";

const bootstrapSecret = process.env.LIFESPACE_STAGING_BOOTSTRAP_SECRET;
const runId = process.env.GITHUB_RUN_ID ?? `${Date.now()}`;
const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
const smokeId = `${runId}_${runAttempt}`;

if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error("CLOUDFLARE_API_TOKEN is required");
if (!process.env.CLOUDFLARE_ACCOUNT_ID) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
if (!bootstrapSecret || bootstrapSecret.length < 32) {
  throw new Error("LIFESPACE_STAGING_BOOTSTRAP_SECRET must be configured and at least 32 characters long");
}

const identityBase = "https://auth-staging.aisr.online";
const coreBase = "https://core-staging.aisr.online";

async function wranglerSecretBulk(cwd, secrets) {
  await new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "wrangler", "secret", "bulk", "--env", "staging"], {
      cwd,
      env: process.env,
      stdio: ["pipe", "inherit", "inherit"],
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wrangler secret bulk failed in ${cwd} with exit code ${code}`));
    });

    child.stdin.end(JSON.stringify(secrets));
  });
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { response, payload };
}

async function requestJson(url, init, expectedStatus) {
  let lastError;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const { response, payload } = await fetchJson(url, init);
      if (response.status === expectedStatus) return payload;
      lastError = new Error(`${init?.method ?? "GET"} ${url} returned ${response.status}: ${JSON.stringify(payload)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw lastError;
}

async function issueToken(clientSecret, userId, scopes) {
  return fetchJson(`${identityBase}/internal/v1/tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${clientSecret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ subjectId: userId, scopes }),
  });
}

async function probeCore(accessToken) {
  return fetchJson(`${coreBase}/api/v1/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

async function rotateSigningKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  await wranglerSecretBulk("apps/identity", {
    TOKEN_PRIVATE_KEY: privateKey,
    BOOTSTRAP_SECRET: bootstrapSecret,
  });
  await wranglerSecretBulk("apps/core", {
    IDENTITY_PUBLIC_KEY: publicKey,
  });
  console.log("Generated, installed, and activated a new staging RS256 signing key pair");
}

// Always synchronize the persistent bootstrap credential using Wrangler's
// non-versioned secret command so the resulting Worker version is deployed
// immediately. This repairs any earlier secret-only version that was not active.
await wranglerSecretBulk("apps/identity", {
  BOOTSTRAP_SECRET: bootstrapSecret,
});
console.log("Staging bootstrap secret synchronized and activated");

const appId = `app_staging_smoke_${smokeId}`;
const displayName = `Staging Smoke ${smokeId}`;
const scopes = ["profile:read", "spaces:read", "spaces:write"];

const application = await requestJson(`${identityBase}/bootstrap/v1/applications`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-bootstrap-secret": bootstrapSecret,
  },
  body: JSON.stringify({
    id: appId,
    name: "LifeSpace staging smoke test",
    clientType: "service",
    allowedScopes: scopes,
    trustedBackend: true,
    accessTokenTtlSeconds: 300,
  }),
}, 201);

const clientSecret = application?.data?.clientSecret;
if (!clientSecret) throw new Error("Smoke application did not return a client secret");

const user = await requestJson(`${identityBase}/internal/v1/users`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${clientSecret}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ displayName }),
}, 201);

const userId = user?.data?.id;
if (!userId) throw new Error("Smoke user creation did not return a user id");

let rotatedSigningKeys = false;
let tokenProbe = await issueToken(clientSecret, userId, scopes);
let accessToken = tokenProbe.payload?.data?.accessToken;
let coreProbe = accessToken ? await probeCore(accessToken) : null;

const identityKeyMissing =
  tokenProbe.response.status === 500 && tokenProbe.payload?.error?.code === "IDENTITY_NOT_CONFIGURED";
const coreKeyMissingOrMismatched = accessToken && coreProbe?.response.status === 401;

if (identityKeyMissing || coreKeyMissingOrMismatched) {
  console.log(
    identityKeyMissing
      ? "Active Identity signing key is missing; repairing staging signing keys"
      : "Active Core verification key is missing or mismatched; repairing staging signing keys",
  );
  await rotateSigningKeys();
  rotatedSigningKeys = true;

  tokenProbe = await issueToken(clientSecret, userId, scopes);
  accessToken = tokenProbe.payload?.data?.accessToken;
  if (tokenProbe.response.status !== 200 || !accessToken) {
    throw new Error(`Identity token issuance failed after signing-key repair: ${tokenProbe.response.status} ${JSON.stringify(tokenProbe.payload)}`);
  }

  coreProbe = await probeCore(accessToken);
}

if (tokenProbe.response.status !== 200 || !accessToken) {
  throw new Error(`Identity token issuance failed: ${tokenProbe.response.status} ${JSON.stringify(tokenProbe.payload)}`);
}
if (coreProbe?.response.status !== 200) {
  throw new Error(`Core token verification failed: ${coreProbe?.response.status} ${JSON.stringify(coreProbe?.payload)}`);
}

const space = await requestJson(`${coreBase}/api/v1/spaces`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    kind: "personal",
    name: `Staging Smoke ${smokeId}`,
    ownerDisplayName: displayName,
  }),
}, 201);

const spaceId = space?.data?.id;
if (!spaceId) throw new Error("Core did not return a Space id");

await requestJson(`${coreBase}/api/v1/spaces/${spaceId}`, {
  headers: { authorization: `Bearer ${accessToken}` },
}, 200);

await requestJson(`${coreBase}/api/v1/spaces/${spaceId}`, {}, 401);

console.log(`Phase 1 staging smoke test passed for ${spaceId}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## LifeSpace staging runtime\n\n- Bootstrap secret: synchronized and activated from GitHub staging secret\n- RS256 signing keys: ${rotatedSigningKeys ? "repaired and activated" : "existing active pair preserved"}\n- Identity -> token -> Core -> Space smoke test: passed\n- Authentication deny check: passed\n- Smoke Space: \`${spaceId}\`\n`,
  );
}
