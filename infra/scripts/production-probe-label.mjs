export function boundedProbeLabel(prefix, probeId, maxLength = 50) {
  if (!Number.isInteger(maxLength) || maxLength < 3) throw new Error("maxLength must be an integer >= 3");
  const normalizedPrefix = String(prefix ?? "").trim();
  const normalizedProbeId = String(probeId ?? "").trim();
  if (!normalizedPrefix) throw new Error("Probe label prefix is required");
  if (!normalizedProbeId) throw new Error("Probe ID is required");
  if (normalizedPrefix.length >= maxLength) throw new Error("Probe label prefix leaves no room for a unique suffix");

  const suffixBudget = maxLength - normalizedPrefix.length - 1;
  const suffix = normalizedProbeId.slice(-suffixBudget);
  const label = `${normalizedPrefix} ${suffix}`;
  if (label.length > maxLength) throw new Error(`Probe label exceeded ${maxLength} characters`);
  return label;
}
