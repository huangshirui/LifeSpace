import { pathToFileURL } from "node:url";
import process from "node:process";
import { ACCOUNT_APPLICATION_ID } from "./prepare-staging-identity.mjs";

const APP_PATH = "/bootstrap/v1/applications/" + encodeURIComponent(ACCOUNT_APPLICATION_ID);

export function validateRotationState(entries, currentId, oldIds) {
  if (!Array.isArray(entries) || typeof currentId !== "string" || !/^apc_[A-Za-z0-9_-]+$/u.test(currentId)
    || !Array.isArray(oldIds) || new Set(oldIds).size !== oldIds.length
    || oldIds.some((id) => !/^apc_[A-Za-z0-9_-]+$/u.test(id) || id === currentId)) {
    throw new Error("Account credential rotation metadata is malformed");
  }
  const active = entries.filter((entry) => entry?.status === "active" && entry.revokedAt == null);
  if (active.filter((entry) => entry.id === currentId).length !== 1
    || active.some((entry) => entry.id !== currentId && !oldIds.includes(entry.id))) {
    throw new Error("Account credential state changed outside this staging release; refusing blind revocation");
  }
  return active.filter((entry) => entry.id !== currentId).map((entry) => entry.id);
}

export async function verifyAndCleanupStagingCredential({ env = process.env, fetcher = fetch } = {}) {
  const base = "https://auth-staging.aisr.online";
  const secret = env.LIFESPACE_STAGING_BOOTSTRAP_SECRET ?? "";
  const lsa = env.LIFESPACE_STAGING_ACCOUNT_APPLICATION_CREDENTIAL ?? "";
  const currentId = env.LIFESPACE_STAGING_ACCOUNT_CURRENT_CREDENTIAL_ID ?? "";
  const oldIds = (env.LIFESPACE_STAGING_ACCOUNT_OLD_CREDENTIAL_IDS ?? "").split(",").filter(Boolean);
  if (secret.length < 32 || !/^lsa_[A-Za-z0-9_-]{30,}$/u.test(lsa)) {
    throw new Error("Staging bootstrap and newly issued Account credential are both required");
  }

  async function metadata() {
    const res = await fetcher(base + APP_PATH + "/credentials", {
      headers: { accept: "application/json", "x-bootstrap-secret": secret },
    });
    const result = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(result?.data)) throw new Error("Account credential inventory unavailable");
    return result.data;
  }

  // Validate the new key with Identity itself before revoking any previous key.
  const probe = await fetcher(base + "/internal/v1/applications/self", {
    headers: { accept: "application/json", authorization: "Bearer " + lsa },
  });
  const identity = await probe.json().catch(() => null);
  if (!probe.ok || identity?.data?.id !== ACCOUNT_APPLICATION_ID || identity?.data?.status !== "active") {
    throw new Error("Newly installed Account credential failed Identity self-inspection; old keys are preserved");
  }

  const activeOld = validateRotationState(await metadata(), currentId, oldIds);
  for (const id of activeOld) {
    const res = await fetcher(base + APP_PATH + "/credentials/" + encodeURIComponent(id), {
      method: "DELETE",
      headers: { "x-bootstrap-secret": secret },
    });
    if (res.status !== 204 && res.status !== 404) {
      throw new Error("Could not revoke a superseded Account application credential");
    }
  }
  const final = validateRotationState(await metadata(), currentId, oldIds);
  if (final.length !== 0) throw new Error("Superseded Account credentials remain active after revocation");
  return { ok: true, applicationId: ACCOUNT_APPLICATION_ID, verifiedCurrentCredential: true,
    revokedCredentialCount: activeOld.length, remainingActiveCredentials: 1, plaintextLogged: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyAndCleanupStagingCredential();
  console.log(JSON.stringify(result, null, 2));
}
