import type { Bindings, Principal } from "./env";
import type { GenericResource } from "./generic-resource";
import { ApiError } from "./http";
import type { ModelPoliciesDefinition, PolicyExpression, PolicyOperand } from "./policy-definition";
import type { PublishedModel } from "./model-registry";

export type PolicyContext = {
  actor: {
    type: Principal["type"];
    id: string;
    personId: string | null;
  };
  record?: Record<string, unknown>;
  input?: Record<string, unknown>;
};

export async function resolvePolicyContext(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  record?: GenericResource | Record<string, unknown>,
  input?: Record<string, unknown>,
): Promise<PolicyContext> {
  let personId: string | null = null;
  if (principal.type === "user") {
    const person = await env.DB.prepare(`SELECT id FROM space_people
      WHERE space_id=? AND linked_user_id=? AND deleted_at IS NULL LIMIT 1`)
      .bind(spaceId, principal.id).first<{ id: string }>();
    personId = person?.id ?? null;
  }
  const recordData = record && "data" in record && typeof record.data === "object"
    ? (record as GenericResource).data
    : record as Record<string, unknown> | undefined;
  return {
    actor: { type: principal.type, id: principal.id, personId },
    ...(recordData ? { record: recordData } : {}),
    ...(input ? { input } : {}),
  };
}

function operandValue(operand: PolicyOperand, context: PolicyContext): unknown {
  if ("value" in operand) return operand.value;
  const reference = operand.$ref;
  if (reference === "actor.type") return context.actor.type;
  if (reference === "actor.id") return context.actor.id;
  if (reference === "actor.personId") return context.actor.personId;
  if (reference.startsWith("record.")) return context.record?.[reference.slice("record.".length)] ?? null;
  if (reference.startsWith("input.")) return context.input?.[reference.slice("input.".length)] ?? null;
  return null;
}

export function evaluatePolicyExpression(policy: PolicyExpression, context: PolicyContext): boolean {
  if ("op" in policy) {
    const left = operandValue(policy.left, context);
    const right = operandValue(policy.right, context);
    return policy.op === "eq" ? left === right : left !== right;
  }
  if ("all" in policy) return policy.all.every((entry) => evaluatePolicyExpression(entry, context));
  if ("any" in policy) return policy.any.some((entry) => evaluatePolicyExpression(entry, context));
  return !evaluatePolicyExpression(policy.not, context);
}

function modelPolicy(model: PublishedModel, operation: keyof ModelPoliciesDefinition): PolicyExpression | undefined {
  return model.definition.policies?.[operation];
}

export async function requireModelPolicy(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: PublishedModel,
  operation: keyof ModelPoliciesDefinition,
  record?: GenericResource,
  input?: Record<string, unknown>,
): Promise<PolicyContext> {
  const context = await resolvePolicyContext(env, principal, spaceId, record, input);
  const policy = modelPolicy(model, operation);
  if (policy && !evaluatePolicyExpression(policy, context)) {
    throw new ApiError("POLICY_DENIED", `Model ${model.key} ${operation} policy denied this operation`, 403);
  }
  return context;
}

export async function requirePolicyExpression(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  policy: PolicyExpression | undefined,
  record?: GenericResource,
  input?: Record<string, unknown>,
): Promise<PolicyContext> {
  const context = await resolvePolicyContext(env, principal, spaceId, record, input);
  if (policy && !evaluatePolicyExpression(policy, context)) {
    throw new ApiError("POLICY_DENIED", "Record policy denied this operation", 403);
  }
  return context;
}
