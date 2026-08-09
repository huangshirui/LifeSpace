import { readFile, writeFile } from "node:fs/promises";

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required");
if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");

const manifest = JSON.parse(await readFile(new URL("../staging/resources.json", import.meta.url), "utf8"));

async function listD1() {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?per_page=1000`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const payload = await response.json();
  if (!response.ok || payload.success === false) {
    throw new Error(`Unable to list D1 databases (${response.status}): ${JSON.stringify(payload.errors ?? payload)}`);
  }
  return payload.result ?? [];
}

const databases = await listD1();

for (const resource of manifest.d1 ?? []) {
  const database = databases.find((item) => item.name === resource.name);
  if (!database?.uuid) throw new Error(`Required staging D1 database does not exist: ${resource.name}`);

  const configUrl = new URL(`../../${resource.config}`, import.meta.url);
  const source = await readFile(configUrl, "utf8");
  const escapedName = resource.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`("database_name"\\s*:\\s*"${escapedName}"\\s*,\\s*"database_id"\\s*:\\s*")[^"]+(" )`.replace('(" )', '(" )'));

  // Keep the source repository free of account-specific UUID churn. This edit is
  // made only in the ephemeral CI checkout before Wrangler migration/deploy.
  const simplerPattern = new RegExp(`("database_name"\\s*:\\s*"${escapedName}"\\s*,\\s*"database_id"\\s*:\\s*")[^"]+(" )`.replace('(" )', '(" )'));
  let updated = source.replace(simplerPattern, `$1${database.uuid}$2`);

  if (updated === source) {
    const exactPattern = new RegExp(`("database_name"\\s*:\\s*"${escapedName}"\\s*,\\s*"database_id"\\s*:\\s*")[^"]+(")`);
    updated = source.replace(exactPattern, `$1${database.uuid}$2`);
  }
  if (updated === source) throw new Error(`Could not resolve D1 binding for ${resource.name} in ${resource.config}`);

  await writeFile(configUrl, updated);
  console.log(`resolved ${resource.name} -> ${database.uuid} in ${resource.config}`);
}
