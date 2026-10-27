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
// only a release floor for the environment-local Registry version. Schema 75
// published new referenceLabel definitions for four baseline models; the hashes
// below must track the published release, not their superseded predecessors.
export const PROVING_MODELS = Object.freeze([
  Object.freeze({ key: "task", minimumVersion: 10, hash: "c1aac009972a2c5676f07ce9df610bb089569abb7c0792ead3cca4c35bb293d4" }),
  Object.freeze({ key: "wish", minimumVersion: 9, hash: "70a20b920faa7bc077e02fc2328f98293d9972c8eceed83cf2516645268a60a6" }),
  Object.freeze({ key: "day_record", minimumVersion: 7, hash: "323660d43816e55b9789fe4dd7a071ea138f6fdd5354401b0d7317ffba0e4a5e" }),
  Object.freeze({ key: "event", minimumVersion: 8, hash: "dbf441f1f8203ebec0e16b2d6569b7606764b924540efd7bad30fb1258a7b270" }),
  Object.freeze({ key: "person_group", minimumVersion: 2, hash: "9dd9e0c1c562468485c6599613bb4bf6fdd6c83655e2040f49381e91aa94f08c" }),
  Object.freeze({ key: "anniversary", minimumVersion: 2, hash: "239be818a59bc78588634e6599a54e53d90158463ea95bfb257059b0d80ed0e4" }),
  Object.freeze({ key: "activity", minimumVersion: 2, hash: "4fc8e1508b90e26f69ce5612d5291250bf87b5032431df4f54dfb15ef896c67c" }),
  Object.freeze({ key: "goal", minimumVersion: 3, hash: "346dc5c37c9074f8c25c9dad35ce302a7de3ec3738de6814cadde94db8817b39" }),
  Object.freeze({ key: "person_profile", minimumVersion: 2, hash: "b4a45467ad8b737b3fe4b79090749b6aa8565e26f20e975372f1f2cedea4b5ef" }),
  Object.freeze({ key: "habit", minimumVersion: 3, hash: "a040f9afeac045f2061add27cab4e1b1fb86a917cf913769c97371b219c289eb" }),
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
