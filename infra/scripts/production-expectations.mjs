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
// can legitimately be higher than a clean-install release version. Production
// acceptance pins semantic identity with route + schema hash, while requiring
// only a release floor for the environment-local Registry version.
export const PRODUCTION_PROVING_MODELS = Object.freeze([
  Object.freeze({ key: "task", route: "tasks", minimumVersion: 5, hash: "aaa6317b3810a20e6c4622736ec8e39e96edcd5079c6189fb5892ac54397b145" }),
  Object.freeze({ key: "wish", route: "wishes", minimumVersion: 5, hash: "ec4f99f238e44c756905d30a97f6bb5c063b783eca159dfe39f518ea58ff64b6" }),
  Object.freeze({ key: "day_record", route: "day-records", minimumVersion: 2, hash: "4b2f241958aeca05e396eea7e6719a3f030cef3ea7dfd3c57d426c086fe4cf56" }),
  Object.freeze({ key: "event", route: "events", minimumVersion: 3, hash: "6a23eb2f25463ce55d7ed75d64f0afa020d7aab25149badf28fdd77abc2d1aad" }),
]);

export const PRODUCTION_EXPECTATIONS = Object.freeze({
  core: Object.freeze({
    contractVersion: packageVersion("core"),
    schemaVersion: latestMigrationVersion("core"),
  }),
  identity: Object.freeze({
    contractVersion: packageVersion("identity"),
    schemaVersion: latestMigrationVersion("identity"),
  }),
});

export function assertProductionServiceUrl(value, service) {
  const expected = service === "core" ? "https://core.aisr.online" : "https://auth.aisr.online";
  if (value.replace(/\/+$/u, "") !== expected) {
    throw new Error(`Refusing non-production ${service} URL: ${value}`);
  }
}

function exportGitHubEnv(name, value) {
  const githubEnv = process.env.GITHUB_ENV;
  if (!githubEnv) return;
  appendFileSync(githubEnv, `${name}=${value}\n`, "utf8");
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  exportGitHubEnv("LIFESPACE_EXPECTED_CORE_CONTRACT_VERSION", PRODUCTION_EXPECTATIONS.core.contractVersion);
  exportGitHubEnv("LIFESPACE_EXPECTED_CORE_SCHEMA_VERSION", PRODUCTION_EXPECTATIONS.core.schemaVersion);
  exportGitHubEnv("LIFESPACE_EXPECTED_IDENTITY_CONTRACT_VERSION", PRODUCTION_EXPECTATIONS.identity.contractVersion);
  exportGitHubEnv("LIFESPACE_EXPECTED_IDENTITY_SCHEMA_VERSION", PRODUCTION_EXPECTATIONS.identity.schemaVersion);
  console.log(JSON.stringify(PRODUCTION_EXPECTATIONS, null, 2));
}
