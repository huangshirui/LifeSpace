import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function packageVersion(service) {
  const packageJson = JSON.parse(readFileSync(resolve(ROOT_DIR, `apps/${service}/package.json`), "utf8"));
  if (typeof packageJson.version !== "string" || !packageJson.version) {
    throw new Error(`apps/${service}/package.json is missing a version`);
  }
  return packageJson.version;
}

function latestMigrationVersion(service) {
  const migrations = readdirSync(resolve(ROOT_DIR, `apps/${service}/migrations`))
    .map((name) => /^(\d+)_.*\.sql$/u.exec(name)?.[1])
    .filter(Boolean)
    .map(Number);
  if (!migrations.length) throw new Error(`apps/${service}/migrations has no numbered SQL migrations`);
  return Math.max(...migrations);
}

export const PROVING_MODELS = Object.freeze([
  Object.freeze({ key: "task", route: "tasks", version: 2, hash: "97053c8fd9e6f90ef9881cfbabc34d081a7ebbbaabc21143343aa9b9e57faa76" }),
  Object.freeze({ key: "wish", route: "wishes", version: 3, hash: "ce8e86a792e0bf6b7ee8bf70324ef51d28f531989b3f503d0408e24798c99fc1" }),
  Object.freeze({ key: "day_record", route: "day-records", version: 1, hash: "fa692a216e27d6e08df044728766d6c6df0de85a22fc4eb79ddda0f57c18393f" }),
  Object.freeze({ key: "event", route: "events", version: 2, hash: "4d2c76486402fdb48d4956c68dcd413cbc549075d192760786100380f7bd9522" }),
]);

export const STAGING_EXPECTATIONS = Object.freeze({
  core: Object.freeze({
    contractVersion: packageVersion("core"),
    schemaVersion: latestMigrationVersion("core"),
  }),
  identity: Object.freeze({
    contractVersion: packageVersion("identity"),
    schemaVersion: latestMigrationVersion("identity"),
  }),
});

export function assertStagingServiceUrl(value, service) {
  const expected = service === "core" ? "https://core-staging.aisr.online" : "https://auth-staging.aisr.online";
  if (value.replace(/\/+$/u, "") !== expected) {
    throw new Error(`Refusing non-staging ${service} URL: ${value}`);
  }
}

function exportGitHubEnv(name, value) {
  const githubEnv = process.env.GITHUB_ENV;
  if (!githubEnv) return;
  appendFileSync(githubEnv, `${name}=${value}\n`, "utf8");
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  exportGitHubEnv("LIFESPACE_EXPECTED_CORE_CONTRACT_VERSION", STAGING_EXPECTATIONS.core.contractVersion);
  exportGitHubEnv("LIFESPACE_EXPECTED_CORE_SCHEMA_VERSION", STAGING_EXPECTATIONS.core.schemaVersion);
  exportGitHubEnv("LIFESPACE_EXPECTED_IDENTITY_CONTRACT_VERSION", STAGING_EXPECTATIONS.identity.contractVersion);
  exportGitHubEnv("LIFESPACE_EXPECTED_IDENTITY_SCHEMA_VERSION", STAGING_EXPECTATIONS.identity.schemaVersion);
  console.log(JSON.stringify(STAGING_EXPECTATIONS, null, 2));
}
