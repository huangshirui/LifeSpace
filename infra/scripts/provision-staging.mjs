import { readFile } from "node:fs/promises";

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required");
if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");

const manifest = JSON.parse(await readFile(new URL("../staging/resources.json", import.meta.url), "utf8"));

async function cf(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const payload = await response.json();
  if (!response.ok || payload.success === false) {
    throw new Error(`${init.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(payload.errors ?? payload)}`);
  }
  return payload;
}

async function ensureD1(resource) {
  const listed = await cf(`/accounts/${accountId}/d1/database?name=${encodeURIComponent(resource.name)}&per_page=100`);
  let database = (listed.result ?? []).find((item) => item.name === resource.name);
  if (!database) {
    const created = await cf(`/accounts/${accountId}/d1/database`, {
      method: "POST",
      body: JSON.stringify({ name: resource.name, primary_location_hint: manifest.location }),
    });
    database = created.result;
    console.log(`created D1 ${resource.name}: ${database.uuid}`);
  } else {
    console.log(`D1 ${resource.name} already exists: ${database.uuid}`);
  }
  return { type: "d1", name: resource.name, id: database.uuid };
}

async function ensureR2(resource) {
  const listed = await cf(`/accounts/${accountId}/r2/buckets?name_contains=${encodeURIComponent(resource.name)}&per_page=1000`);
  let bucket = (listed.result?.buckets ?? []).find((item) => item.name === resource.name);
  if (!bucket) {
    const created = await cf(`/accounts/${accountId}/r2/buckets`, {
      method: "POST",
      body: JSON.stringify({ name: resource.name, locationHint: resource.locationHint ?? manifest.location }),
    });
    bucket = created.result;
    console.log(`created R2 ${resource.name}`);
  } else {
    console.log(`R2 ${resource.name} already exists`);
  }
  return { type: "r2", name: resource.name };
}

async function ensureQueue(resource) {
  const listed = await cf(`/accounts/${accountId}/queues`);
  let queue = (listed.result ?? []).find((item) => item.queue_name === resource.name);
  if (!queue) {
    const created = await cf(`/accounts/${accountId}/queues`, {
      method: "POST",
      body: JSON.stringify({ queue_name: resource.name }),
    });
    queue = created.result;
    console.log(`created Queue ${resource.name}: ${queue.queue_id}`);
  } else {
    console.log(`Queue ${resource.name} already exists: ${queue.queue_id}`);
  }
  return { type: "queue", name: resource.name, id: queue.queue_id };
}

const results = [];
for (const resource of manifest.d1 ?? []) results.push(await ensureD1(resource));
for (const resource of manifest.r2 ?? []) results.push(await ensureR2(resource));
for (const resource of manifest.queues ?? []) results.push(await ensureQueue(resource));

console.log("staging provisioning complete");
console.log(JSON.stringify(results, null, 2));

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFile } = await import("node:fs/promises");
  const rows = results.map((item) => `| ${item.type.toUpperCase()} | \`${item.name}\` | ${item.id ? `\`${item.id}\`` : "created/present"} |`).join("\n");
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `## LifeSpace staging resources\n\n| Type | Name | ID/status |\n|---|---|---|\n${rows}\n`);
}
