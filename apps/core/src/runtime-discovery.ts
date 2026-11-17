import type { RecurrenceCapabilityDefinition } from "./recurrence-definition";
import { recurrenceRuleSchema } from "./recurrence-rule";
import { entityRefSchema } from "./entity-ref";
import { projectVisibleExternalModels, visibleExternalModels } from "./external-runtime";
import { hydrateExternalModelList, prepareExternalModelList, type ExternalModelListRow } from "./external-model";
import { readAuthorityBatch } from "./model-authorization";
import { authorityD1Observer, measurePerformancePhase } from "./performance-timing";
import type { Context, Hono } from "hono";
import type { Permission, SpaceRole } from "./authorization";
import { capabilityActionAccess } from "./capability-runtime";
import type { CalendarCapabilityDefinition, CheckInCapabilityDefinition } from "./capability-definition";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";
import type { ModelAccess } from "./model-definition";
import { modelAccessWithinCeiling, type ModelAccessCeiling } from "./model-access-ceiling";
import { listPublishedModels, type PublishedModel } from "./model-registry";
import { projectModelSemanticFacts } from "./model-semantic-projection";
import { referenceLabelSemantic } from "./reference-label";
import { relationDiscoveryMetadata } from "./relation-targets";
import { semanticRelationDiscovery, SEMANTIC_RELATION_RUNTIME } from "./semantic-relation-definition";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type AppContext = Context<AppEnv>;

type CatalogRow = { model_key: string; max_access: ModelAccess };
type MembershipRow = { role: SpaceRole };
type SpaceDiscoveryRow = { id: string; name: string; role?: SpaceRole | null; model_key?: string | null; max_access?: ModelAccessCeiling | null };
type CeilingRow = { model_key: string; max_access: ModelAccessCeiling };
type SpaceCeilingRow = CeilingRow & { space_id: string };
type MembershipAccessRow = MembershipRow & { space_id: string; space_name: string };
type GrantRow = { resource_type: "space" | "model"; resource_id: string | null; permission: Permission };
type GrantAccessRow = GrantRow & { source_space_id: string; space_name: string };
type DelegationAccessRow = {
  target_type: "space" | "model" | "record";
  target_id: string;
  target_model_key: string | null;
  max_access: Permission;
};
type DelegationSpaceAccessRow = DelegationAccessRow & { source_space_id: string };

type DiscoveryActionInputField = {
  key: string;
  type: "string" | "text" | "integer" | "number" | "boolean" | "date" | "instant" | "range<date>" | "range<instant>" | "temporal_range" | "recurrence_rule" | "entity_ref" | "timezone" | "enum" | "person" | "person_list" | "record" | "record_list";
  title?: string;
  description?: string;
  required?: boolean;
  nullable?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  values?: string[];
};

type DiscoveryActionConcurrency = {
  strategy: "record-version";
  required: true;
  transport: { in: "body"; name: "version" };
};

type DiscoveryAction = {
  key: string;
  access: ModelAccess;
  kind: "workflow" | "capability";
  input: { fields: DiscoveryActionInputField[] };
  concurrency: DiscoveryActionConcurrency;
};

type DiscoveryCalendarCapabilityBinding = CalendarCapabilityDefinition;

type DiscoveryCapabilityBindings = {
  recurrence?: RecurrenceCapabilityDefinition;
  calendar?: DiscoveryCalendarCapabilityBinding;
  checkIn?: CheckInCapabilityDefinition;
};

type VisibleModel = { model: PublishedModel; access: ModelAccess[] };
type AggregateDiscoveryState = {
  principal: Principal;
  models: PublishedModel[];
  catalogByModel: Map<string, ModelAccess>;
  membershipsBySpace: Map<string, MembershipRow>;
  spaceNamesById: Map<string, string>;
  grantsBySpace: Map<string, GrantRow[]>;
  ceilingsBySpace: Map<string, Map<string, ModelAccessCeiling>>;
  delegatedAgent: boolean;
  delegatedBySpace: Map<string, Map<string, ModelAccess>>;
  candidateSpaceIds: string[];
};

const accessRank: Record<ModelAccess, number> = { read: 1, write: 2, manage: 3 };
const permissionRank: Record<Permission, number> = { free_busy: 0, read: 1, write: 2, manage: 3 };
const roleRank: Record<SpaceRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 3 };
const scopeForAccess: Record<ModelAccess, string> = {
  read: "resources:read",
  write: "resources:write",
  manage: "resources:manage",
};
const accessOrder: ModelAccess[] = ["read", "write", "manage"];
const semanticDetailPathTemplate = "/api/v1/spaces/{spaceId}/_discovery/models/{modelKey}" as const;
const recordVersionConcurrency: DiscoveryActionConcurrency = {
  strategy: "record-version",
  required: true,
  transport: { in: "body", name: "version" },
};

function actionConcurrency(): DiscoveryActionConcurrency {
  return structuredClone(recordVersionConcurrency);
}

function spaceAuthorityRank(principal: Principal, membership: MembershipRow | null, grants: GrantRow[], modelKey: string): number {
  const membershipLevel = principal.type === "user" && membership ? roleRank[membership.role] : 0;
  const grantLevel = grants.reduce((highest, grant) => {
    const targetsModel = grant.resource_type === "space"
      || (grant.resource_type === "model" && grant.resource_id === modelKey);
    return targetsModel ? Math.max(highest, permissionRank[grant.permission]) : highest;
  }, 0);
  return Math.max(membershipLevel, grantLevel);
}

function effectiveAccess(
  principal: Principal,
  model: PublishedModel,
  catalogAccess: ModelAccess,
  authorityRank: number,
  delegationAccess?: ModelAccess | null,
): ModelAccess[] {
  return accessOrder.filter((access) => model.definition.access.includes(access)
    && principal.scopes.includes(scopeForAccess[access])
    && accessRank[catalogAccess] >= accessRank[access]
    && authorityRank >= accessRank[access]
    && (delegationAccess === undefined || (delegationAccess !== null && accessRank[delegationAccess] >= accessRank[access])));
}

function actions(model: PublishedModel, allowed: ModelAccess[]): DiscoveryAction[] {
  const allowedSet = new Set(allowed);
  const result: DiscoveryAction[] = Object.entries(model.definition.actions ?? {})
    .filter(([, action]) => allowedSet.has(action.access))
    .map(([key, action]) => ({
      key,
      access: action.access,
      kind: "workflow" as const,
      input: { fields: [] },
      concurrency: actionConcurrency(),
    }));

  if (capabilityActionAccess(model, "record-occurrence") === "write" && allowedSet.has("write")) {
    result.push({
      key: "record-occurrence",
      access: "write",
      kind: "capability",
      input: {
        fields: [
          {
            key: "occurredOn",
            type: "date",
            title: "Occurrence Date",
            required: true,
            description: "Occurrence date in YYYY-MM-DD form. Runtime rules still validate it against the current anchor and Space date.",
          },
          {
            key: "note",
            type: "text",
            title: "Note",
            nullable: true,
            maxLength: 1000,
            description: "Optional occurrence note.",
          },
        ],
      },
      concurrency: actionConcurrency(),
    });
  }

  if (capabilityActionAccess(model, "check-in") === "write" && allowedSet.has("write")) {
    result.push({ key: "check-in", access: "write", kind: "capability",
      input: { fields: [] }, concurrency: actionConcurrency() });
  }
  return result.sort((left, right) => left.key.localeCompare(right.key));
}

function capabilityBindings(model: PublishedModel): DiscoveryCapabilityBindings {
  const calendar = model.definition.capabilities?.calendar;
  const recurrence = model.definition.capabilities?.recurrence;
  const checkIn = model.definition.capabilities?.checkIn;
  return {
    ...(calendar ? { calendar: structuredClone(calendar) } : {}),
    ...(recurrence ? { recurrence: structuredClone(recurrence) } : {}),
    ...(checkIn ? { checkIn: structuredClone(checkIn) } : {}),
  };
}

function dto(model: PublishedModel, allowed: ModelAccess[]) {
  return {
    key: model.key,
    version: model.version,
    schemaHash: model.schemaHash,
    display: model.definition.display,
    description: model.definition.description ?? null,
    referenceLabel: referenceLabelSemantic(model.definition),
    access: allowed,
    fields: Object.entries(model.definition.fields).map(([key, field]) => {
      const relation = relationDiscoveryMetadata(field);
      return { key, ...field, ...(field.type === "recurrence_rule" ? { valueSchema: recurrenceRuleSchema() } : field.type === "entity_ref" ? { valueSchema: entityRefSchema() } : {}), ...(relation ? { relation } : {}) };
    }),
    semanticRelations: semanticRelationDiscovery(model.key, model.definition.semanticRelations),
    semanticRelationRuntime: SEMANTIC_RELATION_RUNTIME,
    defaults: structuredClone(model.definition.defaults ?? {}),
    query: {
      searchable: [...(model.definition.query?.searchable ?? [])],
      filterable: [...(model.definition.query?.filterable ?? [])],
      sortable: [...(model.definition.query?.sortable ?? [])],
      sort: {
        parameter: "sort" as const,
        syntax: "field:direction" as const,
        repeatable: true as const,
        ordered: true as const,
        maxCriteria: 8,
        default: ["createdAt:desc"] as const,
        envelopeFields: ["createdAt", "updatedAt"] as const,
      },
    },
    actions: actions(model, allowed),
    capabilityBindings: capabilityBindings(model),
    capabilities: Object.keys(model.definition.capabilities ?? {}).sort(),
  };
}

export function visibleModelAccess(
  principal: Principal,
  models: PublishedModel[],
  catalogByModel: Map<string, ModelAccess>,
  membership: MembershipRow | null,
  grants: GrantRow[],
  delegatedByModel?: Map<string, ModelAccess>,
  ceilingsByModel?: ReadonlyMap<string, ModelAccessCeiling>,
): VisibleModel[] {
  return models.flatMap((model) => {
    if (model.definition.origin === "external") return [];
    const catalogAccess = catalogByModel.get(model.key);
    if (!catalogAccess) return [];
    const allowed = effectiveAccess(
      principal,
      model,
      catalogAccess,
      spaceAuthorityRank(principal, membership, grants, model.key),
      delegatedByModel === undefined ? undefined : (delegatedByModel.get(model.key) ?? null),
    ).filter(access => modelAccessWithinCeiling(membership?.role ?? null, ceilingsByModel?.get(model.key) ?? null, access));
    return allowed.length ? [{ model, access: allowed }] : [];
  });
}

function visibleModels(
  principal: Principal,
  models: PublishedModel[],
  catalogByModel: Map<string, ModelAccess>,
  membership: MembershipRow | null,
  grants: GrantRow[],
  delegatedByModel?: Map<string, ModelAccess>,
  ceilingsByModel?: ReadonlyMap<string, ModelAccessCeiling>,
) {
  return visibleModelAccess(principal, models, catalogByModel, membership, grants, delegatedByModel, ceilingsByModel)
    .map(({ model, access }) => dto(model, access));
}

function inventoryModel(model: PublishedModel) {
  const semantic = projectModelSemanticFacts(model);
  return {
    key: semantic.key,
    version: semantic.version,
    schemaHash: semantic.schemaHash,
    display: semantic.display,
    capabilities: semantic.capabilities,
    actions: semantic.actions.map(({ key, access, kind }) => ({ key, access, kind })),
  };
}

function pushGrant(grantsBySpace: Map<string, GrantRow[]>, row: GrantAccessRow): void {
  const grants = grantsBySpace.get(row.source_space_id) ?? [];
  grants.push({ resource_type: row.resource_type, resource_id: row.resource_id, permission: row.permission });
  grantsBySpace.set(row.source_space_id, grants);
}

function delegationModelAccess(value: Permission): ModelAccess | null {
  return value === "read" || value === "write" || value === "manage" ? value : null;
}

function pushDelegation(
  delegatedBySpace: Map<string, Map<string, ModelAccess>>,
  row: DelegationSpaceAccessRow,
  modelKeys: readonly string[],
): void {
  const access = delegationModelAccess(row.max_access);
  if (!access || row.target_type === "record") return;
  const delegatedByModel = delegatedBySpace.get(row.source_space_id) ?? new Map<string, ModelAccess>();
  const targets = row.target_type === "space" ? modelKeys : [row.target_id];
  for (const modelKey of targets) {
    const current = delegatedByModel.get(modelKey);
    if (!current || accessRank[access] > accessRank[current]) delegatedByModel.set(modelKey, access);
  }
  delegatedBySpace.set(row.source_space_id, delegatedByModel);
}

async function aggregateDiscoveryState(context: AppContext): Promise<AggregateDiscoveryState> {
  const principal = context.get("principal");
  const statements: D1PreparedStatement[] = [
    context.env.DB.prepare(`SELECT model_key,max_access FROM application_model_access
      WHERE application_id=?`).bind(principal.clientId),
  ];

  const membershipIndex = principal.type === "user" ? statements.length : -1;
  if (principal.type === "user") {
    statements.push(context.env.DB.prepare(`SELECT m.space_id,m.role,s.name space_name
      FROM space_memberships m
      JOIN spaces s ON s.id=m.space_id
      WHERE m.user_id=? AND m.deleted_at IS NULL AND s.deleted_at IS NULL`).bind(principal.id));
  }

  const ceilingIndex = principal.type === "user" ? statements.length : -1;
  if (principal.type === "user") {
    statements.push(context.env.DB.prepare(`SELECT c.space_id,c.model_key,c.max_access
      FROM model_access_ceilings c JOIN spaces s ON s.id=c.space_id
      WHERE c.entity_type='user' AND c.entity_id=? AND s.deleted_at IS NULL`).bind(principal.id));
  }

  const grantsIndex = statements.length;
  statements.push(context.env.DB.prepare(`SELECT g.source_space_id,g.resource_type,g.resource_id,g.permission,s.name space_name
    FROM data_grants g
    JOIN spaces s ON s.id=g.source_space_id
    WHERE g.grantee_type=? AND g.grantee_id=?
      AND g.resource_type IN ('space','model')
      AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR julianday(g.expires_at)>julianday('now'))
      AND s.deleted_at IS NULL`).bind(principal.type, principal.id));

  const delegatedAgent = principal.actor?.type === "agent";
  const delegationIndex = delegatedAgent ? statements.length : -1;
  if (delegatedAgent) {
    statements.push(context.env.DB.prepare(`SELECT
        d.source_space_id,s.target_type,s.target_id,s.target_model_key,s.max_access
      FROM delegations d
      JOIN delegation_scopes s ON s.delegation_id=d.id
      JOIN spaces sp ON sp.id=d.source_space_id
      WHERE d.principal_type=? AND d.principal_id=?
        AND d.actor_type=? AND d.actor_id=? AND d.application_id=?
        AND d.revoked_at IS NULL
        AND d.consumed_at IS NULL
        AND (d.expires_at IS NULL OR julianday(d.expires_at)>julianday('now'))
        AND sp.deleted_at IS NULL`)
      .bind(principal.type, principal.id, principal.actor!.type, principal.actor!.id, principal.clientId));
  }

  const results = await context.env.DB.batch(statements);
  const catalogs = (results[0].results ?? []) as CatalogRow[];
  const catalogByModel = new Map(catalogs.map((row) => [row.model_key, row.max_access]));
  const memberships = membershipIndex >= 0 ? (results[membershipIndex].results ?? []) as MembershipAccessRow[] : [];
  const membershipsBySpace = new Map(memberships.map((row) => [row.space_id, { role: row.role }]));
  const spaceNamesById = new Map(memberships.map((row) => [row.space_id, row.space_name]));
  const grantsBySpace = new Map<string, GrantRow[]>();
  for (const row of (results[grantsIndex].results ?? []) as GrantAccessRow[]) {
    pushGrant(grantsBySpace, row);
    if (!spaceNamesById.has(row.source_space_id)) spaceNamesById.set(row.source_space_id, row.space_name);
  }

  const ceilingsBySpace = new Map<string, Map<string, ModelAccessCeiling>>();
  if (ceilingIndex >= 0) {
    for (const row of (results[ceilingIndex].results ?? []) as SpaceCeilingRow[]) {
      const ceilings = ceilingsBySpace.get(row.space_id) ?? new Map<string, ModelAccessCeiling>();
      ceilings.set(row.model_key, row.max_access);
      ceilingsBySpace.set(row.space_id, ceilings);
    }
  }

  const models = await listPublishedModels(context.env);
  const modelKeys = models.map((model) => model.key);
  const delegatedBySpace = new Map<string, Map<string, ModelAccess>>();
  if (delegatedAgent) {
    for (const row of (results[delegationIndex].results ?? []) as DelegationSpaceAccessRow[]) {
      pushDelegation(delegatedBySpace, row, modelKeys);
    }
  }

  return {
    principal,
    models,
    catalogByModel,
    membershipsBySpace,
    spaceNamesById,
    grantsBySpace,
    ceilingsBySpace,
    delegatedAgent,
    delegatedBySpace,
    candidateSpaceIds: [...new Set<string>([
      ...membershipsBySpace.keys(),
      ...grantsBySpace.keys(),
    ])].filter(spaceId => !principal.oauthExecution || spaceId === principal.oauthExecution.spaceId)
      .sort((left, right) => left.localeCompare(right)),
  };
}

export function registerRuntimeDiscoveryRoutes(app: App): void {
  app.get("/api/v1/me/_discovery", async (context) => {
    const state = await aggregateDiscoveryState(context);
    const external = await visibleExternalModels(context.env,state.principal,state.candidateSpaceIds,context.req.header("x-lifespace-delegation-id"));
    const spaces = state.candidateSpaceIds.flatMap((spaceId) => {
      const visible = visibleModels(
        state.principal,
        state.models,
        state.catalogByModel,
        state.membershipsBySpace.get(spaceId) ?? null,
        state.grantsBySpace.get(spaceId) ?? [],
        state.delegatedAgent ? (state.delegatedBySpace.get(spaceId) ?? new Map<string, ModelAccess>()) : undefined,
        state.ceilingsBySpace.get(spaceId),
      );
      const combined = [...visible,...(external.get(spaceId)??[])];
      return combined.length ? [{ spaceId, spaceName: state.spaceNamesById.get(spaceId)!, models: combined }] : [];
    });

    return context.json(success({ spaces }));
  });

  app.get("/api/v1/me/_discovery/inventory", async (context) => {
    const state = await aggregateDiscoveryState(context);
    const visibleModelKeys = new Set<string>();
    const oauthQueryKeys = state.principal.oauthExecution
      ? new Set(state.principal.oauthExecution.toolModelKeys ?? [])
      : null;
    // OAuth tools are bounded by current Core MCP Server configuration.
    // External models are not selected by the v1 MCP Server control plane.
    const external: Awaited<ReturnType<typeof visibleExternalModels>> = oauthQueryKeys
      ? new Map()
      : await visibleExternalModels(context.env,state.principal,state.candidateSpaceIds,context.req.header("x-lifespace-delegation-id"));
    const spaces = state.candidateSpaceIds.flatMap((spaceId) => {
      const visible = visibleModelAccess(
        state.principal,
        state.models,
        state.catalogByModel,
        state.membershipsBySpace.get(spaceId) ?? null,
        state.grantsBySpace.get(spaceId) ?? [],
        state.delegatedAgent ? (state.delegatedBySpace.get(spaceId) ?? new Map<string, ModelAccess>()) : undefined,
        state.ceilingsBySpace.get(spaceId),
      );
      const selected = oauthQueryKeys
        ? visible.filter(entry => oauthQueryKeys.has(entry.model.key))
        : visible;
      for (const entry of selected) visibleModelKeys.add(entry.model.key);
      const externalHere = oauthQueryKeys ? [] : (external.get(spaceId) ?? []);
      return selected.length||externalHere.length ? [{
        spaceId,
        spaceName: state.spaceNamesById.get(spaceId)!,
        models: [...selected.map(({ model, access }) => ({ modelKey: model.key, access })),...externalHere.map(m=>({modelKey:m.key,access:m.access}))],
      }] : [];
    });
    const models = state.models
      .filter((model) => visibleModelKeys.has(model.key))
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(inventoryModel);
    const externalInventory=[...external.values()].flat().map(m=>({key:m.key,origin:m.origin,spaceId:m.spaceId,schemaHash:m.schemaHash,display:m.display,runtimeCapabilities:m.runtimeCapabilities,contract:m.contract}));

    return context.json(success({ semanticDetailPathTemplate, models: [...models,...externalInventory], spaces }));
  });

  app.get("/api/v1/spaces/:spaceId/_discovery", async (context) => {
    const principal = context.get("principal");
    const spaceId = context.req.param("spaceId");

    // LEFT JOIN, not INNER JOIN: a User may hold an independent Data Grant
    // after membership removal, and sparse ceilings still constrain that grant.
    const spaceStatement = principal.type === "user"
      ? context.env.DB.prepare(`SELECT s.id,s.name,m.role,c.model_key,c.max_access
          FROM spaces s
          LEFT JOIN space_memberships m ON m.space_id=s.id AND m.user_id=? AND m.deleted_at IS NULL
          LEFT JOIN model_access_ceilings c ON c.space_id=s.id AND c.entity_type='user' AND c.entity_id=?
          WHERE s.id=? AND s.deleted_at IS NULL`).bind(principal.id, principal.id, spaceId)
      : context.env.DB.prepare("SELECT id,name FROM spaces WHERE id=? AND deleted_at IS NULL LIMIT 1").bind(spaceId);
    const statements: D1PreparedStatement[] = [
      spaceStatement,
      context.env.DB.prepare(`SELECT model_key,max_access FROM application_model_access
        WHERE application_id=?`).bind(principal.clientId),
    ];

    const grantsIndex = statements.length;
    statements.push(context.env.DB.prepare(`SELECT resource_type,resource_id,permission FROM data_grants
      WHERE source_space_id=? AND grantee_type=? AND grantee_id=?
        AND resource_type IN ('space','model')
        AND revoked_at IS NULL AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))`)
      .bind(spaceId, principal.type, principal.id));

    const delegatedAgent = principal.actor?.type === "agent";
    const delegationIndex = delegatedAgent ? statements.length : -1;
    if (delegatedAgent) {
      statements.push(context.env.DB.prepare(`SELECT
          s.target_type,s.target_id,s.target_model_key,s.max_access
        FROM delegations d
        JOIN delegation_scopes s ON s.delegation_id=d.id
        WHERE d.principal_type=? AND d.principal_id=?
          AND d.actor_type=? AND d.actor_id=? AND d.application_id=? AND d.source_space_id=?
          AND d.revoked_at IS NULL
          AND d.consumed_at IS NULL
          AND (d.expires_at IS NULL OR julianday(d.expires_at)>julianday('now'))`)
        .bind(principal.type, principal.id, principal.actor!.type, principal.actor!.id, principal.clientId, spaceId));
    }

    // The External catalog is metadata, not Provider records or authority.
    // Fetch it in the same current-state batch; the External projection below
    // still performs its own authoritative evaluation for every bound model.
    const externalStatement = prepareExternalModelList(context.env, [spaceId]);
    const externalIndex = externalStatement ? statements.length : -1;
    if (externalStatement) statements.push(externalStatement);
    const results = await measurePerformancePhase(context, "runtime.discovery_state", () =>
      readAuthorityBatch(context.env, statements, authorityD1Observer(context)));
    const spaceRows = (results[0].results ?? []) as unknown as SpaceDiscoveryRow[];
    const space = spaceRows[0];
    if (!space) throw new ApiError("SPACE_NOT_FOUND", "Space not found", 404);

    const catalogs = (results[1].results ?? []) as CatalogRow[];
    const catalogByModel = new Map(catalogs.map((row) => [row.model_key, row.max_access]));
    const membership = space.role ? { role: space.role } : null;
    const grants = (results[grantsIndex].results ?? []) as GrantRow[];
    const ceilingsByModel = new Map<string, ModelAccessCeiling>();
    for (const row of spaceRows) {
      if (row.model_key && row.max_access) ceilingsByModel.set(row.model_key, row.max_access);
    }
    const models = await measurePerformancePhase(context, "runtime.discovery_model_resolution", () =>
      listPublishedModels(context.env));
    const delegatedByModel = new Map<string, ModelAccess>();
    if (delegatedAgent) {
      for (const row of (results[delegationIndex].results ?? []) as DelegationAccessRow[]) {
        const access = delegationModelAccess(row.max_access);
        if (!access || row.target_type === "record") continue;
        const targets = row.target_type === "space" ? models.map((model) => model.key) : [row.target_id];
        for (const modelKey of targets) {
          const current = delegatedByModel.get(modelKey);
          if (!current || accessRank[access] > accessRank[current]) delegatedByModel.set(modelKey, access);
        }
      }
    }
    const visible = await measurePerformancePhase(context, "runtime.discovery_native_projection", async () => visibleModels(
      principal,
      models,
      catalogByModel,
      membership,
      grants,
      delegatedAgent ? delegatedByModel : undefined,
      ceilingsByModel,
    ));

    const externalModels = await measurePerformancePhase(context, "runtime.discovery_external_metadata", () =>
      hydrateExternalModelList(context.env, externalIndex >= 0
        ? (results[externalIndex].results ?? []) as unknown as ExternalModelListRow[] : []));
    const external = await measurePerformancePhase(context, "runtime.discovery_external_authority_projection", () =>
      projectVisibleExternalModels(context.env, principal, externalModels, context.req.header("x-lifespace-delegation-id")));
    const combined = [...visible,...(external.get(spaceId)??[])];
    return context.json(success({ spaceId, spaceName: combined.length ? space.name : null, models: combined }));
  });
}

