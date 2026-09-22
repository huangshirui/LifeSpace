import { execFileSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const CORE_DIR = new URL("../../apps/core/", import.meta.url);
const IDENTITY_DIR = new URL("../../apps/identity/", import.meta.url);

export const AUDIT_NAME_TARGETS = [
  { table: "resource_records", type: "created_by_type", id: "created_by_id", name: "created_by_name_snapshot" },
  { table: "resource_records", type: "updated_by_type", id: "updated_by_id", name: "updated_by_name_snapshot" },
  { table: "temporal_occurrences", type: "recorded_by_type", id: "recorded_by_id", name: "recorded_by_name_snapshot" },
  { table: "model_definitions", type: "published_by_type", id: "published_by_id", name: "published_by_name_snapshot" },
  { table: "model_contract_revisions", type: "created_by_type", id: "created_by_id", name: "created_by_name_snapshot" },
  { table: "model_definition_drafts", type: "created_by_type", id: "created_by_id", name: "created_by_name_snapshot" },
];

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function brokenServiceIdsQuery() {
  return AUDIT_NAME_TARGETS
    .map(({ table, type, id, name }) =>
      `SELECT ${id} servicePrincipalId FROM ${table} WHERE ${type}='service' AND ${name}=${id}`)
    .join(" UNION ");
}

export function repairStatement(target, principalId, displayName) {
  return `UPDATE ${target.table} SET ${target.name}=${sqlLiteral(displayName)} ` +
    `WHERE ${target.type}='service' AND ${target.id}=${sqlLiteral(principalId)} AND ${target.name}=${target.id}`;
}

export function unresolvedCountQuery() {
  const parts = AUDIT_NAME_TARGETS.map(({ table, type, id, name }) =>
    `SELECT COUNT(*) count FROM ${table} WHERE ${type}='service' AND ${name}=${id}`);
  return `SELECT SUM(count) count FROM (${parts.join(" UNION ALL ")})`;
}

function parseArgs(argv) {
  const environment = argv.find((arg) => arg.startsWith("--env="))?.slice("--env=".length);
  if (environment !== "staging" && environment !== "production") {
    throw new Error("Usage: node infra/scripts/service-audit-display-name-repair.mjs --env=staging|production [--apply]");
  }
  return { environment, apply: argv.includes("--apply") };
}

function runSql(cwd, environment, sql) {
  const stdout = execFileSync(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", "DB", "--remote", "--env", environment, "--json", `--command=${sql}`],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: process.env },
  );
  const parsed = JSON.parse(stdout);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  for (const entry of entries) {
    if (entry?.success === false) throw new Error(`D1 query failed: ${JSON.stringify(entry)}`);
    if (Array.isArray(entry?.results)) return entry.results;
    if (Array.isArray(entry?.result?.results)) return entry.result.results;
  }
  return [];
}

async function main() {
  const { environment, apply } = parseArgs(process.argv.slice(2));

  // Runtime services remain database-isolated. This one-shot operator tool is
  // intentionally the coordination boundary for historical repair.
  await import(`./resolve-${environment}-d1.mjs`);

  const coreSql = (sql) => runSql(CORE_DIR, environment, sql);
  const identitySql = (sql) => runSql(IDENTITY_DIR, environment, sql);

  const brokenRows = coreSql(brokenServiceIdsQuery());
  const ids = [...new Set(brokenRows.map((row) => row.servicePrincipalId).filter(Boolean))];

  if (!ids.length) {
    console.log(JSON.stringify({ ok: true, environment, apply, principals: 0, repaired: 0, message: "No broken service audit snapshots found" }, null, 2));
    return;
  }

  const inList = ids.map(sqlLiteral).join(",");
  const principals = identitySql(`SELECT id,display_name displayName FROM service_principals WHERE id IN (${inList})`);
  const names = new Map(principals.map((row) => [row.id, row.displayName]));
  const unresolved = ids.filter((id) => typeof names.get(id) !== "string" || !names.get(id).trim());

  if (unresolved.length) {
    throw new Error(`Identity display names are unavailable for service principals: ${unresolved.join(", ")}`);
  }

  if (!apply) {
    console.log(JSON.stringify({
      ok: true,
      environment,
      apply: false,
      principals: ids.length,
      mappings: ids.map((id) => ({ id, displayName: names.get(id) })),
      message: "Dry run only. Re-run with --apply to repair snapshots.",
    }, null, 2));
    return;
  }

  let repairedStatements = 0;
  for (const id of ids) {
    const displayName = names.get(id).trim();
    for (const target of AUDIT_NAME_TARGETS) {
      coreSql(repairStatement(target, id, displayName));
      repairedStatements += 1;
    }
  }

  const verification = coreSql(unresolvedCountQuery());
  const remaining = Number(verification[0]?.count ?? 0);
  if (remaining !== 0) throw new Error(`Service audit snapshot repair incomplete: ${remaining} broken snapshots remain`);

  console.log(JSON.stringify({
    ok: true,
    environment,
    apply: true,
    principals: ids.length,
    repairedStatements,
    remainingBrokenSnapshots: remaining,
  }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(fileURLToPath(pathToFileURL(process.argv[1]))).href : "";
if (invokedPath === import.meta.url) {
  await main();
}
