import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const coreDir = resolve(root, "apps/core");
export function deploymentSettings(env, environment) {
  if (!["staging", "production"].includes(environment)) throw new Error("Explicit deployment environment is required");
  const enabled = env.LIFESPACE_EXTERNAL_PROVIDER_ENABLED ?? "0";
  if (!["0", "1"].includes(enabled)) throw new Error("LIFESPACE_EXTERNAL_PROVIDER_ENABLED must be 0 or 1");
  if (enabled === "0") return { enabled: false, environment };
  const worker = env.LIFESPACE_EXTERNAL_ADAPTER_WORKER ?? "";
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(worker) || worker.startsWith("example-") || ["lifespace-core", "lifespace-identity", "lifespace-console"].some(prefix => worker.startsWith(prefix))) throw new Error("A dedicated non-placeholder Adapter Worker name is required");
  if ((environment === "staging") !== worker.endsWith("-staging")) throw new Error("Adapter Worker must be environment-isolated: staging names end in -staging; production names must not");
  const secret = env.EXTERNAL_ADAPTER_SHARED_SECRET ?? "";
  if (!/^[\x21-\x7e]{32,512}$/.test(secret) || secret === env.LIFESPACE_STAGING_BOOTSTRAP_SECRET || secret === env.LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET) throw new Error("An independent External Adapter shared secret of 32-512 printable ASCII characters without whitespace is required");
  const vaultKey = env.CONNECTION_VAULT_MASTER_KEY ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(vaultKey)) throw new Error("CONNECTION_VAULT_MASTER_KEY must be exactly 32 random bytes encoded as 64 hexadecimal characters");
  if (vaultKey === secret || vaultKey === env.LIFESPACE_STAGING_BOOTSTRAP_SECRET || vaultKey === env.LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET) throw new Error("Connection vault master key must be independent from platform and Adapter shared secrets");
  const rawConnections = env.NOTION_CONNECTIONS?.trim() || (environment === "production" ? "{}" : "");
  let connections;
  try { connections = JSON.parse(rawConnections); } catch { throw new Error("NOTION_CONNECTIONS must be a valid secret JSON object when configured"); }
  if (!connections || Array.isArray(connections) || typeof connections !== "object") throw new Error("NOTION_CONNECTIONS must be a JSON object");
  if (environment === "staging" && !Object.keys(connections).length) throw new Error("Staging NOTION_CONNECTIONS must contain the synthetic smoke connection");
  for (const [ref, connection] of Object.entries(connections)) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(ref) || !connection || typeof connection !== "object" || Array.isArray(connection) || typeof connection.token !== "string" || !connection.token || connection.token !== connection.token.trim() || /[\r\n]/.test(connection.token) || typeof connection.read !== "boolean" || typeof connection.write !== "boolean" || (connection.disabled !== undefined && typeof connection.disabled !== "boolean")) throw new Error("NOTION_CONNECTIONS contains an invalid connection entry");
    if (connection.token === vaultKey) throw new Error("Connection vault master key must not reuse a provider credential");
  }
  if (environment === "staging") {
    const ref = env.LIFESPACE_EXTERNAL_SMOKE_CREDENTIAL_REF ?? "";
    if (!Object.hasOwn(connections, ref) || connections[ref].disabled || !connections[ref].read || !connections[ref].write) throw new Error("Staging requires an active read/write synthetic smoke connection");
    if (!/^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.LIFESPACE_EXTERNAL_SMOKE_RESOURCE_ID ?? "")) throw new Error("Staging requires a synthetic Notion data source UUID");
    if (env.LIFESPACE_EXTERNAL_SMOKE_SYNTHETIC_CONFIRMED !== "1") throw new Error("Confirm the dedicated smoke data source contains synthetic data only");
  }
  return { enabled: true, environment, worker };
}

export function bindProvider(config, settings) {
  const result = structuredClone(config);
  const profile = result.env[settings.environment];
  profile.services = profile.services.filter(binding => binding.binding !== "EXTERNAL_ADAPTER");
  if (settings.enabled) profile.services.push({ binding: "EXTERNAL_ADAPTER", service: settings.worker });
  return result;
}

export function validateProviderProfile(config, environment) {
  const profile = config.env?.[environment];
  const vault = profile?.durable_objects?.bindings?.find(binding => binding.name === "CONNECTIONS");
  if (!profile || config.workers_dev !== false || config.preview_urls !== false || profile.workers_dev !== false || profile.preview_urls !== false || !Array.isArray(profile.routes) || profile.routes.length || config.routes?.length) throw new Error("Adapter packaging must have an explicit private deployment profile");
  if (!vault || vault.class_name !== "NotionConnectionVault") throw new Error("Adapter packaging must bind the per-connection Durable Object vault as CONNECTIONS");
}

export function validateLiveBindings(core, adapter, settings) {
  const bindings = core.bindings ?? [];
  if (!bindings.some(b => b.type === "service" && b.name === "EXTERNAL_ADAPTER" && b.service === settings.worker)) throw new Error("Live Core External Adapter binding does not match the release");
  if (!bindings.some(b => b.type === "secret_text" && b.name === "EXTERNAL_ADAPTER_SHARED_SECRET")) throw new Error("Live Core External Adapter shared secret is absent");
  if (!bindings.some(b => b.type === "plain_text" && b.name === "EXTERNAL_SCHEMA_REFRESH_SECONDS" && Number.isInteger(Number(b.text)) && Number(b.text) >= 60 && Number(b.text) <= 86400)) throw new Error("Live External schema refresh configuration is invalid");
  for (const name of ["EXTERNAL_ADAPTER_SHARED_SECRET", "NOTION_CONNECTIONS", "CONNECTION_VAULT_MASTER_KEY"]) {
    if (!adapter.bindings?.some(b => b.type === "secret_text" && b.name === name)) throw new Error("Live Adapter required secret binding is absent");
  }
  if (!adapter.bindings?.some(b => b.type === "durable_object_namespace" && b.name === "CONNECTIONS")) throw new Error("Live Adapter per-connection Durable Object vault binding is absent");
}

export function adapterWranglerCommands(configPath, environment, worker) {
  return {
    deploy: ["deploy", "--config", configPath, "--env", environment, "--name", worker],
    // The Worker name is already explicitly environment-isolated. Passing --env
    // together with --name to `secret bulk` makes Wrangler environment-qualify
    // the explicit name again (for example `*-staging-staging`). Target the exact
    // deployed Worker name instead.
    secrets: ["secret", "bulk", "--config", configPath, "--name", worker],
  };
}

async function main() {
  const [mode, environment] = process.argv.slice(2);
  if (!["prepare", "deploy-adapter", "sync-core", "verify"].includes(mode)) throw new Error("Unknown External provider deployment mode");
  const settings = deploymentSettings(process.env, environment);
  const manifest = JSON.parse(readFileSync(resolve(root, "infra/external-provider.json"), "utf8"));
  if (manifest.repository !== "huangshirui/lifespace-adapters" || manifest.contractVersion !== 1) throw new Error("External Provider repository/contract pin is invalid");
  if (!/^[0-9a-f]{40}$/.test(manifest.revision)) throw new Error("Adapter revision must be an immutable full commit SHA");
  if (mode === "prepare") {
    if (!process.env.GITHUB_ENV) throw new Error("GITHUB_ENV is required");
    appendFileSync(process.env.GITHUB_ENV, `LIFESPACE_EXTERNAL_PROVIDER_ACTIVE=${settings.enabled ? "1" : "0"}\nLIFESPACE_EXTERNAL_PROVIDER_REVISION=${manifest.revision}\n`);
    const configPath = resolve(coreDir, "wrangler.jsonc");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    // Avoid changing the checkout at all when the optional provider is disabled.
    if (settings.enabled) writeFileSync(configPath, JSON.stringify(bindProvider(config, settings), null, 2) + "\n");
    console.log(`External provider configuration validated (${environment}; enabled=${settings.enabled})`);
    return;
  }
  if (!settings.enabled) { console.log("External provider disabled explicitly; provider acceptance not claimed"); return; }
  function wrangler(args, secrets) {
    // Never interpolate credentials into shell arguments or files. Wrangler receives secrets over stdin.
    execFileSync("pnpm", ["exec", "wrangler", ...args], { cwd: coreDir, env: process.env, input: secrets ? JSON.stringify(secrets) : undefined, stdio: ["pipe", "inherit", "inherit"] });
  }
  if (mode === "deploy-adapter") {
    const adapterDir = resolve(root, ".external-provider");
    const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: adapterDir, encoding: "utf8" }).trim();
    if (actual !== manifest.revision) throw new Error("Adapter checkout does not match the pinned release SHA");
    const configPath = resolve(adapterDir, "adapters/notion/wrangler.jsonc");
    validateProviderProfile(JSON.parse(readFileSync(configPath, "utf8")), environment);
    const commands = adapterWranglerCommands(configPath, environment, settings.worker);
    wrangler(commands.deploy);
    wrangler(commands.secrets, {
      EXTERNAL_ADAPTER_SHARED_SECRET: process.env.EXTERNAL_ADAPTER_SHARED_SECRET,
      CONNECTION_VAULT_MASTER_KEY: process.env.CONNECTION_VAULT_MASTER_KEY,
      // Production may have no deployment-managed connection at all. Writing an
      // explicit empty object also removes any stale static references from the
      // canonical Adapter configuration while keeping the secret-shaped boundary.
      NOTION_CONNECTIONS: process.env.NOTION_CONNECTIONS?.trim() || "{}",
    });
    console.log(`Private provider deployed at pinned revision ${manifest.revision}`);
  } else if (mode === "sync-core") {
    wrangler(["secret", "bulk", "--env", environment], { EXTERNAL_ADAPTER_SHARED_SECRET: process.env.EXTERNAL_ADAPTER_SHARED_SECRET });
  } else if (mode === "verify") {
    const account = process.env.CLOUDFLARE_ACCOUNT_ID, token = process.env.CLOUDFLARE_API_TOKEN;
    if (!account || !token) throw new Error("Cloudflare deployment credentials are required");
    const cf = async path => {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
      const payload = await response.json();
      if (!response.ok || payload.success === false) throw new Error(`Provider deployment verification failed (HTTP ${response.status})`);
      return payload.result;
    };
    const coreName = environment === "staging" ? "lifespace-core-staging" : "lifespace-core";
    // Cloudflare settings can lag an upload/secret update. Retry metadata reads
    // only; no Worker upload or Provider mutation is replayed.
    let lastError;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const [core, adapter, exposure, domains] = await Promise.all([cf(`scripts/${coreName}/settings`), cf(`scripts/${settings.worker}/settings`), cf(`scripts/${settings.worker}/subdomain`), cf("domains")]);
        validateLiveBindings(core, adapter, settings);
        if (exposure.enabled !== false || exposure.previews_enabled !== false) throw new Error("Adapter workers.dev or preview URL exposure is enabled or unverified");
        if (!Array.isArray(domains) || domains.some(domain => domain.service === settings.worker)) throw new Error("Adapter has a public custom domain or custom-domain exposure is unverified");
        lastError = null;
        break;
      } catch (error) { lastError = error; }
      if (attempt < 7) await new Promise(resolve => setTimeout(resolve, 2000));
    }
    if (lastError) throw lastError;
    console.log("Live private Adapter binding, shared secret, encrypted credential-vault secret, per-connection Durable Object vault and refresh configuration verified; shared-secret equality is checked by staging Source creation");
  } else throw new Error("Unknown External provider deployment mode");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
