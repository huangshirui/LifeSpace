// Staging synthetic fixture retirement, not a user-facing purge capability.
// The caller is the current run's original owner User bearer; the Core
// lifecycle route retains its own live owner/Scope/version checks.
export async function closeCreatedSmokeSpace(input, request, { readClosureEvidence } = {}) {
  if (!input.createdSpaceId) return "no-creation-marker";
  const { coreBase, identityBase, applicationId, spaceId, createdSpaceId,
    ownerId, userBearer, runId, runAttempt } = input;
  const requireMatch = (condition, message) => { if (!condition) throw new Error(message); };
  requireMatch(coreBase === "https://core-staging.aisr.online"
    && identityBase === "https://auth-staging.aisr.online", "canonical staging origins required");
  requireMatch(/^[0-9]+$/u.test(runId || "") && /^[1-9][0-9]*$/u.test(runAttempt || ""),
    "explicit GitHub run and attempt required");
  const suffix = runId + "_" + runAttempt;
  requireMatch(input.purpose === undefined || input.purpose === "eventing", "unknown fixture purpose");
  const expectedName = "LifeSpace staging smoke " + suffix + (input.purpose === "eventing" ? " Eventing" : "");
  if (input.purpose === "eventing") requireMatch(/^spc_[a-f0-9]{32}$/u.test(input.sharedSpaceId || "") && spaceId !== input.sharedSpaceId, "Eventing fixture must differ from shared Space");
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
  // The governed close removes all active authority; a subsequent owner GET
  // correctly returns 403. An unavailable resource is not proof of closure.
  // Only the always-run Eventing fallback may consult exact, read-only audit
  // evidence after the verified current run owner and provenance checks.
  if (input.purpose === "eventing" && [403, 404].includes(detail?.status)) {
    if (typeof readClosureEvidence !== "function") throw new Error("Eventing fixture closure evidence unavailable");
    const error = (await detail.json().catch(()=>null))?.error;
    if (!((detail.status === 403 && error?.code === "FORBIDDEN") ||
          (detail.status === 404 && error?.code === "SPACE_NOT_FOUND"))) {
      throw new Error("Unexpected Eventing Space detail denial");
    }
    const rows = await readClosureEvidence({spaceId, expectedName, ownerId});
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    requireMatch(row?.id === spaceId && row.name === expectedName
      && typeof row.deletedAt === "string" && row.deletedAt.length > 0
      && row.closedAt === row.deletedAt && row.actorUserId === ownerId
      && Number.isSafeInteger(row.version) && row.version >= 2
      && row.closeCount === 1 && row.activeMembers === 0 && row.activeGrants === 0,
      "Eventing fixture closure audit evidence mismatch");
    return "already-closed-verified";
  }
  // Preserve the original shared fixture's non-mutating 404 behavior.
  if (detail?.status === 404) return "already-absent-or-inaccessible";
  const row = detail?.ok ? (await detail.json().catch(()=>null))?.data : null;
  requireMatch(row?.id === spaceId && row.name === expectedName
    && row.access === "owner" && Number.isSafeInteger(row.version) && row.version > 0,
    "current Space provenance or owner mismatch");
  const closed = await request(path + "/close", { method: "POST", body: { version: row.version } });
  requireMatch(closed?.status === 204, "governed Space close did not return HTTP 204");
  return "closed";
}
