export const ENTITY_ROLE_CAPABILITIES = {
  user: {
    canBePrincipal: true,
    canBeActor: true,
    canDelegateOwnAuthority: true,
    canReceiveDelegation: false,
    authoritySources: ["membership", "dataGrant"],
  },
  service: {
    canBePrincipal: true,
    canBeActor: true,
    canDelegateOwnAuthority: false,
    canReceiveDelegation: false,
    authoritySources: ["dataGrant"],
  },
  device: {
    canBePrincipal: true,
    canBeActor: true,
    canDelegateOwnAuthority: false,
    canReceiveDelegation: false,
    authoritySources: ["dataGrant"],
  },
  agent: {
    canBePrincipal: true,
    canBeActor: true,
    canDelegateOwnAuthority: true,
    canReceiveDelegation: true,
    authoritySources: ["dataGrant"],
  },
} as const;

export type EntityType = keyof typeof ENTITY_ROLE_CAPABILITIES;
export type AuthoritySource = "membership" | "dataGrant";

export function isEntityType(value: unknown): value is EntityType {
  return typeof value === "string"
    && Object.prototype.hasOwnProperty.call(ENTITY_ROLE_CAPABILITIES, value);
}

export function canBePrincipal(value: unknown): value is EntityType {
  return isEntityType(value) && ENTITY_ROLE_CAPABILITIES[value].canBePrincipal;
}

export function canBeActor(value: unknown): value is EntityType {
  return isEntityType(value) && ENTITY_ROLE_CAPABILITIES[value].canBeActor;
}

export function canDelegateOwnAuthority(value: EntityType): boolean {
  return ENTITY_ROLE_CAPABILITIES[value].canDelegateOwnAuthority;
}

export function canReceiveDelegation(value: EntityType): boolean {
  return ENTITY_ROLE_CAPABILITIES[value].canReceiveDelegation;
}
