import { generateKeyPairSync } from "node:crypto";

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const bootstrapSecret = process.env.LIFESPACE_STAGING_BOOTSTRAP_SECRET;
const runId = process.env.GITHUB_RUN_ID ?? `${Date.now()}`;

if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required");
if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
if (!bootstrapSecret || bootstrapSecret.length < 32) {
  throw new Error("LIFESPACE_STAGING_BOOTSTRAP_SECRET must be configured and at least 32 characters long");
}

const identityWorker = "lifespace-identity-staging";
const coreWorker = "lifespace-core-staging";
const identityBase = "https://auth-staging.aisr.online";
const coreBase = "https://core-staging.aisr.online";

async function cf(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const payload = await response.json();
  if (!response.ok || payload.success === false) {
    throw new Error(`${init.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(payload.errors ?? payload)}`);
  }
  return payload.result;
}

async function listSecretNames(workerName) {
  const result = await cf(`/accounts/${accountId}/workers/scripts/${workerName}/secrets`);
  return new Set((result ?? []).map((item) => item.name));
}

function secretText(name, text) {
  return { name, type: "secret_text", text };
}

async function patchSecrets(workerName, secrets) {
  await cf(`/accounts/${accountId}/workers/scripts/${workerName}/secrets-bulk`, {
    method: "PATCH",
    body: JSON.stringify({ secrets }),
  });
}

async function requestJson(url, init, expectedStatus) {
  let lastError;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const response = await fetch(url, init);
      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = text;
      }
      if (response.status === expectedStatus) return payload;
      lastError = new Error(`${init?.method ?? "GET"} ${url} returned ${response.status}: ${JSON.stringify(payload)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw lastError;
}

const identitySecrets = await listSecretNames(identityWorker);
const coreSecrets = await listSecretNames(coreWorker);
const hasPrivateKey = identitySecrets.has("TOKEN_PRIVATE_KEY");
const hasPublicKey = coreSecrets.has("IDENTITY_PUBLIC_KEY");

if (hasPrivateKey !== hasPublicKey) {
  throw new Error(
    "Staging signing-key state is partial: TOKEN_PRIVATE_KEY and IDENTITY_PUBLIC_KEY must either both exist or both be absent. Refusing automatic rotation.",
  );
}

let generatedSigningKeys = false;

if (!hasPrivateKey) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  await patchSecrets(identityWorker, {
    TOKEN_PRIVATE_KEY: secretText("TOKEN_PRIVATE_KEY", privateKey),
    BOOTSTRAP_SECRET: secretText("BOOTSTRAP_SECRET", bootstrapSecret),
  });
  await patchSecrets(coreWorker, {
    IDENTITY_PUBLIC_KEY: secretText("IDENTITY_PUBLIC_KEY", publicKey),
  });
  generatedSigningKeys = true;
  console.log("Generated and installed a new staging RS256 signing key pair");
} else {
  // Keep the bootstrap credential synchronized with the GitHub staging secret
  // without rotating the signing key pair used by already-issued access tokens.
  await patchSecrets(identityWorker, {
    BOOTSTRAP_SECRET: secretText("BOOTSTRAP_SECRET", bootstrapSecret),
  });
  console.log("Existing staging RS256 signing key pair preserved");
}

const appId = `app_staging_smoke_${runId}`;
const displayName = `Staging Smoke ${runId}`;
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

const tokenResponse = await requestJson(`${identityBase}/internal/v1/tokens`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${clientSecret}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ subjectId: userId, scopes }),
}, 200);

const accessToken = tokenResponse?.data?.accessToken;
if (!accessToken) throw new Error("Identity did not return a Core access token");

const space = await requestJson(`${coreBase}/api/v1/spaces`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    kind: "personal",
    name: `Staging Smoke ${runId}`,
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
    `## LifeSpace staging runtime\n\n- RS256 signing keys: ${generatedSigningKeys ? "generated" : "preserved"}\n- Bootstrap secret: synchronized from GitHub staging secret\n- Identity -> token -> Core -> Space smoke test: passed\n- Authentication deny check: passed\n- Smoke Space: \`${spaceId}\`\n`,
  );
}
