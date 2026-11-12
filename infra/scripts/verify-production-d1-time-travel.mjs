// Production D1 migration safety gate: read-only Cloudflare API / no dumps.
// Obtain Time Travel bookmarks privately; only safe timestamp/version summaries
// may appear in public GitHub Actions logs.
import { pathToFileURL } from "node:url";
import { PRODUCTION_EXPECTATIONS } from "./production-expectations.mjs";

export function checkMigrationVersion({ current, expected, label }) {
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(expected)
    || current < 1 || expected < current) {
    throw new Error("Production " + label + " schema is unavailable or newer than candidate");
  }
  return { service: label, current, expected, pending: expected - current };
}

export async function checkProductionD1Safety({ env = process.env, fetcher = fetch } = {}) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || "";
  const token = env.CLOUDFLARE_API_TOKEN || "";
  if (!/^[a-f0-9]{32}$/iu.test(accountId) || !token) {
    throw new Error("Protected Cloudflare credentials required for read-only D1 preflight");
  }
  async function cf(path, options = {}) {
    const response = await fetcher("https://api.cloudflare.com/client/v4/accounts/"
      + accountId + path, {
      method: options.method || "GET",
      headers: { authorization: "Bearer " + token,
        accept: "application/json",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.success !== true) {
      throw new Error("Production D1 read-only API request failed (HTTP " + response.status + ")");
    }
    return result.result;
  }
  const versions = [];
  for (const [label, worker] of [["core", "lifespace-core"], ["identity", "lifespace-identity"]]) {
    const settings = await cf("/workers/scripts/" + worker + "/settings");
    const databases = (settings?.bindings || []).filter(x => x.type === "d1" && x.name === "DB");
    if (databases.length !== 1 || !/^[a-f0-9-]{36}$/iu.test(databases[0].id || "")) {
      throw new Error("Production " + label + " D1 binding missing or ambiguous");
    }
    const id = databases[0].id;
    const rows = await cf("/d1/database/" + id + "/query", {
      method: "POST",
      body: { sql: "SELECT value FROM schema_metadata WHERE key='schema_version'" },
    });
    if (!Array.isArray(rows) || !rows[0]?.success || !Array.isArray(rows[0]?.results)) {
      throw new Error("Production " + label + " schema query failed");
    }
    const value = rows[0].results[0]?.value;
    const v = checkMigrationVersion({
      current: Number(value), expected: PRODUCTION_EXPECTATIONS[label].schemaVersion, label,
    });
    const bookmark = await cf("/d1/database/" + id + "/time_travel/bookmark");
    if (typeof bookmark?.bookmark !== "string"
      || !/^[0-9a-zA-Z-]{24,128}$/u.test(bookmark.bookmark)) {
      throw new Error("Production " + label + " Time Travel backup bookmark is unavailable");
    }
    // The operator can recover a bookmark from this timestamp for the
    // Cloudflare-supported retention window. Do not print the actual bookmark
    // or export real household/user data to public GitHub artifacts.
    versions.push({ ...v, timeTravelVerified: true });
  }
  return { ok: true, checkedAtUTC: new Date().toISOString(), services: versions,
    noMutations: true, noDataExport: true, bookmarksNotLogged: true,
    restoreIsDestructiveAndRequiresSeparateOwnerApproval: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await checkProductionD1Safety(), null, 2));
}
