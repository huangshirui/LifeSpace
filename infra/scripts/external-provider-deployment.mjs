import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const coreDir = resolve(root, "apps/core");
const manifestPath = resolve(root, "infra/external-provider.json");

function printableSecret(value) {
  return typeof value === "string" && /^[\x21-\x7e]{32,512}$/.test(value);
}

function providerToken(value) {
  return typeof value === "string" && value === value.trim() && value.length >= 1 && value.length <= 2048 && !/[\r\n]/u.test(value);
}

export function loadProviderManifest() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.repository !== "huangshirui/lifespace-adapters" || manifest.contractVersion !== 1)
    throw new Error("External Provider repository/contract pin is invalid");
  if (!/^[0-9a-f]{40}$/.test(manifest.revision))
    throw new Error("Adapter revision must be an immutable full commit SHA");
  if (!manifest.providers || Array.isArray(manifest.providers) || typeof manifest.providers !== "object" || !Object.keys(manifest.providers).length)
    throw new Error("External Provider manifest must define at least one provider");
  for (const [key, provider] of Object.entries(manifest.providers)) {
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(key) || !provider || typeof provider !== "object" || Array.isArray(provider))
      throw new Error("External Provider manifest contains an invalid provider key");
    for (const field of ["adapterConfig", "coreBinding", "coreSharedSecret", "workerEnv", "sharedSecretEnv", "vaultMasterKeyEnv", "vaultBinding", "vaultClass"])
      if (typeof provider[field] !== "string" || !provider[field]) throw new Error(`External Provider ${key} is missing ${field}`);
    if (provider.staticConnectionsEnv !== undefined)
      throw new Error(`External Provider ${key} must not declare deployment-managed static connections`);
    if (!/^EXTERNAL_ADAPTER_[A-Z0-9_]{2,64}$/.test(provider.coreBinding)) throw new Error(`External Provider ${key} has an invalid Core binding`);
    if (!/^EXTERNAL_ADAPTER_[A-Z0-9_]{2,64}_SHARED_SECRET$/.test(provider.coreSharedSecret)) throw new Error(`External Provider ${key} has an invalid Core shared-secret binding`);
  }
  return manifest;
}

function validateStagingSmoke(env, secretValues) {
  const token = env.NOTION_SMOKE_TOKEN ?? "";
  if (!providerToken(token)) throw new Error("NOTION_SMOKE_TOKEN must contain the dedicated synthetic staging Notion credential");
  if (!/^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.LIFESPACE_EXTERNAL_SMOKE_RESOURCE_ID ?? ""))
    throw new Error("Staging requires a synthetic Notion data source UUID");
  if (env.LIFESPACE_EXTERNAL_SMOKE_SYNTHETIC_CONFIRMED !== "1")
    throw new Error("Confirm the dedicated smoke data source contains synthetic data only");
  if (secretValues.has(token) || token === env.LIFESPACE_STAGING_BOOTSTRAP_SECRET)
    throw new Error("Staging Notion smoke token must be independent from platform/provider secrets");
}

export function deploymentSettings(env, environment, manifest = loadProviderManifest()) {
  if (!["staging", "production"].includes(environment)) throw new Error("Explicit deployment environment is required");
  const enabled = env.LIFESPACE_EXTERNAL_PROVIDER_ENABLED ?? "0";
  if (!["0", "1"].includes(enabled)) throw new Error("LIFESPACE_EXTERNAL_PROVIDER_ENABLED must be 0 or 1");
  if (enabled === "0") return { enabled: false, environment, providers: [], routes: {}, manifest };

  const cursorSecret = env.EXTERNAL_CURSOR_SECRET ?? "";
  if (!printableSecret(cursorSecret)) throw new Error("EXTERNAL_CURSOR_SECRET must be an independent 32-512 character printable secret");
  if (cursorSecret === env.LIFESPACE_STAGING_BOOTSTRAP_SECRET || cursorSecret === env.LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET)
    throw new Error("External cursor secret must be independent from platform bootstrap secrets");

  const providers = [];
  const routes = {};
  const secretValues = new Set([cursorSecret]);
  for (const [providerKey, definition] of Object.entries(manifest.providers)) {
    const worker = env[definition.workerEnv] ?? "";
    if (!/^[a-z][a-z0-9-]{1,62}$/.test(worker) || worker.startsWith("example-") || ["lifespace-core", "lifespace-identity", "lifespace-console"].some(prefix => worker.startsWith(prefix)))
      throw new Error(`${providerKey} requires a dedicated non-placeholder Adapter Worker name`);
    if ((environment === "staging") !== worker.endsWith("-staging"))
      throw new Error(`${providerKey} Adapter Worker must be environment-isolated: staging names end in -staging; production names must not`);

    const sharedSecret = env[definition.sharedSecretEnv] ?? "";
    if (!printableSecret(sharedSecret)) throw new Error(`${definition.sharedSecretEnv} must be an independent 32-512 character printable secret`);
    const vaultMasterKey = env[definition.vaultMasterKeyEnv] ?? "";
    if (!/^[0-9a-fA-F]{64}$/.test(vaultMasterKey)) throw new Error(`${definition.vaultMasterKeyEnv} must be exactly 32 random bytes encoded as 64 hexadecimal characters`);
    for (const value of [sharedSecret, vaultMasterKey]) {
      if (value === env.LIFESPACE_STAGING_BOOTSTRAP_SECRET || value === env.LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET || secretValues.has(value))
        throw new Error(`${providerKey} Adapter credentials must be independent from every other platform/provider secret`);
      secretValues.add(value);
    }

    providers.push({
      key: providerKey,
      definition,
      worker,
      sharedSecret,
      vaultMasterKey,
    });
    routes[providerKey] = { binding: definition.coreBinding, sharedSecret: definition.coreSharedSecret };
  }
  if (environment === "staging" && Object.hasOwn(manifest.providers, "notion")) validateStagingSmoke(env, secretValues);
  return { enabled: true, environment, providers, routes, cursorSecret, manifest };
}

export function bindProvider(config, settings) {
  const result = structuredClone(config);
  const profile = result.env[settings.environment];
  if (!profile) throw new Error("Core deployment profile is missing");
  const knownBindings = new Set(["EXTERNAL_ADAPTER", ...Object.values(settings.manifest.providers).map(provider => provider.coreBinding)]);
  profile.services = (profile.services ?? []).filter(binding => !knownBindings.has(binding.binding));
  if (!profile.vars) profile.vars = {};
  delete profile.vars.EXTERNAL_PROVIDER_ROUTES;
  if (settings.enabled) {
    for (const provider of settings.providers)
      profile.services.push({ binding: provider.definition.coreBinding, service: provider.worker });
    profile.vars.EXTERNAL_PROVIDER_ROUTES = JSON.stringify(settings.routes);
  }
  return result;
}

export function validateProviderProfile(config, environment, provider) {
  const profile = config.env?.[environment];
  const vault = profile?.durable_objects?.bindings?.find(binding => binding.name === provider.definition.vaultBinding);
  if (!profile || config.workers_dev !== false || config.preview_urls !== false || profile.workers_dev !== false || profile.preview_urls !== false || !Array.isArray(profile.routes) || profile.routes.length || config.routes?.length)
    throw new Error(`${provider.key} Adapter packaging must have an explicit private deployment profile`);
  if (!vault || vault.class_name !== provider.definition.vaultClass)
    throw new Error(`${provider.key} Adapter packaging must bind its per-connection Durable Object vault`);
}

export function validateLiveCoreBindings(core, settings) {
  const bindings = core.bindings ?? [];
  if (bindings.some(binding => binding.type === "service" && binding.name === "EXTERNAL_ADAPTER"))
    throw new Error("Live Core must not use the legacy generic External Adapter Service Binding");
  if (!bindings.some(binding => binding.type === "secret_text" && binding.name === "EXTERNAL_CURSOR_SECRET"))
    throw new Error("Live Core EXTERNAL_CURSOR_SECRET is absent");
  if (!bindings.some(binding => binding.type === "plain_text" && binding.name === "EXTERNAL_SCHEMA_REFRESH_SECONDS" && Number.isInteger(Number(binding.text)) && Number(binding.text) >= 60 && Number(binding.text) <= 86400))
    throw new Error("Live External schema refresh configuration is invalid");
  const routeBinding = bindings.find(binding => binding.type === "plain_text" && binding.name === "EXTERNAL_PROVIDER_ROUTES");
  if (!routeBinding || routeBinding.text !== JSON.stringify(settings.routes))
    throw new Error("Live Core External provider routing table does not match the release");
  for (const provider of settings.providers) {
    if (!bindings.some(binding => binding.type === "service" && binding.name === provider.definition.coreBinding && binding.service === provider.worker))
      throw new Error(`Live Core ${provider.key} Adapter binding does not match the release`);
    if (!bindings.some(binding => binding.type === "secret_text" && binding.name === provider.definition.coreSharedSecret))
      throw new Error(`Live Core ${provider.key} Adapter shared secret is absent`);
  }
}

export function validateLiveAdapterBindings(adapter, provider) {
  for (const name of ["EXTERNAL_ADAPTER_SHARED_SECRET", "CONNECTION_VAULT_MASTER_KEY"])
    if (!adapter.bindings?.some(binding => binding.type === "secret_text" && binding.name === name))
      throw new Error(`Live ${provider.key} Adapter required secret binding is absent`);
  if (!adapter.bindings?.some(binding => binding.type === "durable_object_namespace" && binding.name === provider.definition.vaultBinding))
    throw new Error(`Live ${provider.key} Adapter per-connection Durable Object vault binding is absent`);
}

export function validateLiveBindings(core, adapter, settings, provider = settings.providers[0]) {
  validateLiveCoreBindings(core, settings);
  if (!provider) throw new Error("A provider is required for Adapter verification");
  validateLiveAdapterBindings(adapter, provider);
}

export function adapterWranglerCommands(configPath, environment, worker) {
  return {
    deploy: ["deploy", "--config", configPath, "--env", environment, "--name", worker],
    secrets: ["secret", "bulk", "--config", configPath, "--name", worker],
  };
}

async function main() {
  const [mode, environment] = process.argv.slice(2);
  if (!["prepare", "deploy-adapter", "sync-core", "verify"].includes(mode)) throw new Error("Unknown External provider deployment mode");
  const manifest = loadProviderManifest();
  const settings = deploymentSettings(process.env, environment, manifest);

  if (mode === "prepare") {
    if (!process.env.GITHUB_ENV) throw new Error("GITHUB_ENV is required");
    appendFileSync(process.env.GITHUB_ENV, `LIFESPACE_EXTERNAL_PROVIDER_ACTIVE=${settings.enabled ? "1" : "0"}\nLIFESPACE_EXTERNAL_PROVIDER_REVISION=${manifest.revision}\n`);
    const configPath = resolve(coreDir, "wrangler.jsonc");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (settings.enabled) writeFileSync(configPath, JSON.stringify(bindProvider(config, settings), null, 2) + "\n");
    console.log(`External provider routing validated (${environment}; enabled=${settings.enabled}; providers=${settings.providers.map(provider => provider.key).join(",") || "none"})`);
    return;
  }
  if (!settings.enabled) { console.log("External providers disabled explicitly; provider acceptance not claimed"); return; }

  function wrangler(args, secrets) {
    execFileSync("pnpm", ["exec", "wrangler", ...args], {
      cwd: coreDir,
      env: process.env,
      input: secrets ? JSON.stringify(secrets) : undefined,
      stdio: ["pipe", "inherit", "inherit"],
    });
  }

  if (mode === "deploy-adapter") {
    const adapterDir = resolve(root, ".external-provider");
    const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: adapterDir, encoding: "utf8" }).trim();
    if (actual !== manifest.revision) throw new Error("Adapter checkout does not match the pinned release SHA");
    for (const provider of settings.providers) {
      const configPath = resolve(adapterDir, provider.definition.adapterConfig);
      validateProviderProfile(JSON.parse(readFileSync(configPath, "utf8")), environment, provider);
      const commands = adapterWranglerCommands(configPath, environment, provider.worker);
      wrangler(commands.deploy);
      wrangler(commands.secrets, {
        EXTERNAL_ADAPTER_SHARED_SECRET: provider.sharedSecret,
        CONNECTION_VAULT_MASTER_KEY: provider.vaultMasterKey,
      });
      console.log(`Private ${provider.key} provider deployed at pinned revision ${manifest.revision}`);
    }
  } else if (mode === "sync-core") {
    const secrets = { EXTERNAL_CURSOR_SECRET: settings.cursorSecret };
    for (const provider of settings.providers) secrets[provider.definition.coreSharedSecret] = provider.sharedSecret;
    wrangler(["secret", "bulk", "--env", environment], secrets);
  } else if (mode === "verify") {
    const account = process.env.CLOUDFLARE_ACCOUNT_ID, token = process.env.CLOUDFLARE_API_TOKEN;
    if (!account || !token) throw new Error("Cloudflare deployment credentials are required");
    const cf = async path => {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30000),
      });
      const payload = await response.json();
      if (!response.ok || payload.success === false) throw new Error(`Provider deployment verification failed (HTTP ${response.status})`);
      return payload.result;
    };
    const coreName = environment === "staging" ? "lifespace-core-staging" : "lifespace-core";
    let lastError;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const core = await cf(`scripts/${coreName}/settings`);
        validateLiveCoreBindings(core, settings);
        const domains = await cf("domains");
        if (!Array.isArray(domains)) throw new Error("Custom-domain exposure is unverified");
        for (const provider of settings.providers) {
          const [adapter, exposure] = await Promise.all([
            cf(`scripts/${provider.worker}/settings`),
            cf(`scripts/${provider.worker}/subdomain`),
          ]);
          validateLiveAdapterBindings(adapter, provider);
          if (exposure.enabled !== false || exposure.previews_enabled !== false)
            throw new Error(`${provider.key} Adapter workers.dev or preview URL exposure is enabled or unverified`);
          if (domains.some(domain => domain.service === provider.worker))
            throw new Error(`${provider.key} Adapter has a public custom domain`);
        }
        lastError = null;
        break;
      } catch (error) { lastError = error; }
      if (attempt < 7) await new Promise(resolve => setTimeout(resolve, 2000));
    }
    if (lastError) throw lastError;
    console.log("Live provider routing, provider-specific Service Bindings/shared secrets, Core cursor secret, private Adapter exposure and encrypted per-connection vault bindings verified");
  } else throw new Error("Unknown External provider deployment mode");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
