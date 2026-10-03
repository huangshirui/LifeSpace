import fs from "node:fs";
import YAML from "yaml";

const document = YAML.parse(fs.readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));
const schemas = document.components?.schemas ?? {};

const principalTypes = schemas.PrincipalType?.enum ?? [];
if (JSON.stringify(principalTypes) !== JSON.stringify(["user", "service", "device", "agent"])) {
  throw new Error("Kernel PrincipalType must expose the accepted user/service/device/agent Entity vocabulary");
}

const granteeTypes = schemas.GranteeType?.enum ?? [];
if (!granteeTypes.includes("agent")) {
  throw new Error("Kernel Data Grant contract must allow Agent grantees");
}

const delegation = schemas.AgentDelegation;
const createDelegation = schemas.CreateAgentDelegationRequest;
const constraints = schemas.AgentDelegationConstraints;
if (!delegation?.required?.includes("principal")
    || !delegation.required.includes("parentDelegationId")
    || !delegation.required.includes("createdBy")
    || !createDelegation?.properties?.parentDelegationId
    || constraints?.properties?.remainingRedelegationDepth?.minimum !== 0
    || constraints?.properties?.remainingRedelegationDepth?.maximum !== 3
    || constraints?.properties?.remainingRedelegationDepth?.default !== 0) {
  throw new Error("Agent Delegation contract must expose Root Principal evidence and bounded parent-chain depth");
}

const principalPropertyTypes = delegation?.properties?.principal?.properties?.type?.enum ?? [];
const issuerTypes = delegation?.properties?.createdBy?.properties?.type?.enum ?? [];
for (const values of [principalPropertyTypes, issuerTypes]) {
  if (!values.includes("agent")) {
    throw new Error("Agent Delegation Principal/issuer evidence must support Agent Entity type");
  }
}

const postDescription = document.paths?.["/api/v1/spaces/{spaceId}/delegations"]?.post?.description ?? "";
if (!postDescription.includes("preserves the Root Principal")
    || !postDescription.includes("Child issuance does not consume a single-use parent")) {
  throw new Error("Agent Delegation contract must document Root Principal preservation and non-consuming Child issuance");
}

console.log("Core Authority v3 contract sanity check passed");
