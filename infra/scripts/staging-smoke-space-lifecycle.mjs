// Staging synthetic fixture retirement, not a user-facing purge capability.
// The caller is the current run's original owner User bearer; the Core
// lifecycle route retains its own live owner/Scope/version checks.
export async function closeCreatedSmokeSpace(input, request) {
  if (!input.createdSpaceId) return "no-creation-marker";
  const { coreBase, identityBase, applicationId, spaceId, createdSpaceId,
    ownerId, userBearer, runId, runAttempt } = input;
  const requireMatch = (condition, message) => { if (!condition) throw new Error(message); };
  requireMatch(coreBase === "https://core-staging.aisr.online"
    && identityBase === "https://auth-staging.aisr.online", "canonical staging origins required");
  requireMatch(/^[0-9]+$/u.test(runId || "") && /^[1-9][0-9]*$/u.test(runAttempt || ""),
    "explicit GitHub run and attempt required");
  const suffix = runId + "_" + runAttempt;
  requireMatch(applicationId === "app_staging_smoke_" + suffix
    && /^spc_[a-f0-9]{32}$/u.test(spaceId || "") && spaceId === createdSpaceId
    && /^usr_[A-Za-z0-9_-]+$/u.test(ownerId || "") && typeof userBearer === "string" && userBearer.length > 0,
    "run-owned fixture provenance mismatch");
  const me = await request("/api/v1/me");
  const principal = me?.ok ? (await me.json().catch(()=>null))?.data?.principal : null;
  requireMatch(principal?.type === "user" && principal.id === ownerId
    && principal.clientId === applicationId, "run owner credential mismatch");
  const path = "/api/v1/spaces/" + spaceId;
  const detail = await request(path);
  // 404 can be an already retired Space, but may also mean it is unavailable.
  // In either case fail closed: no additional lifecycle mutation is attempted.
  if (detail?.status === 404) return "already-absent-or-inaccessible";
  const row = detail?.ok ? (await detail.json().catch(()=>null))?.data : null;
  requireMatch(row?.id === spaceId && row.name === "LifeSpace staging smoke " + suffix
    && row.access === "owner" && Number.isSafeInteger(row.version) && row.version > 0,
    "current Space provenance or owner mismatch");
  const closed = await request(path + "/close", { method: "POST", body: { version: row.version } });
  requireMatch(closed?.status === 204, "governed Space close did not return HTTP 204");
  return "closed";
}
