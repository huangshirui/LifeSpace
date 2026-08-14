import { readFile } from "node:fs/promises";

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required");
if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");

const manifest = JSON.parse(await readFile(new URL("../production/resources.json", import.meta.url), "utf8"));

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
  return payload.result;
}

const existing = await cf(`/accounts/${accountId}/workers/domains`);

for (const desired of manifest.domains ?? []) {
  const current = (existing ?? []).find((item) => item.hostname === desired.hostname);
  if (!current) continue;
  if (current.service !== desired.service) {
    throw new Error(
      `Production custom domain ${desired.hostname} is already attached to ${current.service}; refusing to move it to ${desired.service}`,
    );
  }
  console.log(`Production custom domain ${desired.hostname} already attached to ${desired.service}`);
}

if (process.env.PRODUCTION_DOMAIN_PREFLIGHT_ONLY === "1") {
  console.log("production custom-domain preflight passed");
  process.exit(0);
}

for (const desired of manifest.domains ?? []) {
  const current = (existing ?? []).find((item) => item.hostname === desired.hostname);
  if (current) continue;

  const attached = await cf(`/accounts/${accountId}/workers/domains`, {
    method: "PUT",
    body: JSON.stringify({
      hostname: desired.hostname,
      service: desired.service,
      zone_name: desired.zoneName,
    }),
  });
  console.log(`Attached production custom domain ${attached.hostname} -> ${attached.service}`);
}

const verified = await cf(`/accounts/${accountId}/workers/domains`);
for (const desired of manifest.domains ?? []) {
  const current = (verified ?? []).find(
    (item) => item.hostname === desired.hostname && item.service === desired.service,
  );
  if (!current) throw new Error(`Production custom domain verification failed for ${desired.hostname}`);
}

console.log("production custom domains verified");
