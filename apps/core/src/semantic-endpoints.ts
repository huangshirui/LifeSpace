import type { Bindings } from "./env";
import type { GenericResource } from "./generic-resource";
import type { ModelAccessDecision } from "./model-authorization";
import type { PublishedModel } from "./model-registry";
import { getExternalModel, externalAuthorityModel, listExternalModels, type ExternalModel } from "./external-model";
import { executeExternalOperation, externalAuditPlan } from "./external-runtime";
import { getTypedResourcesByModels } from "./typed-resource-batch";
import { ApiError } from "./http";

export type EndpointResource = GenericResource & { externalView?: Record<string, unknown> };
export async function bindEndpointModel(env: Bindings, space: string, model: PublishedModel): Promise<PublishedModel | null> {
  if (model.definition.origin !== "external") return model;
  const binding = await getExternalModel(env, space, model.key);
  return binding?.snapshot.capabilities.get ? { ...model, definition: { ...model.definition, access: externalAuthorityModel(binding).definition.access } } : null;
}
export async function endpointModels(env: Bindings, space: string, models: PublishedModel[]): Promise<PublishedModel[]> {
  if (!models.some(m => m.definition.origin === "external")) return models;
  const bindings = new Map((await listExternalModels(env, [space])).filter(m => m.businessDefinition && m.snapshot.capabilities.get).map(m => [m.businessDefinition!.key, m]));
  return models.flatMap(model => model.definition.origin !== "external" ? [model] : bindings.has(model.key)
    ? [{ ...model, definition: { ...model.definition, access: externalAuthorityModel(bindings.get(model.key)!).definition.access } }] : []);
}
// Identity metadata is local; payload and live existence remain Provider-authoritative.
export function endpointExists(side: "source" | "target", external = true, includeUnavailable = false): string {
  const native = `EXISTS(SELECT 1 FROM resource_records r WHERE r.id=e.${side}_record_id AND r.space_id=e.space_id AND r.model_key=e.${side}_model_key AND r.deleted_at IS NULL)`;
  return external ? `(${native} OR EXISTS(SELECT 1 FROM external_record_identities i JOIN external_models m ON m.model_key=i.model_key JOIN external_sources s ON s.id=m.source_id JOIN model_definitions d ON d.model_key=m.definition_key AND d.state='published' WHERE i.record_id=e.${side}_record_id AND i.space_id=e.space_id ${includeUnavailable ? '' : "AND i.availability='active'"} AND m.space_id=e.space_id AND m.definition_key=e.${side}_model_key AND m.status!='disabled' AND s.status='active' AND json_extract(d.definition_json,'$.origin')='external'))` : native;
}
export async function loadEndpointResources(env: Bindings, space: string, groups: { model: PublishedModel; ids: string[] }[], decisions: Map<string, ModelAccessDecision>, knownExternal = false, failures?: Map<string, ApiError>): Promise<Map<string, EndpointResource>> {
  const resources = await getTypedResourcesByModels(env, space, groups.filter(g => g.model.definition.origin !== "external")) as Map<string, EndpointResource>;
  const external = groups.filter(g => g.model.definition.origin === "external");
  if (!external.length) return resources;
  const bindings = new Map((await listExternalModels(env, [space])).filter(m => m.businessDefinition && m.snapshot.capabilities.get).map(m => [m.businessDefinition!.key, m]));
  if (knownExternal) {
    const rows = await env.DB.prepare(`SELECT i.record_id,m.definition_key FROM external_record_identities i JOIN external_models m ON m.model_key=i.model_key WHERE i.space_id=? AND m.space_id=? AND m.status!='disabled' AND m.definition_key IN (SELECT value FROM json_each(?)) AND i.record_id IN (SELECT value FROM json_each(?))`).bind(space, space, JSON.stringify(external.map(g => g.model.key)), JSON.stringify(external.flatMap(g => g.ids))).all<{ record_id: string; definition_key: string }>();
    for (const group of external) for (const id of group.ids) if (rows.results.some(r => r.record_id === id && r.definition_key === group.model.key)) resources.set(id, { id, spaceId: space, modelKey: group.model.key, modelVersion: 0, version: 0, data: {}, createdAt: "", updatedAt: "" });
    return resources;
  }
  const work: { model: PublishedModel; binding: ExternalModel; id: string; decision: ModelAccessDecision; audit: ReturnType<typeof externalAuditPlan> }[] = [];
  for (const group of external) {
    const binding = bindings.get(group.model.key);
    if (!binding || !binding.snapshot.capabilities.get) continue;
    for (const id of new Set(group.ids)) {
      const decision = decisions.get(group.model.key + "\0" + id);
      if (!decision) continue;
      work.push({ model: group.model, binding, id, decision, audit: externalAuditPlan(env, binding, decision, "get", id) });
    }
  }
  if (work.length > 200) throw new ApiError("INVALID_REQUEST", "External endpoint resolution budget exceeded", 400);
  if (!work.length) return resources;
  await env.DB.batch(work.map(w => w.audit.statement));
  const finalizers: D1PreparedStatement[] = [];
  try {
  for (let offset = 0; offset < work.length; offset += 3) await Promise.all(work.slice(offset, offset + 3).map(async w => {
    try {
      const view = await executeExternalOperation(env, w.binding, w.decision, "get", {}, w.id, undefined,
        { auditId: w.audit.auditId, finalizers, deferReadConsumption: true }) as Record<string, unknown>;
      // Internal identity-only adapter. Native version fields never enter the external wire DTO.
      resources.set(w.id, { id: w.id, spaceId: space, modelKey: w.model.key, modelVersion: 0, version: 0,
        data: {}, createdAt: String(view.createdAt ?? ""), updatedAt: String(view.updatedAt ?? ""), externalView: view });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (failures) failures.set(w.model.key + "\0" + w.id, error);
      else if (![403, 404].includes(error.status)) throw error;
      if (error.status === 404) finalizers.push(env.DB.prepare("UPDATE external_record_identities SET availability='unavailable',observed_at=? WHERE record_id=? AND model_key=? AND space_id=?").bind(new Date().toISOString(), w.id, w.binding.model_key, space));
    }
  }));
  } finally { if (finalizers.length) await env.DB.batch(finalizers); }
  return resources;
}
