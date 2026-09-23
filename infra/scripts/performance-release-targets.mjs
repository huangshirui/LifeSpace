export const USER_READ_TARGETS = Object.freeze({
  taskGet: Object.freeze({ p50Ms: 150, p90Ms: 250 }),
  taskList10: Object.freeze({ p50Ms: 150, p90Ms: 250 }),
  eventWindow: Object.freeze({ p50Ms: 150, p90Ms: 250 }),
  dayRecordList: Object.freeze({ p50Ms: 220, p90Ms: 300 }),
  wishList: Object.freeze({ p50Ms: 150, p90Ms: 250 }),
});

export const USER_MUTATION_TARGETS = Object.freeze({
  taskPatch: Object.freeze({ p50Ms: 160, p90Ms: 250 }),
  taskWorkflow: Object.freeze({ p50Ms: 160, p90Ms: 250 }),
});

export const SERVICE_READ_TARGETS = Object.freeze({
  taskGet: Object.freeze({ p50Ms: 180, p90Ms: 250 }),
  taskList10: Object.freeze({ p50Ms: 180, p90Ms: 250 }),
});

export const SERVICE_MUTATION_TARGETS = Object.freeze({
  taskCreate: Object.freeze({ p50Ms: 220, p90Ms: 300 }),
  taskPatch: Object.freeze({ p50Ms: 220, p90Ms: 300 }),
  taskWorkflow: Object.freeze({ p50Ms: 220, p90Ms: 300 }),
});

export function targetMet(metric, target) {
  return metric.p50Ms <= target.p50Ms && metric.p90Ms <= target.p90Ms;
}

export function evaluateTargets(metrics, targets) {
  return Object.fromEntries(Object.entries(targets).map(([key, target]) => {
    const metric = metrics[key];
    if (!metric) throw new Error(`Missing performance metric for target ${key}`);
    return [key, targetMet(metric, target)];
  }));
}
