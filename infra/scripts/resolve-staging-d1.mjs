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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const databases = await listD1();

for (const resource of manifest.d1 ?? []) {
  const database = databases.find((item) => item.name === resource.name);
  if (!database?.uuid) throw new Error(`Required staging D1 database does not exist: ${resource.name}`);

  const configUrl = new URL(`../../${resource.config}`, import.meta.url);
  const source = await readFile(configUrl, "utf8");
  const pattern = new RegExp(
    `("database_name"\\s*:\\s*"${escapeRegExp(resource.name)}"\\s*,\\s*"database_id"\\s*:\\s*")[^"]+(")`,
  );

  // This modifies only the ephemeral CI checkout. Real Cloudflare UUIDs do not
  // need to be copied by hand or committed to the repository.
  const updated = source.replace(pattern, `$1${database.uuid}$2`);
  if (updated === source) throw new Error(`Could not resolve D1 binding for ${resource.name} in ${resource.config}`);

  await writeFile(configUrl, updated);
  console.log(`resolved ${resource.name} -> ${database.uuid} in ${resource.config}`);
}
