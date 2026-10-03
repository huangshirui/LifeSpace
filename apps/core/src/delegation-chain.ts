import type { Permission } from "./authorization";
import type { ActorType, Bindings, Principal, PrincipalType } from "./env";
import { ApiError } from "./http";

export type DelegationTargetType = "space" | "model" | "record";

export type DelegationChainRow = {
  delegation_id: string;
  parent_delegation_id: string | null;
  remaining_redelegation_depth: number;
  principal_type: PrincipalType;
  principal_id: string;
  actor_type: ActorType;
  actor_id: string;
  application_id: string;
  source_space_id: string;
  created_by_type: ActorType;
  created_by_id: string;
  delegation_revoked_at: string | null;
  delegation_expires_at: string | null;
  delegation_max_uses: number | null;
  delegation_consumed_at: string | null;
  delegation_target_type: DelegationTargetType;
  delegation_target_id: string;
  delegation_target_model_key: string | null;
  delegation_max_access: Permission;
  selected_leaf: number;
};

const permissionRank: Record<Permission, number> = {
  free_busy: 1,
  read: 2,
  write: 3,
  manage: 4,
};

function executionActor(principal: Principal) {
  return principal.actor ?? { type: principal.type, id: principal.id };
}

export function delegationChainStatement(
  env: Bindings,
  delegationIds: readonly string[],
): D1PreparedStatement {
  if (!delegationIds.length) {
    throw new Error("Delegation chain query requires at least one leaf");
  }
  const placeholders = delegationIds.map(() => "?").join(",");
  return env.DB.prepare(`
    WITH RECURSIVE chain(delegation_id) AS (
      SELECT d.id
      FROM delegations d
      WHERE d.id IN (${placeholders})
      UNION
      SELECT p.id
      FROM chain c
      JOIN delegations d ON d.id=c.delegation_id
      JOIN delegations p ON p.id=d.parent_delegation_id
      WHERE p.remaining_redelegation_depth > d.remaining_redelegation_depth
        AND p.remaining_redelegation_depth <= 3
    )
    SELECT
      d.id AS delegation_id,
      d.parent_delegation_id,
      d.remaining_redelegation_depth,
      d.principal_type,
      d.principal_id,
      d.actor_type,
      d.actor_id,
      d.application_id,
      d.source_space_id,
      d.created_by_type,
      d.created_by_id,
      d.revoked_at AS delegation_revoked_at,
      d.expires_at AS delegation_expires_at,
      d.max_uses AS delegation_max_uses,
      d.consumed_at AS delegation_consumed_at,
      ds.target_type AS delegation_target_type,
      ds.target_id AS delegation_target_id,
      ds.target_model_key AS delegation_target_model_key,
      ds.max_access AS delegation_max_access,
      CASE WHEN d.id IN (${placeholders}) THEN 1 ELSE 0 END AS selected_leaf
    FROM chain c
    JOIN delegations d ON d.id=c.delegation_id
    JOIN delegation_scopes ds ON ds.delegation_id=d.id
    ORDER BY d.id
  `).bind(...delegationIds, ...delegationIds);
}

export function delegationCurrent(row: DelegationChainRow | null): boolean {
  if (!row || row.delegation_revoked_at || row.delegation_consumed_at) return false;
  if (!row.delegation_expires_at) return true;
  return Date.parse(row.delegation_expires_at) > Date.now();
}

export function delegationScopeContains(
  parent: DelegationChainRow,
  child: Pick<
    DelegationChainRow,
    "delegation_target_type" | "delegation_target_id" | "delegation_target_model_key" | "delegation_max_access" | "source_space_id"
  >,
): boolean {
  if (permissionRank[parent.delegation_max_access] < permissionRank[child.delegation_max_access]) return false;
  if (parent.delegation_target_type === "space") {
    return parent.delegation_target_id === parent.source_space_id
      && child.source_space_id === parent.source_space_id;
  }
  if (parent.delegation_target_type === "model") {
    if (child.delegation_target_type === "model") {
      return child.delegation_target_id === parent.delegation_target_id;
    }
    return child.delegation_target_type === "record"
      && child.delegation_target_model_key === parent.delegation_target_id;
  }
  return child.delegation_target_type === "record"
    && child.delegation_target_id === parent.delegation_target_id
    && child.delegation_target_model_key === parent.delegation_target_model_key;
}

export function delegationExpiryNarrows(
  parentExpiresAt: string | null,
  childExpiresAt: string | null,
): boolean {
  if (!parentExpiresAt) return true;
  if (!childExpiresAt) return false;
  return Date.parse(childExpiresAt) <= Date.parse(parentExpiresAt);
}

function chainFromRows(
  rows: readonly DelegationChainRow[],
  leafDelegationId: string,
): DelegationChainRow[] {
  const byId = new Map(rows.map((row) => [row.delegation_id, row]));
  const chain: DelegationChainRow[] = [];
  const seen = new Set<string>();
  let currentId: string | null = leafDelegationId;

  while (currentId) {
    const row = byId.get(currentId);
    if (!row) break;
    chain.push(row);
    if (seen.has(currentId)) break;
    seen.add(currentId);
    if (chain.length > 4) break;
    currentId = row.parent_delegation_id;
  }

  return chain;
}

export function validateStructuralDelegationChain(
  principal: Principal,
  spaceId: string,
  leafDelegationId: string,
  rows: readonly DelegationChainRow[],
): DelegationChainRow[] {
  const orderedLeafToRoot = chainFromRows(rows, leafDelegationId);
  if (!orderedLeafToRoot.length) {
    throw new ApiError("DELEGATION_INVALID", "Delegation chain was not found", 403);
  }
  if (orderedLeafToRoot.length > 4) {
    throw new ApiError("DELEGATION_INVALID", "Delegation chain exceeds the supported depth", 403);
  }

  const leaf = orderedLeafToRoot[0]!;
  const actor = executionActor(principal);
  if (
    leaf.delegation_id !== leafDelegationId
    || leaf.principal_type !== principal.type
    || leaf.principal_id !== principal.id
    || leaf.actor_type !== actor.type
    || leaf.actor_id !== actor.id
    || leaf.application_id !== principal.clientId
    || leaf.source_space_id !== spaceId
  ) {
    throw new ApiError("DELEGATION_INVALID", "Leaf Delegation does not match the verified Execution Context", 403);
  }

  if (new Set(orderedLeafToRoot.map((row) => row.delegation_id)).size !== orderedLeafToRoot.length) {
    throw new ApiError("DELEGATION_INVALID", "Delegation chain contains a cycle", 403);
  }

  for (let index = 0; index < orderedLeafToRoot.length; index += 1) {
    const row = orderedLeafToRoot[index]!;
    if (
      row.principal_type !== principal.type
      || row.principal_id !== principal.id
      || row.application_id !== principal.clientId
      || row.source_space_id !== spaceId
      || !delegationCurrent(row)
    ) {
      throw new ApiError(
        "DELEGATION_INVALID",
        "Delegation chain is revoked, expired, consumed or outside the verified Execution Context",
        403,
      );
    }

    const parent = orderedLeafToRoot[index + 1];
    if (!parent) {
      if (row.parent_delegation_id !== null) {
        throw new ApiError("DELEGATION_INVALID", "Delegation chain exceeds the supported depth or has a missing parent", 403);
      }
      continue;
    }

    if (
      row.parent_delegation_id !== parent.delegation_id
      || row.created_by_type !== parent.actor_type
      || row.created_by_id !== parent.actor_id
      || parent.remaining_redelegation_depth <= 0
      || row.remaining_redelegation_depth >= parent.remaining_redelegation_depth
      || !delegationScopeContains(parent, row)
      || !delegationExpiryNarrows(parent.delegation_expires_at, row.delegation_expires_at)
    ) {
      throw new ApiError("DELEGATION_INVALID", "Delegation chain violates bounded re-delegation invariants", 403);
    }
  }

  return orderedLeafToRoot.reverse();
}

export function groupDelegationChainRows(
  rows: readonly DelegationChainRow[],
): Map<string, DelegationChainRow[]> {
  const result = new Map<string, DelegationChainRow[]>();
  for (const row of rows) {
    if (row.selected_leaf === 1) {
      result.set(row.delegation_id, chainFromRows(rows, row.delegation_id));
    }
  }
  return result;
}
