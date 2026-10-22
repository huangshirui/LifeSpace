import process from "node:process";

const probeUrl = (process.env.LIFESPACE_APAC_PROBE_URL ?? "").replace(/\/+$/u, "");
const probeToken = process.env.LIFESPACE_APAC_PROBE_TOKEN ?? "";
const spaceId = process.env.LIFESPACE_STAGING_SPACE_ID ?? "";

for (const [name, value] of Object.entries({
  LIFESPACE_APAC_PROBE_URL: probeUrl,
  LIFESPACE_APAC_PROBE_TOKEN: probeToken,
  LIFESPACE_STAGING_SPACE_ID: spaceId,
})) {
  if (!value) throw new Error(`${name} is required`);
}

// workers.dev route propagation is eventually consistent. Keep this bounded but
// long enough to distinguish propagation lag from an actually broken probe.
const attempts = 30;
const delayMs = 2000;

async function readResponse(response) {
  const text = await response.text();
  if (!text) return { text, payload: null };
  try {
    return { text, payload: JSON.parse(text) };
  } catch {
    return { text, payload: null };
  }
}

async function probeHealth() {
  const response = await fetch(`${probeUrl}/health`, {
    headers: { "x-lifespace-probe-token": probeToken },
  });
  const { text, payload } = await readResponse(response);
  return {
    ok: response.ok && payload?.ok === true,
    detail: payload ?? text.slice(0, 300),
    status: response.status,
  };
}

async function probeBenchmarkRoute() {
  const response = await fetch(`${probeUrl}/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lifespace-probe-token": probeToken,
    },
    body: JSON.stringify({
      method: "GET",
      path: `/api/v1/spaces/${spaceId}/models/task/records?limit=1`,
    }),
  });
  const { text, payload } = await readResponse(response);
  return {
    ok: response.ok && payload?.status === 200 && typeof payload?.elapsedMs === "number",
    detail: payload ?? text.slice(0, 300),
    status: response.status,
  };
}

let last = null;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const health = await probeHealth();
    if (!health.ok) {
      last = { stage: "health", ...health };
    } else {
      const benchmarkRoute = await probeBenchmarkRoute();
      if (benchmarkRoute.ok) {
        console.log(JSON.stringify({
          ok: true,
          attempts: attempt,
          probeIngressColo: health.detail?.probeIngressColo ?? null,
          benchmarkRouteElapsedMs: benchmarkRoute.detail?.elapsedMs ?? null,
        }, null, 2));
        process.exit(0);
      }
      last = { stage: "run", ...benchmarkRoute };
    }
  } catch (error) {
    last = { stage: "transport", error: error instanceof Error ? error.message : String(error) };
  }

  if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

throw new Error(`APAC probe did not converge for the real benchmark route: ${JSON.stringify(last)}`);
