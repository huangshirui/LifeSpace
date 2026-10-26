// Conservative two-stage APAC release decision. All timings remain measured and counted.
// A narrow first-round P90 miss may be confirmed by two fresh independent sample batches.
// No change to targets, percentile definition, or the measured request segment.
export const APAC_BORDERLINE_FRACTION = 0.10;
export const APAC_CONFIRMATION_ROUNDS = 3;

function percentile(values, p) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil((p / 100) * ordered.length) - 1)];
}

function scenarios(result) {
  return [
    ...Object.entries(result.targets.reads).map(([name, target]) => ({
      category: "reads", name, target, metric: result.reads[name],
    })),
    ...Object.entries(result.targets.mutations).map(([name, target]) => ({
      category: "mutations", name, target, metric: result.mutations[name],
    })),
  ];
}

function validSamples(metric, count) {
  return metric && metric.samples === count && Array.isArray(metric.sampleMs)
    && metric.sampleMs.length === count
    && metric.sampleMs.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function withinTarget(metric, target) {
  return metric.p50Ms <= target.p50Ms && metric.p90Ms <= target.p90Ms;
}

// Return both ordinary passes and exact scenarios eligible for a confirmation run.
// A P50 miss, missing sample, or P90 beyond the narrow borderline is a hard block.
export function planApacConfirmation(initial, sampleCount) {
  const retest = { user: [], service: [] };
  const blocked = [];
  for (const credential of ["user", "service"]) {
    const result = initial[credential];
    if (!result?.acceptanceEligible || !result?.ok) {
      blocked.push({ credential, reason: "invalid-acceptance-result" });
      continue;
    }
    for (const { category, name, target, metric } of scenarios(result)) {
      if (!validSamples(metric, sampleCount)) {
        blocked.push({ credential, category, name, reason: "invalid-sample-set" });
        continue;
      }
      if (withinTarget(metric, target)) continue;
      if (metric.p50Ms <= target.p50Ms
        && metric.p90Ms > target.p90Ms
        && metric.p90Ms <= target.p90Ms * (1 + APAC_BORDERLINE_FRACTION)) {
        retest[credential].push(name);
      } else {
        blocked.push({ credential, category, name, reason: "performance-regression",
          p50Ms: metric.p50Ms, p90Ms: metric.p90Ms });
      }
    }
  }
  return { status: blocked.length ? "blocked"
    : (retest.user.length || retest.service.length ? "confirm" : "passed"), retest, blocked };
}

export function evaluateApacConfirmation(initial, confirmation, retest, sampleCount) {
  const outcomes = [];
  let accepted = true;
  for (const credential of ["user", "service"]) {
    if (!retest[credential].length) continue;
    const rounds = [initial[credential], ...(confirmation[credential] ?? [])];
    if (rounds.length !== APAC_CONFIRMATION_ROUNDS) {
      throw new Error(`APAC confirmation requires ${APAC_CONFIRMATION_ROUNDS} batches for ${credential}`);
    }
    const expected = new Map(scenarios(initial[credential]).map((item) => [item.name, item]));
    for (const name of retest[credential]) {
      const baseline = expected.get(name);
      if (!baseline) throw new Error(`Unknown APAC confirmation scenario: ${credential}/${name}`);
      const samples = [];
      let passingRounds = 0;
      for (const result of rounds) {
        if (!result?.ok || !result?.acceptanceEligible) {
          throw new Error(`Invalid APAC confirmation round: ${credential}/${name}`);
        }
        const metric = result[baseline.category]?.[name];
        if (!validSamples(metric, sampleCount)) {
          throw new Error(`Invalid APAC confirmation samples: ${credential}/${name}`);
        }
        samples.push(...metric.sampleMs);
        if (withinTarget(metric, baseline.target)) passingRounds += 1;
      }
      const combined = { p50Ms: percentile(samples, 50), p90Ms: percentile(samples, 90) };
      const pass = passingRounds >= 2 && withinTarget(combined, baseline.target);
      if (!pass) accepted = false;
      outcomes.push({ credential, category: baseline.category, name, samples: samples.length,
        passingRounds, combinedP50Ms: combined.p50Ms, combinedP90Ms: combined.p90Ms,
        target: baseline.target, pass });
    }
  }
  return { status: accepted ? "passed" : "blocked", outcomes };
}
