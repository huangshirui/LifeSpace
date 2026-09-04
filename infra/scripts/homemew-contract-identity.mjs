import { createHash } from "node:crypto";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const FINGERPRINT_PATTERN = /^msf_[a-f0-9]{64}$/u;

function normalizeModels(models) {
  const entries = Array.isArray(models)
    ? models.map((model) => ({
        key: model?.key,
        route: model?.route,
        schemaHash: model?.schemaHash,
      }))
    : Object.entries(models ?? {}).map(([key, model]) => ({
        key,
        route: model?.route,
        schemaHash: model?.schemaHash,
      }));

  if (!entries.length) throw new Error("HomeMew model semantic identity must contain at least one model");

  const keys = new Set();
  for (const model of entries) {
    if (typeof model.key !== "string" || !model.key) throw new Error("HomeMew model semantic identity contains an invalid model key");
    if (keys.has(model.key)) throw new Error(`HomeMew model semantic identity contains duplicate model ${model.key}`);
    keys.add(model.key);
    if (typeof model.route !== "string" || !model.route) throw new Error(`HomeMew model ${model.key} is missing route identity`);
    if (!HASH_PATTERN.test(model.schemaHash ?? "")) throw new Error(`HomeMew model ${model.key} has invalid schemaHash identity`);
  }

  return entries.sort((left, right) => left.key.localeCompare(right.key));
}

export function calculateModelSemanticFingerprint(models) {
  const normalized = normalizeModels(models);
  const hash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  return `msf_${hash}`;
}

export function acceptedHomeMewModelSemantics(profile) {
  const declared = profile?.contracts?.modelSemantics;
  const models = normalizeModels(declared?.models);
  const fingerprint = calculateModelSemanticFingerprint(models);

  if (!FINGERPRINT_PATTERN.test(declared?.fingerprint ?? "")) {
    throw new Error("HomeMew model semantic fingerprint is invalid");
  }
  if (fingerprint !== declared.fingerprint) {
    throw new Error(`HomeMew model semantic fingerprint does not match its declared model identities: expected ${declared.fingerprint}, calculated ${fingerprint}`);
  }

  return { fingerprint, models };
}

export function assertHomeMewModelSemanticCompatibility(profile, manifestModels, label = "Model Contract") {
  const expected = acceptedHomeMewModelSemantics(profile);
  const actualByKey = new Map((manifestModels ?? []).map((model) => [model?.key, model]));
  const actual = expected.models.map((model) => {
    const manifestModel = actualByKey.get(model.key);
    if (!manifestModel) throw new Error(`${label} is missing HomeMew model ${model.key}`);
    return {
      key: model.key,
      route: manifestModel.route,
      schemaHash: manifestModel.schemaHash,
    };
  });
  const actualFingerprint = calculateModelSemanticFingerprint(actual);

  if (actualFingerprint !== expected.fingerprint) {
    throw new Error(`${label} does not match HomeMew semantic fingerprint ${expected.fingerprint}; got ${actualFingerprint}`);
  }

  return {
    fingerprint: actualFingerprint,
    models: actual,
  };
}
