import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import process from "node:process";

const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const bootstrapSecret = process.env.LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET ?? "";
const repairSharedSecret = process.env.LIFESPACE_REPAIR_CORE_IDENTITY_SHARED_SECRET ?? "0";
const CORE_DIR = new URL("../../apps/core/", import.meta.url);
const IDENTITY_DIR = new URL("../../apps/identity/", import.meta.url);

if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required");
if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
if (bootstrapSecret.length < 32) throw new Error("LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET must contain at least 32 characters");
if (repairSharedSecret !== "0" && repairSharedSecret !== "1") {
  throw new Error("LIFESPACE_REPAIR_CORE_IDENTITY_SHARED_SECRET must be exactly 0 or 1");
}

function wranglerSecretBulk(cwd, secrets) {
  execFileSync("pnpm", ["exec", "wrangler", "secret", "bulk", "--env", "production"], {
    cwd,
    env: process.env,
    input: JSON.stringify(secrets),
    stdio: ["pipe", "inherit", "inherit"],
  });
}

async function secretNames(service) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${service}/secrets`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await response.json();
  if (!response.ok || payload.success === false) {
    throw new Error(`Unable to list secrets for ${service} (${response.status}): ${JSON.stringify(payload.errors ?? payload)}`);
  }
  return new Set((payload.result ?? []).map((entry) => entry.name));
}

function assertAllOrNone(label, present) {
  const count = present.filter(Boolean).length;
  if (count !== 0 && count !== present.length) {
    throw new Error(`${label} is only partially configured; refusing automatic production key/secret rotation`);
  }
  return count === present.length;
}

// The bootstrap secret is an operator-controlled GitHub Environment secret. Synchronizing
// it is intentional; no generated production credential is printed or committed.
wranglerSecretBulk(IDENTITY_DIR, { BOOTSTRAP_SECRET: bootstrapSecret });

let identitySecrets = await secretNames("lifespace-identity");
let coreSecrets = await secretNames("lifespace-core");

const signingExists = assertAllOrNone("production RS256 signing material", [
  identitySecrets.has("TOKEN_PRIVATE_KEY"),
  identitySecrets.has("TOKEN_PUBLIC_KEY"),
  coreSecrets.has("IDENTITY_PUBLIC_KEY"),
]);

if (!signingExists) {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  wranglerSecretBulk(IDENTITY_DIR, {
    TOKEN_PRIVATE_KEY: pair.privateKey,
    TOKEN_PUBLIC_KEY: pair.publicKey,
  });
  wranglerSecretBulk(CORE_DIR, { IDENTITY_PUBLIC_KEY: pair.publicKey });
  console.log("Initialized production RS256 signing/verification material");
} else {
  console.log("Preserved existing production RS256 signing/verification material");
}

identitySecrets = await secretNames("lifespace-identity");
coreSecrets = await secretNames("lifespace-core");
const sharedPresence = [
  identitySecrets.has("CORE_IDENTITY_SHARED_SECRET"),
  coreSecrets.has("CORE_IDENTITY_SHARED_SECRET"),
];
const sharedPresenceCount = sharedPresence.filter(Boolean).length;
const repairSharedSecretRequested = repairSharedSecret === "1";

if (sharedPresenceCount === 1 && !repairSharedSecretRequested) {
  throw new Error("production Core↔Identity shared authentication secret is only partially configured; explicit repair is required");
}

let sharedAuthenticationSecret;
if (sharedPresenceCount === 0 || repairSharedSecretRequested) {
  const shared = randomBytes(32).toString("base64url");
  wranglerSecretBulk(IDENTITY_DIR, { CORE_IDENTITY_SHARED_SECRET: shared });
  wranglerSecretBulk(CORE_DIR, { CORE_IDENTITY_SHARED_SECRET: shared });
  sharedAuthenticationSecret = repairSharedSecretRequested ? "repaired" : "initialized";
  console.log(repairSharedSecretRequested
    ? "Re-synchronized production Core↔Identity shared authentication secret by explicit operator request"
    : "Initialized production Core↔Identity shared authentication secret");
} else {
  sharedAuthenticationSecret = "preserved";
  console.log("Preserved existing production Core↔Identity shared authentication secret bindings; secret values are write-only and equality is verified by the service-auth release gate");
}

identitySecrets = await secretNames("lifespace-identity");
coreSecrets = await secretNames("lifespace-core");
for (const required of ["BOOTSTRAP_SECRET", "TOKEN_PRIVATE_KEY", "TOKEN_PUBLIC_KEY", "CORE_IDENTITY_SHARED_SECRET"]) {
  if (!identitySecrets.has(required)) throw new Error(`Identity production secret ${required} is missing after initialization`);
}
for (const required of ["IDENTITY_PUBLIC_KEY", "CORE_IDENTITY_SHARED_SECRET"]) {
  if (!coreSecrets.has(required)) throw new Error(`Core production secret ${required} is missing after initialization`);
}

console.log(JSON.stringify({
  ok: true,
  signingMaterial: signingExists ? "preserved" : "initialized",
  sharedAuthenticationSecret,
  bootstrapSecret: "synchronized",
  secretValuesExposed: false,
}, null, 2));
