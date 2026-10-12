import { localDateWindowToInstantRange } from "./time-semantics";
import type { Bindings, Principal } from "./env";
import { ApiError } from "./http";
import type { PublishedModel } from "./model-registry";
import { getRuntimeModel } from "./model-registry";
import { evaluateRecurrenceRoots, evaluateModelAccessMany, type ModelAccessDecision } from "./model-authorization";
import { requireModelPolicy } from "./policy";
import { getTypedResourcesByModels } from "./typed-resource-batch";
import { collectRelationProjections, planCreateGenericMutation, planUpdateGenericMutation, prepareCreateGenericMutation, prepareUpdateGenericMutation, validateRelationProjectionGroups, type GenericResource, type MutationAttribution } from "./generic-resource";
import { addRecurrenceDays, addRecurrenceInterval, calendarOccurrences, spaceRecurrenceDate, type RecurrenceRule } from "./recurrence-rule";
import { parseEntityRef } from "./entity-ref";

type State = {
  plan_record_id: string; space_id: string; model_key: string; revision: number; config_json: string; version: number;
  principal_type: Principal["type"]; principal_id: string; application_id: string; scopes_json: string;
  next_materialize_date: string | null; cursor_date: string | null; current_occurrence_id: string | null; anchor_date: string | null; stopped: number;
};
type Occurrence = { id: string; plan_record_id: string; revision: number; due_date: string; task_record_id: string; predecessor_id: string | null; outcome: string; anchor_date: string | null };
type Entry = { model: PublishedModel; recordId?: string; data: Record<string, unknown>; previous?: GenericResource; attribution?: MutationAttribution; actionKey?: string };
type Prepared = { generatedChangeSets: Map<string, string>; errors: Map<string, ApiError>; enrolmentByRecord: Map<string, ModelAccessDecision[]>; remaining: number; validatedRefs: Set<string>; states: Map<string, State>; occurrences: Map<string, Occurrence>; resources: Map<string, GenericResource>; models: Map<string, PublishedModel>; timezone: string; task: PublishedModel; decisions: Map<string, ModelAccessDecision>; enrolment: ModelAccessDecision[] };
// Request-owned Principal objects are never shared across requests/cron invocations.
const preparedRequests = new WeakMap<Principal, Prepared>();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const stateRoot = (state: State): Principal => ({ type: state.principal_type, id: state.principal_id, clientId: state.application_id, scopes: JSON.parse(state.scopes_json), tokenId: "recurrence-intent" });
const rootKey = (principal: Principal, spaceId: string, modelKey: string) => JSON.stringify([principal.type, principal.id, principal.clientId, spaceId, modelKey]);
function config(model: PublishedModel, data: Record<string, unknown>): string {
  const b = model.definition.capabilities!.recurrence!;
  return JSON.stringify([data[b.ruleField] ?? null, data[b.firstDueDateField] ?? null]);
}
const internalExecutors = new WeakSet<Principal>();
export function isRecurrenceExecutor(principal: Principal): boolean { return internalExecutors.has(principal); }
function internal(root: Principal): Principal {
  const executor: Principal = { ...root, actor: { type: "service", id: "svc_lifespace_recurrence" }, displayName: "LifeSpace Recurrence" };
  internalExecutors.add(executor); return executor;
}
function windowDays(env: Bindings): number {
  const value = Number(env.RECURRENCE_WINDOW_DAYS ?? 30);
  return Number.isInteger(value) && value >= 0 && value <= 90 ? value : 30;
}

/** Set-wise preparation used by CRUD, explicit Batch and the indexed rolling worker. */
export async function prepareRecurrenceMutations(env: Bindings, principal: Principal, spaceId: string, entries: readonly Entry[], preloadedStates?: State[]): Promise<void> {
  const active = entries.filter(e => {
    const binding = e.model.definition.capabilities?.recurrence;
    return binding && (preloadedStates || e.data[binding.ruleField] != null || e.previous?.data[binding.ruleField] != null) || e.data.recurrenceOccurrenceId;
  });
  if (!active.length) return;
  if (!preloadedStates && principal.type === "device") throw new ApiError("MODEL_OPERATION_UNSUPPORTED", "Recurrence enrollment supports User, Service and Agent roots", 405);
  const task = await getRuntimeModel(env, "task");
  if (!task?.definition.fields.subject || !task.definition.fields.recurrenceOccurrenceId || !task.definition.semanticRelations?.outgoing?.includes("generated_from")) throw new ApiError("RECURRENCE_DEPENDENCY_UNAVAILABLE", "Published Task contract does not support Recurrence", 409);
  const ids = active.flatMap(e => e.recordId ? [e.recordId] : []);
  const occurrenceIds = active.flatMap(e => typeof e.data.recurrenceOccurrenceId === "string" ? [e.data.recurrenceOccurrenceId] : []);
  const selection = `SELECT value FROM json_each(?) UNION SELECT plan_record_id FROM recurrence_occurrences WHERE id IN (SELECT value FROM json_each(?))`;
  const results = await env.DB.batch([
    env.DB.prepare("SELECT timezone FROM spaces WHERE id=? AND deleted_at IS NULL").bind(spaceId),
    env.DB.prepare(`SELECT p.* FROM recurrence_plans p WHERE p.space_id=? AND p.plan_record_id IN (${selection})`).bind(spaceId, JSON.stringify(ids), JSON.stringify(occurrenceIds)),
    env.DB.prepare(`SELECT o.* FROM recurrence_occurrences o WHERE o.plan_record_id IN (SELECT p.plan_record_id FROM recurrence_plans p WHERE p.space_id=? AND p.plan_record_id IN (${selection})) AND o.outcome='active' AND o.due_date>=date('now','-1 day')
      UNION SELECT * FROM recurrence_occurrences WHERE id IN (SELECT value FROM json_each(?))
      UNION SELECT * FROM recurrence_occurrences WHERE id IN (SELECT current_occurrence_id FROM recurrence_plans WHERE plan_record_id IN (${selection}))`)
      .bind(spaceId, JSON.stringify(ids), JSON.stringify(occurrenceIds), JSON.stringify(occurrenceIds), JSON.stringify(ids), JSON.stringify(occurrenceIds)),
  ]);
  const timezone = (results[0]?.results[0] as { timezone: string } | undefined)?.timezone;
  if (!timezone) throw new ApiError("SPACE_NOT_FOUND", "Space unavailable", 404);
  const states = new Map((preloadedStates ?? results[1]!.results as unknown as State[]).map(s => [s.plan_record_id, s]));
  const occurrences = new Map((results[2]!.results as unknown as Occurrence[]).map(o => [o.id, o]));
  const models = new Map<string, PublishedModel>([[task.key, task], ...active.map(e => [e.model.key, e.model] as const)]);
  for (const state of states.values()) if (!models.has(state.model_key)) {
    const model = await getRuntimeModel(env, state.model_key);
    if (model?.definition.capabilities?.recurrence) models.set(model.key, model);
  }
  const groups = new Map<string, Set<string>>();
  for (const state of states.values()) { const set = groups.get(state.model_key) ?? new Set<string>(); set.add(state.plan_record_id); groups.set(state.model_key, set); }
  groups.set(task.key, new Set([...occurrences.values()].map(o => o.task_record_id)));
  const resources = await getTypedResourcesByModels(env, spaceId, [...groups].filter(([key]) => models.has(key)).map(([key, set]) => ({ model: models.get(key)!, ids: [...set] }))) as Map<string, GenericResource>;
  const identities = new Map<string, { type: Principal["type"]; id: string; applicationId: string }>();
  const identityKey = (type: string, id: string, app: string) => JSON.stringify([type, id, app]);
  for (const state of states.values()) identities.set(identityKey(state.principal_type, state.principal_id, state.application_id), { type: state.principal_type, id: state.principal_id, applicationId: state.application_id });
  if (!preloadedStates) identities.set(identityKey(principal.type, principal.id, principal.clientId), { type: principal.type, id: principal.id, applicationId: principal.clientId });
  const liveScopes = new Map<string, string[]>();
  if (identities.size) {
    if (!env.IDENTITY || !env.CORE_IDENTITY_SHARED_SECRET) throw new ApiError("RECURRENCE_IDENTITY_UNAVAILABLE", "Current enrolled identity checks are unavailable", 503);
    try {
      const response = await env.IDENTITY.fetch("https://identity.internal/introspection/v1/recurrence-roots", { method: "POST", headers: { "content-type": "application/json", "x-lifespace-internal-secret": env.CORE_IDENTITY_SHARED_SECRET }, body: JSON.stringify({ roots: [...identities.values()] }) });
      if (!response.ok) throw Error("Identity unavailable");
      const payload = await response.json<{ data: { roots: Array<{ type: string; id: string; applicationId: string; active: boolean; scopes: string[] }> } }>();
      const seen = new Set<string>();
      if (!Array.isArray(payload.data.roots) || payload.data.roots.length !== identities.size) throw Error("Incomplete root projection");
      for (const root of payload.data.roots) {
        const key = identityKey(root.type, root.id, root.applicationId);
        if (!identities.has(key) || seen.has(key) || typeof root.active !== "boolean" || !Array.isArray(root.scopes) || root.scopes.some(scope => typeof scope !== "string")) throw Error("Invalid root projection");
        seen.add(key); if (root.active) liveScopes.set(key, root.scopes);
      }
    } catch { throw new ApiError("RECURRENCE_IDENTITY_UNAVAILABLE", "Current enrolled identity checks failed", 503); }
  }
  const currentRoot = (state: State) => {
    const root = stateRoot(state), scopes = liveScopes.get(identityKey(root.type, root.id, root.clientId)) ?? [];
    return { ...root, scopes: root.scopes.filter(scope => scopes.includes(scope)) };
  };
  const roots = [...states.values()].flatMap(state => models.has(state.model_key) ? [
    { principal: currentRoot(state), spaceId, request: { model: models.get(state.model_key)!, required: "write" as const } },
    { principal: currentRoot(state), spaceId, request: { model: task, required: "write" as const } },
  ] : []);
  const evaluations = await evaluateRecurrenceRoots(env, roots);
  const decisions = new Map<string, ModelAccessDecision>();
  evaluations.forEach((value, index) => { if (value.ok) decisions.set(rootKey(roots[index]!.principal, spaceId, roots[index]!.request.model.key), value.decision); });
  // A new or materially changed recurring intent is enrolled only with current
  // Plan+Task write authority through the SAME selected Delegation, if any.
  const enrolling = preloadedStates ? [] : active.filter(e => e.model.definition.capabilities?.recurrence && (e.recordId && states.has(e.recordId) && states.get(e.recordId)!.config_json !== config(e.model, e.data) || e.data[e.model.definition.capabilities.recurrence.ruleField] != null && (!e.recordId || !states.has(e.recordId))));
  const enrolment = !preloadedStates && enrolling.length ? await evaluateModelAccessMany(env, principal, spaceId, enrolling.flatMap(e => [
    { model: e.model, required: "write" as const, selector: { delegationId: e.attribution?.delegationId, recordId: e.recordId } },
    { model: task, required: "write" as const, selector: { delegationId: e.attribution?.delegationId } },
  ])) : [];
  const errors = new Map<string, ApiError>();
  const enrolmentByRecord = new Map<string, ModelAccessDecision[]>();
  enrolling.forEach((entry, index) => {
    const scopes = liveScopes.get(identityKey(principal.type, principal.id, principal.clientId));
    if (!scopes?.includes("resources:write")) { errors.set(entry.recordId!, new ApiError("RECURRENCE_AUTHORITY_UNAVAILABLE", "Enrolled Principal/Application is disabled or narrowed", 403)); return; }
    const pair = enrolment.slice(index * 2, index * 2 + 2);
    if (pair.length !== 2) return;
    const denial = pair.find(value => !value.ok);
    if (denial && !denial.ok) errors.set(entry.recordId!, denial.error);
    else enrolmentByRecord.set(entry.recordId!, pair.flatMap(value => value.ok ? [value.decision] : []));
  });
  const validatedRefs = new Set<string>();
  const relationEntries = [...active, ...[...states.values()].flatMap(state => {
    const resource = resources.get(state.plan_record_id);
    return resource && models.has(state.model_key) ? [{ model: models.get(state.model_key)!, recordId: resource.id, data: resource.data }] : [];
  })];
  const relationGroups = relationEntries.map(entry => {
    const b = entry.model.definition.capabilities?.recurrence;
    if (!b) return [];
    const relations = collectRelationProjections(entry.model.definition, entry.data).filter(r => r.fieldKey === b.task.subjectField || r.fieldKey === b.task.assigneePersonField);
    for (const relation of relations) validatedRefs.add(JSON.stringify([relation.targetType, relation.targetId, relation.targetModelKey]));
    return relations;
  });
  const relationErrors = await validateRelationProjectionGroups(env, spaceId, relationGroups);
  relationErrors.forEach((error, index) => { if (error) errors.set(relationEntries[index]!.recordId ?? "", error); });
  preparedRequests.set(principal, { generatedChangeSets: new Map(), errors, enrolmentByRecord, remaining: 20, validatedRefs, states, occurrences, resources, models, timezone, task, decisions, enrolment: enrolment.flatMap(value => value.ok ? [value.decision] : []) });
}

function guard(env: Bindings, recordId: string, token: string): D1PreparedStatement[] {
  return [env.DB.prepare("INSERT INTO recurrence_commit_guards(token,record_id) VALUES(?,?)").bind(token, recordId), env.DB.prepare("DELETE FROM recurrence_commit_guards WHERE token=?").bind(token)];
}
function stateWrite(env: Bindings, state: State, oldVersion: number | undefined, timezone: string): D1PreparedStatement[] {
  const nextAt = state.next_materialize_date ? localDateWindowToInstantRange({ dateStart: state.next_materialize_date, dateEndExclusive: addRecurrenceDays(state.next_materialize_date, 1), timezone }).startInclusive : null;
  if (oldVersion === undefined) return [env.DB.prepare(`INSERT INTO recurrence_plans(plan_record_id,space_id,model_key,revision,config_json,version,principal_type,principal_id,application_id,scopes_json,next_materialize_date,cursor_date,current_occurrence_id,anchor_date,stopped,next_materialize_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(state.plan_record_id,state.space_id,state.model_key,state.revision,state.config_json,state.version,state.principal_type,state.principal_id,state.application_id,state.scopes_json,state.next_materialize_date,state.cursor_date,state.current_occurrence_id,state.anchor_date,state.stopped,nextAt)];
  // The optimistic Plan/Task guard protects ordinary mutations. The extra state
  // guard also serializes completion vs background materialization/resume.
  return [env.DB.prepare(`INSERT INTO recurrence_state_guards(plan_record_id,expected_version) VALUES(?,?)`).bind(state.plan_record_id, oldVersion),
    env.DB.prepare(`UPDATE recurrence_plans SET revision=?,config_json=?,version=?,principal_type=?,principal_id=?,application_id=?,scopes_json=?,next_materialize_date=?,cursor_date=?,current_occurrence_id=?,anchor_date=?,stopped=?,next_materialize_at=? WHERE plan_record_id=? AND version=?`).bind(state.revision, state.config_json, state.version, state.principal_type, state.principal_id, state.application_id, state.scopes_json, state.next_materialize_date, state.cursor_date, state.current_occurrence_id, state.anchor_date, state.stopped, nextAt, state.plan_record_id, oldVersion),
    env.DB.prepare("DELETE FROM recurrence_state_guards WHERE plan_record_id=?").bind(state.plan_record_id)];
}

async function generate(env: Bindings, prepared: Prepared, state: State, plan: GenericResource, dates: string[], timestamp: string, predecessor?: string): Promise<D1PreparedStatement[]> {
  if (!dates.length) return [];
  const model = prepared.models.get(plan.modelKey)!;
  const b = model.definition.capabilities!.recurrence!;
  const root = stateRoot(state), taskDecision = prepared.decisions.get(rootKey(root, state.space_id, "task"));
  const planDecision = prepared.decisions.get(rootKey(root, state.space_id, model.key));
  if (!taskDecision || !planDecision) throw new ApiError("RECURRENCE_AUTHORITY_UNAVAILABLE", "Current enrolled Plan/Task authority is unavailable", 403);
  await requireModelPolicy(env, internal(root), state.space_id, model, "update", plan, undefined, { ...planDecision.policyIdentity, actorPersonId: null });
  const mutations = dates.map(date => {
    const occurrenceId = id("rco");
    const data: Record<string, unknown> = { name: plan.data[b.task.nameField], dueDate: date, recurrenceOccurrenceId: occurrenceId };
    if (b.task.descriptionField) data.description = plan.data[b.task.descriptionField] ?? null;
    if (b.task.subjectField && plan.data[b.task.subjectField] != null) {
      const field = model.definition.fields[b.task.subjectField]!;
      data.subject = field.type === "person" ? { kind: "person", personId: plan.data[b.task.subjectField] }
        : field.type === "record" ? { kind: "record", modelKey: field.targetModel!, recordId: plan.data[b.task.subjectField] } : parseEntityRef(plan.data[b.task.subjectField]);
    }
    if (b.task.assigneePersonField) {
      const value = plan.data[b.task.assigneePersonField];
      data.assigneePersonIds = value == null ? [] : Array.isArray(value) ? value : [value];
    }
    return { occurrenceId, date, prepared: prepareCreateGenericMutation(prepared.task, data, true) };
  });
  const errors = await validateRelationProjectionGroups(env, state.space_id, mutations.map(m => m.prepared.relations.filter(r => !prepared.validatedRefs.has(JSON.stringify([r.targetType, r.targetId, r.targetModelKey])))));
  for (const error of errors) if (error) throw error;
  const statements: D1PreparedStatement[] = [];
  if (dates.length) {
    const token = id("rgd");
    statements.push(env.DB.prepare("INSERT INTO recurrence_generation_guards(token,space_id,model_key,principal_type,principal_id,application_id) VALUES(?,?,?,?,?,?)").bind(token, state.space_id, model.key, root.type, root.id, root.clientId), env.DB.prepare("DELETE FROM recurrence_generation_guards WHERE token=?").bind(token));
  }
  const groupKey = rootKey(root, state.space_id, "task");
  const changeSetId = prepared.generatedChangeSets.get(groupKey) ?? id("cgs");
  prepared.generatedChangeSets.set(groupKey, changeSetId);
  if (dates.length) statements.push(env.DB.prepare(`INSERT OR IGNORE INTO resource_change_sets(id,space_id,application_id,principal_type,principal_id,actor_type,actor_id,operation_count,occurred_at) VALUES(?,?,?,?,?,'service','svc_lifespace_recurrence',?,?)`).bind(changeSetId, state.space_id, root.clientId, root.type, root.id, dates.length, timestamp), env.DB.prepare("UPDATE resource_change_sets SET committed_at=NULL,operation_count=(SELECT COUNT(*) FROM resource_changes WHERE change_set_id=?)+? WHERE id=?").bind(changeSetId, dates.length, changeSetId));
  for (const mutation of mutations) {
    await requireModelPolicy(env, internal(root), state.space_id, prepared.task, "create", undefined, mutation.prepared.data, { ...taskDecision.policyIdentity, actorPersonId: null });
    const taskPlan = await planCreateGenericMutation(env, internal(root), state.space_id, prepared.task, mutation.prepared, undefined, { changeSetId }, timestamp);
    statements.push(...taskPlan.statements);
    const relationId = id("rel");
    statements.push(env.DB.prepare(`INSERT INTO semantic_relations(id,space_id,source_model_key,source_record_id,predicate,target_model_key,target_record_id,created_at) VALUES(?,?,'task',?,'generated_from',?,?,?)`).bind(relationId, state.space_id, taskPlan.resource!.id, model.key, plan.id, timestamp));
    statements.push(env.DB.prepare(`INSERT INTO semantic_relation_changes(id,relation_id,space_id,source_model_key,source_record_id,predicate,target_model_key,target_record_id,operation,principal_type,principal_id,actor_type,actor_id,application_id,source_resource_change_id,change_set_id,occurred_at) VALUES(?,?,?,'task',?,'generated_from',?,?,'create',?,?,'service','svc_lifespace_recurrence',?,?,?,?)`).bind(id("chg"), relationId, state.space_id, taskPlan.resource!.id, model.key, plan.id, root.type, root.id, root.clientId, taskPlan.changeId, changeSetId, timestamp));
    statements.push(env.DB.prepare(`INSERT INTO recurrence_occurrences(id,plan_record_id,revision,identity,due_date,task_record_id,predecessor_id,outcome) VALUES(?,?,?,?,?,?,?,'active')`).bind(mutation.occurrenceId, plan.id, state.revision, predecessor ?? mutation.date, mutation.date, taskPlan.resource!.id, predecessor ?? null));
    if ((plan.data[b.ruleField] as RecurrenceRule).mode === "after_completion") state.current_occurrence_id = mutation.occurrenceId;
  }
  prepared.remaining -= dates.length;
  if (dates.length) statements.push(env.DB.prepare("UPDATE resource_change_sets SET committed_at=? WHERE id=?").bind(timestamp, changeSetId));
  return statements;
}

async function materialize(env: Bindings, prepared: Prepared, state: State, plan: GenericResource, timestamp: string, resume: boolean): Promise<D1PreparedStatement[]> {
  const b = prepared.models.get(plan.modelKey)!.definition.capabilities!.recurrence!;
  const rule = plan.data[b.ruleField] as RecurrenceRule | null;
  state.next_materialize_date = null;
  if (!rule || plan.data[b.statusField] !== "active" || state.stopped) return [];
  const today = spaceRecurrenceDate(timestamp, prepared.timezone), endDate = b.endDateField ? plan.data[b.endDateField] as string | null : null;
  if (endDate && endDate < today) return [];
  if (rule.mode === "calendar") {
    const through = endDate && endDate < addRecurrenceDays(today, windowDays(env)) ? endDate : addRecurrenceDays(today, windowDays(env));
    const from = resume ? (state.cursor_date && state.cursor_date > today ? state.cursor_date : today) : state.cursor_date ?? String(plan.data[b.firstDueDateField]);
    if (prepared.remaining === 0) { state.cursor_date = from; state.next_materialize_date = today; return []; }
    const result = calendarOccurrences(rule, String(plan.data[b.firstDueDateField]), from, through, prepared.remaining);
    const statements = await generate(env, prepared, state, plan, result.dates, timestamp);
    state.cursor_date = result.nextDate ?? addRecurrenceDays(through, 1);
    state.next_materialize_date = result.nextDate ? today : addRecurrenceDays(today, 1);
    return statements;
  }
  const current = state.current_occurrence_id ? prepared.occurrences.get(state.current_occurrence_id) : undefined;
  if (current && prepared.resources.get(current.task_record_id)?.data.status === "pending") return [];
  if (current?.outcome === "active" || current?.outcome === "cancelled") return [];
  let due = state.anchor_date ? addRecurrenceInterval(state.anchor_date, rule.interval) : String(plan.data[b.firstDueDateField]);
  if (resume && due < today) due = today;
  if (endDate && due > endDate) return [];
  if (prepared.remaining === 0) { state.next_materialize_date = today; return []; }
  return generate(env, prepared, state, plan, [due], timestamp, current?.id);
}

/** Appended INSIDE the Generic Runtime mutation transaction, including Batch. */
export async function recurrenceMutationStatements(env: Bindings, principal: Principal, spaceId: string, model: PublishedModel, recordId: string, data: Record<string, unknown>, previous: GenericResource | undefined, mutationToken: string, timestamp: string, attribution: MutationAttribution = {}, actionKey?: string): Promise<D1PreparedStatement[]> {
  if (isRecurrenceExecutor(principal) && actionKey === "recurrence-rule-replaced") return guard(env, recordId, mutationToken);
  const binding = model.definition.capabilities?.recurrence;
  if (binding && data[binding.ruleField] == null && previous?.data[binding.ruleField] == null) return [];
  if (!model.definition.capabilities?.recurrence && (!data.recurrenceOccurrenceId || !previous || !["complete", "cancel", "skip-occurrence"].includes(actionKey ?? ""))) return [];
  let prepared = preparedRequests.get(principal);
  if (!prepared) { await prepareRecurrenceMutations(env, principal, spaceId, [{ model, recordId, data, previous, attribution, actionKey }]); prepared = preparedRequests.get(principal)!; }
  if (prepared.errors.has(recordId)) throw prepared.errors.get(recordId)!;
  const statements = guard(env, recordId, mutationToken);
  if (model.definition.capabilities?.recurrence) {
    const old = prepared.states.get(recordId);
    const state: State = old ? { ...old, version: old.version + 1 } : {
      plan_record_id: recordId, space_id: spaceId, model_key: model.key, revision: 1, config_json: config(model, data), version: 1,
      principal_type: principal.type, principal_id: principal.id, application_id: principal.clientId, scopes_json: JSON.stringify(principal.scopes.filter(s => s === "resources:read" || s === "resources:write")),
      next_materialize_date: null, cursor_date: null, current_occurrence_id: null, anchor_date: null, stopped: 0,
    };
    const changed = Boolean(old && old.config_json !== config(model, data));
    const b = model.definition.capabilities.recurrence, today = spaceRecurrenceDate(timestamp, prepared.timezone);
    if (!old || changed) {
      state.principal_type = principal.type; state.principal_id = principal.id; state.application_id = principal.clientId;
      state.scopes_json = JSON.stringify(principal.scopes.filter(s => s === "resources:read" || s === "resources:write"));
      state.config_json = config(model, data); state.cursor_date = changed ? addRecurrenceDays(today, 1) : null; state.anchor_date = old?.anchor_date ?? null; state.stopped = 0;
      if (changed) state.revision++;
      let retained: Occurrence | undefined;
      for (const occurrence of prepared.occurrences.values()) if (occurrence.plan_record_id === recordId && occurrence.outcome === "active") {
        const taskResource = prepared.resources.get(occurrence.task_record_id);
        if (!taskResource || taskResource.data.status === "completed") continue;
        if (occurrence.due_date <= today) { retained ??= occurrence; continue; }
        const cancellation = prepareUpdateGenericMutation(prepared.task, { status: "cancelled" }, taskResource, "action");
        const cancellationPlan = await planUpdateGenericMutation(env, internal(stateRoot(state)), spaceId, prepared.task, taskResource, taskResource.version, cancellation, "action", undefined, "recurrence-rule-replaced", {}, timestamp);
        statements.push(...cancellationPlan.statements, env.DB.prepare("UPDATE recurrence_occurrences SET outcome='cancelled' WHERE id=?").bind(occurrence.id));
      }
      state.current_occurrence_id = retained?.id ?? null;
      const root = stateRoot(state);
      for (const target of [model, prepared.task]) {
        const decision = prepared.enrolmentByRecord.get(recordId)?.find(d => d.authority.modelKey === target.key);
        if (decision) prepared.decisions.set(rootKey(root, spaceId, target.key), decision);
      }
    }
    const plan = { id: recordId, spaceId, modelKey: model.key, modelVersion: model.version, data, version: previous ? previous.version + 1 : 1, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp };
    // Insert before occurrence rows; state update remains in the same transaction.
    if (!old) statements.push(...stateWrite(env, state, undefined, prepared.timezone));
    const resume = Boolean(previous && previous.data[b.statusField] !== "active" && data[b.statusField] === "active");
    statements.push(...await materialize(env, prepared, state, plan, timestamp, resume));
    statements.push(...stateWrite(env, state, old?.version ?? state.version, prepared.timezone));
    prepared.states.set(recordId, state);
    return statements;
  }
  if (!previous || !["complete", "cancel", "skip-occurrence"].includes(actionKey ?? "")) return [];
  prepared.resources.set(recordId, { ...previous, data, version: previous.version + 1, updatedAt: timestamp });
  const occurrence = prepared.occurrences.get(String(data.recurrenceOccurrenceId));
  const old = occurrence ? prepared.states.get(occurrence.plan_record_id) : undefined;
  if (!occurrence || !old) return statements;
  if (actionKey === "skip-occurrence" && old.current_occurrence_id !== occurrence.id) throw new ApiError("ACTION_NOT_AVAILABLE", "Only the current completion-based occurrence can be skipped", 409);
  // Reopened historical Tasks never regain the current cursor.
  const state = { ...old, version: old.version + 1 };
  const plan = prepared.resources.get(state.plan_record_id);
  const outcome = actionKey === "complete" ? "completed" : actionKey === "skip-occurrence" ? "skipped" : "cancelled";
  const anchor = actionKey === "complete" ? spaceRecurrenceDate(String(data.completedAt), prepared.timezone) : spaceRecurrenceDate(timestamp, prepared.timezone);
  statements.push(env.DB.prepare("UPDATE recurrence_occurrences SET outcome=?,anchor_date=? WHERE id=?").bind(outcome, anchor, occurrence.id));
  if (outcome !== "cancelled" && old.current_occurrence_id === occurrence.id) {
    state.anchor_date = anchor; state.stopped = 0; prepared.occurrences.set(occurrence.id, { ...occurrence, outcome, anchor_date: anchor });
    if (plan) statements.push(...await materialize(env, prepared, state, plan, timestamp, false));
  } else if (old.current_occurrence_id === occurrence.id) { state.stopped = 1; state.next_materialize_date = null; }
  statements.push(...stateWrite(env, state, old.version, prepared.timezone));
  return statements;
}

/** No HTTP entry point: bounded indexed selection, invoked by Core's scheduler. */
export async function rollRecurrenceWindow(env: Bindings, timestamp = new Date().toISOString()): Promise<number> {
  const rows = await env.DB.prepare(`SELECT * FROM recurrence_plans WHERE space_id=(SELECT space_id FROM recurrence_plans WHERE next_materialize_at IS NOT NULL AND next_materialize_at<=? ORDER BY next_materialize_at,plan_record_id LIMIT 1) AND next_materialize_at IS NOT NULL AND next_materialize_at<=? ORDER BY next_materialize_at,plan_record_id LIMIT 20`).bind(timestamp, timestamp).all<State>();
  const spaces = new Map<string, State[]>();
  for (const state of rows.results) { const group = spaces.get(state.space_id) ?? []; group.push(state); spaces.set(state.space_id, group); }
  let generated = 0;
  let remaining = 20;
  for (const [spaceId, states] of spaces) {
    const principal: Principal = { type: "service", id: "svc_lifespace_recurrence", clientId: "internal", scopes: [], tokenId: id("run") };
    const models = new Map<string, PublishedModel>();
    for (const state of states) { const model = await getRuntimeModel(env, state.model_key); if (model?.definition.capabilities?.recurrence) models.set(model.key, model); }
    if (!models.size) {
      await env.DB.prepare("UPDATE recurrence_plans SET next_materialize_date=NULL,next_materialize_at=NULL WHERE plan_record_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(states.map(s => s.plan_record_id))).run();
      continue;
    }
    await prepareRecurrenceMutations(env, principal, spaceId, states.filter(s => models.has(s.model_key)).map(s => ({ model: models.get(s.model_key)!, recordId: s.plan_record_id, data: {} })), states);
    const prepared = preparedRequests.get(principal)!;
    prepared.remaining = remaining;
    const statements: D1PreparedStatement[] = [];
    for (const old of states) {
      if (old.next_materialize_date! > spaceRecurrenceDate(timestamp, prepared.timezone)) continue;
      const plan = prepared.resources.get(old.plan_record_id);
      const state = { ...old, version: old.version + 1 };
      if (!plan || !models.has(old.model_key)) { state.next_materialize_date = null; statements.push(...stateWrite(env, state, old.version, prepared.timezone)); continue; }
      try {
        if (prepared.errors.has(old.plan_record_id)) throw prepared.errors.get(old.plan_record_id)!;
        const generatedStatements = await materialize(env, prepared, state, plan, timestamp, false);
        statements.push(...generatedStatements); generated += generatedStatements.length ? 1 : 0;
      } catch (error) {
        if (!(error instanceof ApiError) || !["RECURRENCE_AUTHORITY_UNAVAILABLE", "POLICY_DENIED", "INVALID_RESOURCE_RELATION"].includes(error.code)) throw error;
        state.next_materialize_date = addRecurrenceDays(spaceRecurrenceDate(timestamp, prepared.timezone), 1);
      }
      statements.push(...stateWrite(env, state, old.version, prepared.timezone));
    }
    if (statements.length) await env.DB.batch(statements);
    remaining = prepared.remaining;
    if (remaining === 0) break;
  }
  return generated;
}
