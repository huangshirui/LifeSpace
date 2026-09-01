import fs from "node:fs";

const root = new URL("../../../", import.meta.url);
const paths = {
  coreCheck: new URL("apps/core/scripts/check-openapi.mjs", root),
  coreAgents: new URL("apps/core/AGENTS.md", root),
  identityAgents: new URL("apps/identity/AGENTS.md", root),
  exportHandoff: new URL("packages/contracts/scripts/export-homemew-handoff.mjs", root),
};
function read(url) { return fs.readFileSync(url, "utf8"); }
function write(url, value) { fs.writeFileSync(url, value); }
function required(value, from, to, label) {
  if (!value.includes(from)) throw new Error(`Missing ${label}`);
  return value.replace(from, to);
}

let coreCheck = read(paths.coreCheck);
coreCheck = required(coreCheck,
  'if (schemas.StatusResponse?.properties?.data?.properties?.contractVersion?.const !== "0.16.0") {',
  'if (schemas.StatusResponse?.properties?.data?.properties?.contractVersion?.const !== "0.17.0") {',
  "Core status contract check",
);
coreCheck = required(coreCheck,
  '  if (path.includes("{modelRoute}") || path.includes("{recordId}") || path.includes("{actionKey}")) {',
  '  if (path.includes("{modelRoute}") || path.includes("{actionKey}")) {',
  "ordinary route template check",
);
write(paths.coreCheck, coreCheck);

let coreAgents = read(paths.coreAgents);
coreAgents = required(coreAgents, 'current Kernel version: 0.16.0', 'current Kernel version: 0.17.0', "Core AGENTS contract version");
coreAgents = required(coreAgents,
  '- Data Grants and current authorization evaluation;\n',
  '- Data Grants, User -> Agent Delegations and current authorization evaluation;\n',
  "Core AGENTS Agent Delegation responsibility",
);
coreAgents = required(coreAgents,
  '- runtime validation, concurrency, soft deletion, relations and business audit;\n',
  '- runtime validation, concurrency, soft deletion, relations, governed Change History and business audit;\n',
  "Core AGENTS Change responsibility",
);
coreAgents = required(coreAgents,
  '∩ current Space membership / Data Grant\n∩ published model access capability',
  '∩ current Space membership / Data Grant\n∩ current User -> Agent Delegation when Actor is an Agent\n∩ published model access capability',
  "Core AGENTS authorization intersection",
);
write(paths.coreAgents, coreAgents);

let identityAgents = read(paths.identityAgents);
identityAgents = identityAgents.replace('current Identity application contract version: `0.5.0`', 'current Identity application contract version: `0.6.0`');
identityAgents = identityAgents.replace('current Application Contract version: `0.5.0`', 'current Application Contract version: `0.6.0`');
write(paths.identityAgents, identityAgents);

// The accepted HomeMew handoff remains pinned to its validated tuple until M4 makes an explicit repin decision.
// Exporting that historical tuple from newer source files would be misleading, so fail with a precise instruction
// rather than pretending the current source OpenAPI equals the older accepted contract.
let exportHandoff = read(paths.exportHandoff);
exportHandoff = required(exportHandoff,
  'if (profile.contracts?.coreKernel !== corePackage.version) throw new Error("HomeMew Core contract pin does not match repository Core version");\nif (profile.contracts?.identity !== identityPackage.version) throw new Error("HomeMew Identity contract pin does not match repository Identity version");',
  'if (profile.contracts?.coreKernel !== corePackage.version || profile.contracts?.identity !== identityPackage.version) {\n  throw new Error(`HomeMew accepted handoff remains pinned to Core ${profile.contracts?.coreKernel} / Identity ${profile.contracts?.identity}, while repository current contracts are Core ${corePackage.version} / Identity ${identityPackage.version}. Do not export newer source OpenAPI under the older accepted tuple; complete an explicit downstream compatibility/staging decision and repin first.`);\n}',
  "HomeMew export pin guard",
);
write(paths.exportHandoff, exportHandoff);

console.log(JSON.stringify({ ok: true }));
