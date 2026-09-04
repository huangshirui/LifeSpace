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

// Published model versions are monotonic inside each environment and therefore
// can legitimately be higher than a clean-install release version. Staging
// acceptance pins semantic identity with route + schema hash, while requiring
// only a release floor for the environment-local Registry version.
export const PROVING_MODELS = Object.freeze([
  Object.freeze({ key: "task", route: "tasks", minimumVersion: 6, hash: "1fdfb9eb954382f3509cdca14431a7235cb1a954b8a6d425670a4150c8402837" }),
  Object.freeze({ key: "wish", route: "wishes", minimumVersion: 6, hash: "4d34e89df332b9b2c34549699e4210a3166db6eaddabe0ac59de5d4770c206c3" }),
  Object.freeze({ key: "day_record", route: "day-records", minimumVersion: 3, hash: "7793d9959277e45d9af52c6c71820040034f9c84ee487d8f0e6b00320e5c10aa" }),
  Object.freeze({ key: "event", route: "events", minimumVersion: 4, hash: "66832c4dae9fd9f99b1f4f49cfdb53e7c91a55512c0b3cf8b8cddaee2111f6c4" }),
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
