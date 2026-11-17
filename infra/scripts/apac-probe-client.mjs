import {randomUUID} from "node:crypto";
import {safePlacement,safeColo,safeUuid,safeRay,safeRoute,safeTransportCode,safeMs} from "../performance-probe/diagnostic-fields.mjs";
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
  if (!["user", "service", "member"].includes(credentialMode)) {
    throw new Error(`unsupported credentialMode: ${String(credentialMode)}`);
  }
  if (!Number.isInteger(routeAttempts) || routeAttempts < 1) {
    throw new Error("routeAttempts must be a positive integer");
  }

  const observations = [];
  const failures = [];
  const request = async (path, { method = "GET", body } = {}) => {
    const route = safeRoute(path,method.toUpperCase());
    const probeRequestId = randomUUID();
    const fail = (stage,attempt,response,error,detail={}) => {
      const record={credentialMode,route,probeRequestId,stage,attempt,httpStatus:response?.status??null,cfRay:safeRay(response?.headers?.get("cf-ray")),transportCode:error?safeTransportCode(error):null,...detail};
      if(failures.length<100)failures.push(record);
      console.error(JSON.stringify({APAC_PROBE_FAILURE:record}));
      return Error("APAC probe "+stage+(response?" HTTP "+response.status:"")+" ("+(record.transportCode??"see diagnostics")+")");
    };
    for (let attempt = 1; attempt <= routeAttempts; attempt += 1) {
      const start = performance.now();
      let response;
      try {response = await fetchImpl(`${probeUrl}/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lifespace-probe-token": probeToken,
          "x-lifespace-probe-request-id": probeRequestId,
        },
        body: JSON.stringify({ path, method, credentialMode, ...(body === undefined ? {} : { body }) }),
      });} catch(error){throw fail("runner_fetch_failed",attempt,null,error);}

      let text;
      try {text=await response.text();}catch(error){throw fail("runner_response_read_failed",attempt,response,error);}
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
        fail("non_json",attempt,response);
        throw new Error(`APAC probe returned non-JSON ${response.status} after ${attempt} attempt(s)`);
      }

      if (!response.ok) {
        const known=["core_fetch_failed","core_response_read_failed","core_returned_non_json","probe_internal_error","probe_not_configured","not_found","benchmark_request_not_allowed","benchmark_credential_mode_not_allowed"];
        fail("probe_http_error",attempt,response,null,{probeError:known.includes(payload?.error)?payload.error:null,coreCorrelationId:safeUuid(payload?.correlationId)});
        throw new Error(`APAC probe failed ${response.status}`);
      }
      if (!payload || !Number.isInteger(payload.status) || safeMs(payload.elapsedMs)===null) {
        throw fail("invalid_benchmark_result",attempt,response);
      }
      if (payload.credentialMode !== credentialMode) {
        fail("credential_mode_mismatch",attempt,response);
        throw new Error(`APAC probe credential mode mismatch: expected ${credentialMode}`);
      }
      // Diagnostic only: runner-to-probe timing is deliberately excluded from the gate.
      const clientToProbeMs = performance.now() - start;
      observations.push({
        route,
        coreHeadersMs: payload.elapsedMs,
        coreRequestId: safeUuid(payload.coreRequestId),
        probeRequestId,
        coreBodyMs: safeMs(payload.coreResponseBodyMs),
        runnerToProbeMs: clientToProbeMs,
        probeIngressColo: safeColo(payload.probeIngressColo),
        probePlacement: safePlacement(payload.probePlacement),
        corePlacement: safePlacement(payload.corePlacement),
        coreRay: safeRay(payload.coreRay),
        runnerResponsePlacement: safePlacement(response.headers.get("cf-placement")),
      });
      return payload;
    }

    throw new Error("APAC probe route retry loop exhausted unexpectedly");
  };
  // All returned data is route-patterned and numeric, never bearer/request payload.
  request.diagnostics = () => observations.map((sample) => ({ ...sample }));
  request.failures = () => failures.map(sample => ({ ...sample }));
  return request;
}
