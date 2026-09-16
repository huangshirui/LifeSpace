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

export function assertSchemaMetadataAdvance(sql, version, label = "migration") {
  if (!Number.isInteger(version) || version < 1) throw new Error(`${label} has an invalid migration version`);
  const pattern = new RegExp(
    `UPDATE\\s+schema_metadata\\s+SET\\s+value\\s*=\\s*['\"]${version}['\"]\\s+WHERE\\s+key\\s*=\\s*['\"]schema_version['\"]\\s*;`,
    "iu",
  );
  if (!pattern.test(sql)) {
    throw new Error(`${label} must advance schema_metadata schema_version to ${version}`);
  }
}

function latestMigrationVersion(service) {
  const migrations = readdirSync(resolve(ROOT_DIR, `apps/${service}/migrations`))
    .map((name) => ({ name, match: /^(\d+)_.*\.sql$/u.exec(name) }))
    .filter(({ match }) => Boolean(match))
    .map(({ name, match }) => ({ name, version: Number(match[1]) }));
  if (!migrations.length) throw new Error(`apps/${service}/migrations has no numbered SQL migrations`);

  const version = Math.max(...migrations.map((migration) => migration.version));
  const latest = migrations.filter((migration) => migration.version === version);
  if (latest.length !== 1) {
    throw new Error(`apps/${service}/migrations must have exactly one latest migration for version ${version}`);
  }

  const migrationPath = resolve(ROOT_DIR, `apps/${service}/migrations/${latest[0].name}`);
  assertSchemaMetadataAdvance(readFileSync(migrationPath, "utf8"), version, migrationPath);
  return version;
}

// Published model versions are monotonic inside each environment and therefore
// can legitimately be higher than a clean-install release version. Staging
// acceptance pins semantic identity with model key + schema hash, while requiring
// only a release floor for the environment-local Registry version.
export const PROVING_MODELS = Object.freeze([
  Object.freeze({ key: "task", minimumVersion: 7, hash: "e79798bcadefad021ca86c1577c3fa3bc8fd0627f46557193aeca9b62acabb8e" }),
  Object.freeze({ key: "wish", minimumVersion: 7, hash: "7dc6c079916a967c8bcd93f8cbe082c98157ceaeb30ce782ef3f2eb035d370df" }),
  Object.freeze({ key: "day_record", minimumVersion: 4, hash: "9297a2f87fdd0718bfb74a362a0c451cf25309f4975099772f76e8a485fd0852" }),
  Object.freeze({ key: "event", minimumVersion: 5, hash: "35106ecb38a7d33cee083b285a62001d64234d0a86890b8a51094e1dd3b58e8f" }),
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
