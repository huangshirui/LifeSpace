import fs from "node:fs/promises";

const file = "infra/scripts/initialize-staging-runtime.mjs";
let source = await fs.readFile(file, "utf8");

function replaceOnce(before, after) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Patch target missing: ${before.slice(0, 120)}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`Patch target is not unique: ${before.slice(0, 120)}`);
  source = source.slice(0, first) + after + source.slice(first + before.length);
}

replaceOnce(
  `// Identity 0.2 adds user-token verification at the Identity resource server.\n// Rotate the staging-only pair once per staging deployment so Identity and Core\n// are guaranteed to share the same active public key before profile smoke tests.\nawait rotateSigningKeys();\n`,
  `// Preserve the active staging signing pair across normal deployments. Wrangler secret\n// updates create and immediately deploy a new Worker version, so rotating signing keys\n// during every smoke run introduces an avoidable verification convergence window. The\n// repair path below still creates a pair when staging is fresh or the pair is mismatched.\n`,
);

replaceOnce("    accessTokenTtlSeconds: 300,\n", "    accessTokenTtlSeconds: 3600,\n");
replaceOnce("let rotatedSigningKeys = true;\n", "let rotatedSigningKeys = false;\n");

replaceOnce(
  `  tokenProbe = await issueToken(clientSecret, userId, scopes);\n  accessToken = tokenProbe.payload?.data?.accessToken;\n  if (tokenProbe.response.status !== 200 || !accessToken) {\n    throw new Error(\`Identity token issuance failed after signing-key repair: \${tokenProbe.response.status} \${JSON.stringify(tokenProbe.payload)}\`);\n  }\n\n  coreProbe = await probeCore(accessToken);\n`,
  `  let repaired = false;\n  for (let attempt = 1; attempt <= 12; attempt += 1) {\n    tokenProbe = await issueToken(clientSecret, userId, scopes);\n    accessToken = tokenProbe.payload?.data?.accessToken;\n    coreProbe = accessToken ? await probeCore(accessToken) : null;\n    const identityProbe = accessToken\n      ? await fetchJson(\`\${identityBase}/api/v1/me\`, { headers: { authorization: \`Bearer \${accessToken}\` } })\n      : null;\n    if (tokenProbe.response.status === 200 && accessToken && coreProbe?.response.status === 200 && identityProbe?.response.status === 200) {\n      repaired = true;\n      console.log(\`Staging signing-key repair converged after \${attempt} probe(s)\`);\n      break;\n    }\n    console.log(\`Waiting for repaired signing keys to converge (attempt \${attempt}/12): identity token=\${tokenProbe.response.status}, identity verify=\${identityProbe?.response.status ?? "n/a"}, core verify=\${coreProbe?.response.status ?? "n/a"}\`);\n    await new Promise((resolve) => setTimeout(resolve, 5000));\n  }\n  if (!repaired) {\n    throw new Error(\`Staging signing-key repair did not converge: token=\${tokenProbe.response.status} \${JSON.stringify(tokenProbe.payload)}, core=\${coreProbe?.response.status ?? "n/a"} \${JSON.stringify(coreProbe?.payload)}\`);\n  }\n`,
);

await fs.writeFile(file, source);
console.log("Staging auth smoke stabilized: persistent signing keys, 1h smoke token, convergent repair probe");
