import type { ModelAccess } from "./model-definition";
import type { SpaceRole } from "./authorization";

export type ModelAccessCeiling = "none" | ModelAccess;
const ceilingRank: Record<ModelAccessCeiling, number> = { none: 0, read: 1, write: 2, manage: 3 };

/** Only constrains existing authority; never grants access. Owner is trusted V1.
 *  Caller supplies current root membership and the current sparse ceiling snapshot. */
export function modelAccessWithinCeiling(
  membershipRole: SpaceRole | null,
  ceiling: ModelAccessCeiling | null,
  required: ModelAccess,
): boolean {
  return membershipRole === "owner" || ceiling === null
    || ceilingRank[ceiling] >= ceilingRank[required];
}
