import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

class HandoffError extends Error {
  constructor(message) {
    super(message);
    this.name = "HandoffError";
  }
}

function cliValue(name) {
  const args = process.argv.slice(3);
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new HandoffError(`${name} requires a value`);
  return value;
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (error) {
    throw new HandoffError(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sourceMappings() {
  const raw = process.env.HOMEMEW_WECHAT_IDENTITY_MAPPINGS_JSON ?? "";
  if (!raw.trim()) throw new HandoffError("HOMEMEW_WECHAT_IDENTITY_MAPPINGS_JSON is required");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new HandoffError(`HOMEMEW_WECHAT_IDENTITY_MAPPINGS_JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.data)
      ? parsed.data
      : Array.isArray(parsed?.records)
        ? parsed.records
        : null;
  if (!rows) throw new HandoffError("WeChat identity export must be a JSON array or an object containing data/records array");
  return rows;
}

function validateRows(snapshot, rows) {
  const users = snapshot?.data?.users;
  if (!Array.isArray(users)) throw new HandoffError("Snapshot users are missing");
  const sourceUserIds = new Set(users.map((user) => user.id));
  const rowsByOpenId = new Map();
  const rowsByUserId = new Map();

  for (const row of rows) {
    const openid = typeof row?.openid === "string" ? row.openid.trim() : "";
    const userId = typeof row?.homemewUserId === "string" ? row.homemewUserId.trim() : "";
    if (!openid || !userId) throw new HandoffError("Every WeChat identity row must contain non-empty openid and homemewUserId");
    if (rowsByOpenId.has(openid)) throw new HandoffError("WeChat identity export contains duplicate openid");
    if (rowsByUserId.has(userId)) throw new HandoffError(`WeChat identity export contains duplicate mapping for HomeMew user ${userId}`);
    if (!sourceUserIds.has(userId)) {
      throw new HandoffError(`WeChat identity export references HomeMew user ${userId} that is not in the active migration snapshot`);
    }
    rowsByOpenId.set(openid, { openid, sourceUserId: userId });
    rowsByUserId.set(userId, { openid, sourceUserId: userId });
  }

  const expectedWechatUsers = users
    .filter((user) => user.created_from === "wechat_miniprogram")
    .map((user) => user.id);
  const missing = expectedWechatUsers.filter((userId) => !rowsByUserId.has(userId));
  if (missing.length) {
    throw new HandoffError(`WeChat identity export is missing ${missing.length} active wechat_miniprogram user mapping(s)`);
  }

  return { users, rowsByOpenId, rowsByUserId, expectedWechatUsers };
}

async function validate(snapshotPath) {
  const snapshot = await readJson(snapshotPath, "HomeMew snapshot");
  const rows = sourceMappings();
  const result = validateRows(snapshot, rows);
  console.log(JSON.stringify({
    ok: true,
    activeSourceUsers: result.users.length,
    exportedWechatMappings: result.rowsByOpenId.size,
    requiredWechatUsers: result.expectedWechatUsers.length,
  }));
}

async function build(snapshotPath, reportPath, outPath) {
  const snapshot = await readJson(snapshotPath, "HomeMew snapshot");
  const report = await readJson(reportPath, "LifeSpace migration report");
  if (report?.result !== "PASS" || report?.verification?.result !== "PASS") {
    throw new HandoffError("LifeSpace migration report must be PASS before provider identity handoff");
  }
  const rows = sourceMappings();
  const validated = validateRows(snapshot, rows);
  const userMappings = report?.mappings?.users;
  if (!userMappings || typeof userMappings !== "object" || Array.isArray(userMappings)) {
    throw new HandoffError("Migration report user mappings are missing");
  }

  const output = {};
  for (const { openid, sourceUserId } of validated.rowsByOpenId.values()) {
    const targetUserId = userMappings[sourceUserId];
    if (typeof targetUserId !== "string" || !targetUserId.startsWith("usr_")) {
      throw new HandoffError(`Migration report has no valid LifeSpace user mapping for ${sourceUserId}`);
    }
    output[openid] = targetUserId;
  }

  const absolute = resolve(outPath);
  await writeFile(absolute, `${JSON.stringify(output)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(absolute, 0o600);
  console.log(JSON.stringify({
    ok: true,
    bootstrapMappings: Object.keys(output).length,
    outputWritten: true,
  }));
}

function usage() {
  console.log(`Usage:
  node infra/scripts/phase7-homemew-identities.mjs validate --snapshot <snapshot.json>
  node infra/scripts/phase7-homemew-identities.mjs build --snapshot <snapshot.json> --report <migration-report.json> --out <bootstrap-map.json>

HOMEMEW_WECHAT_IDENTITY_MAPPINGS_JSON must contain the exported legacy identity_mappings collection as a JSON array, or an object with a data/records array. Raw openids are never printed by this script.`);
}

async function main() {
  const command = process.argv[2];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }
  const snapshot = cliValue("--snapshot");
  if (!snapshot) throw new HandoffError("--snapshot is required");
  if (command === "validate") {
    await validate(snapshot);
    return;
  }
  if (command === "build") {
    const report = cliValue("--report");
    const out = cliValue("--out");
    if (!report || !out) throw new HandoffError("build requires --report and --out");
    await build(snapshot, report, out);
    return;
  }
  throw new HandoffError(`Unknown command ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
