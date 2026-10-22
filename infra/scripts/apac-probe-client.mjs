function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createApacProbeRequestAdapter({
  probeUrl,
  probeToken,
  credentialMode,
  fetchImpl = fetch,
  sleepImpl = defaultSleep,
  routeAttempts = 6,
  routeDelayMs = 2000,
}) {
  if (!probeUrl) throw new Error("probeUrl is required");
  if (!probeToken) throw new Error("probeToken is required");
  if (credentialMode !== "user" && credentialMode !== "service") {
    throw new Error(`unsupported credentialMode: ${String(credentialMode)}`);
  }
  if (!Number.isInteger(routeAttempts) || routeAttempts < 1) {
    throw new Error("routeAttempts must be a positive integer");
  }

  const observations = [];
  const request = async (path, { method = "GET", body } = {}) => {
    for (let attempt = 1; attempt <= routeAttempts; attempt += 1) {
      const start = performance.now();
      const response = await fetchImpl(`${probeUrl}/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lifespace-probe-token": probeToken,
        },
        body: JSON.stringify({ path, method, credentialMode, ...(body === undefined ? {} : { body }) }),
      });

      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        const transientWorkersDevRoute404 = response.status === 404;
        if (transientWorkersDevRoute404 && attempt < routeAttempts) {
          console.warn(`APAC probe workers.dev route returned non-JSON 404; retrying after propagation delay (${attempt}/${routeAttempts})`);
          await sleepImpl(routeDelayMs);
          continue;
        }
        throw new Error(`APAC probe returned non-JSON ${response.status} after ${attempt} attempt(s): ${text.slice(0, 500)}`);
      }

      if (!response.ok) {
        throw new Error(`APAC probe failed ${response.status}: ${JSON.stringify(payload)}`);
      }
      if (!payload || !Number.isInteger(payload.status) || typeof payload.elapsedMs !== "number") {
        throw new Error(`APAC probe returned an invalid benchmark result: ${JSON.stringify(payload)}`);
      }
      if (payload.credentialMode !== credentialMode) {
        throw new Error(`APAC probe credential mode mismatch: expected ${credentialMode}, got ${JSON.stringify(payload.credentialMode)}`);
      }
      // Diagnostic only: runner-to-probe timing is deliberately excluded from the gate.
      const clientToProbeMs = performance.now() - start;
      const route = `${method.toUpperCase()} ${new URL(path, 'https://core-staging.aisr.online').pathname}`
        .replace(/spc_[a-zA-Z0-9]+/gu, 'spc_*')
        .replace(/rec_[a-zA-Z0-9]+/gu, 'rec_*');
      observations.push({
        route,
        coreHeadersMs: payload.elapsedMs,
        coreBodyMs: typeof payload.coreResponseBodyMs === 'number' ? payload.coreResponseBodyMs : null,
        runnerToProbeMs: clientToProbeMs,
        probeIngressColo: payload.probeIngressColo ?? null,
      });
      return payload;
    }

    throw new Error("APAC probe route retry loop exhausted unexpectedly");
  };
  // All returned data is route-patterned and numeric, never bearer/request payload.
  request.diagnostics = () => observations.map((sample) => ({ ...sample }));
  return request;
}
