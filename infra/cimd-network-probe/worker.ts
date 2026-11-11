// Remote Cloudflare Worker preview: controlled SSRF reachability probes.
//
// Only static targets are attempted. No user-controlled URL, no token/secret
// returned, and no Identity/Core/D1 bindings. This is NEVER the Identity Worker.
// The owner-dispatched acceptance runner tears down its temporary remote dev
// session. In particular, this does NOT request real cloud metadata endpoints.
import { fetchClientMetadata } from "../../apps/identity/src/oauth-client-metadata";

interface Env { PROBE_TOKEN: string; REBIND_HOST?: string }
const clientId = "https://cdn.jsdelivr.net/gh/huangshirui/LifeSpace@main/infra/cimd-network-probe/client.json";
type Result = { name: string; outcome: "http" | "error" | "timeout"; status?: number; error?: string };

const cases = [
  { name: "loopback-v4", url: "https://127.0.0.1/cimd-test" },
  { name: "loopback-v6", url: "https://[::1]/cimd-test" },
  { name: "private-v4", url: "https://10.255.255.254/cimd-test" },
  { name: "private-v6-ula", url: "https://[fd00::1234]/cimd-test" },
  // External DNS name that maps to loopback. This is a DNS-to-private
  // negative case, NOT a complete in-flight DNS rebinding simulation.
  { name: "dns-to-loopback-v4", url: "https://127.0.0.1.sslip.io/cimd-test" },
] as const;

async function check(target: typeof cases[number]): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    timer = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(target.url, {
      method: "GET", redirect: "manual", signal: controller.signal,
      headers: { accept: "application/json" },
    });
    await response.body?.cancel().catch(() => undefined);
    return { name: target.name, outcome: "http", status: response.status };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { name: target.name, outcome: controller.signal.aborted ? "timeout" : "error",
      error: text.slice(0, 160) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health") return new Response("ready", { status: 200 });
    if (!["/probe", "/dns-flip"].includes(path) || request.method !== "POST") {
      return new Response("Not Found", { status: 404 });
    }
    if (!env.PROBE_TOKEN ||
      request.headers.get("authorization") !== "Bearer " + env.PROBE_TOKEN) {
      return new Response("Forbidden", { status: 403 });
    }
    if (path === "/dns-flip") {
      // The ONLY dynamic hostname comes from an owner-only workflow setting,
      // not request JSON, URL parameters or headers. It is an unpredictable,
      // isolated, short-lived DNS A record owned by this acceptance job.
      const hostname = env.REBIND_HOST;
      if (!hostname || !/^cimd-rebind-[a-f0-9]{32}\.aisr\.online$/u.test(hostname)) {
        return new Response("No verified isolated DNS test host", { status: 503 });
      }
      const phase = request.headers.get("x-cimd-dns-phase");
      if (phase !== "before-public" && phase !== "after-private") {
        return new Response("Invalid fixed DNS phase", { status: 400 });
      }
      const target = "https://" + hostname + "/cimd-rebind-check.json";
      let result: Result;
      try {
        const response = await fetch(target, {
          method: "GET", redirect: "manual", signal: AbortSignal.timeout(5000),
          headers: { accept: "application/json", "cache-control": "no-cache" },
        });
        await response.body?.cancel().catch(() => undefined);
        result = { name: phase, outcome: "http", status: response.status };
      } catch (e) {
        result = { name: phase, outcome: "error",
          error: (e instanceof Error ? e.message : String(e)).slice(0, 120) };
      }
      // Never relay remote body or headers. We only inspect the success class.
      return Response.json(result, { headers: { "cache-control": "no-store" } });
    }
    // Exercise exactly the same metadata parsing/fetch helper used in
    // Identity, but as a minimal isolated Worker with the same compatibility
    // date and strictly-public fetch flag.
    const valid = await fetchClientMetadata(clientId);
    const metadataOk = !!valid && valid.clientId === clientId
      && valid.redirectUris.includes("https://oauth-acceptance.example.org/callback");
    // Same-zone front-door test uses a harmless public OAuth discovery route.
    let sameZone: { status: number | null; issuerMatches: boolean } = {
      status: null, issuerMatches: false,
    };
    try {
      const res = await fetch("https://auth-staging.aisr.online/.well-known/oauth-authorization-server", {
        redirect: "manual", signal: AbortSignal.timeout(5000),
      });
      sameZone.status = res.status;
      if (res.status === 200) {
        const body = await res.json() as { issuer?: string };
        sameZone.issuerMatches = body.issuer === "https://auth-staging.aisr.online";
      }
    } catch { /* will be shown as an explicit failed test */ }

    const negatives = await Promise.all(cases.map(check));
    // A transport error (including a TLS/timeout error) demonstrates no
    // observed successful read; it does NOT prove specific IP filtering.
    const noPrivateSuccess = negatives.every(v => v.outcome !== "http"
      || (v.status !== undefined && (v.status < 200 || v.status >= 300)));
    return Response.json({
      fixtureMetadataOk: metadataOk,
      sameZone, negatives, noPrivateSuccess,
      // Accurate scope: no controlled in-flight DNS flip was performed.
      inFlightDnsRebindingProven: false,
    }, { headers: { "cache-control": "no-store" } });
  },
};
