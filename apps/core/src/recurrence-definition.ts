import type { FieldDefinition, ModelValidationIssue } from "./model-definition";
import type { RecurrenceRule } from "./recurrence-rule";
import { parseRecurrenceDate } from "./recurrence-rule";
import { ApiError } from "./http";

export type RecurrenceCapabilityDefinition = {
  ruleField: string;
  firstDueDateField: string;
  statusField: string;
  endDateField?: string;
  task: { nameField: string; descriptionField?: string; subjectField?: string; assigneePersonField?: string };
};
export function validateRecurrenceCapability(raw: unknown, fields: Record<string, FieldDefinition>): { definition?: RecurrenceCapabilityDefinition; issues: ModelValidationIssue[] } {
  const issues: ModelValidationIssue[] = [];
  const issue = (path: string, message: string) => issues.push({ path: `capabilities.recurrence.${path}`, code: "INVALID_RECURRENCE_BINDING", message });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { issue("", "Recurrence must use object-form metadata"); return { issues }; }
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) if (!["ruleField", "firstDueDateField", "statusField", "endDateField", "task"].includes(key)) issue(key, "Unknown property");
  const bind = (obj: Record<string, unknown>, key: string, types: string[], path = key): string => {
    const name = obj[key];
    if (typeof name !== "string" || !fields[name] || !types.includes(fields[name]!.type)) { issue(path, `${key} must bind a declared ${types.join(" / ")} field`); return ""; }
    return name;
  };
  const ruleField = bind(value, "ruleField", ["recurrence_rule"]);
  const firstDueDateField = bind(value, "firstDueDateField", ["date"]);
  const statusField = bind(value, "statusField", ["enum"]);
  if (fields[statusField] && !["active", "paused"].every(s => fields[statusField]!.values?.includes(s))) issue("statusField", "Status enum must include active and paused");
  const endDateField = value.endDateField === undefined ? undefined : bind(value, "endDateField", ["date"]);
  const rawTask = value.task;
  if (!rawTask || typeof rawTask !== "object" || Array.isArray(rawTask)) { issue("task", "Task bindings required"); return { issues }; }
  const task = rawTask as Record<string, unknown>;
  for (const key of Object.keys(task)) if (!["nameField", "descriptionField", "subjectField", "assigneePersonField"].includes(key)) issue(`task.${key}`, "Unknown property");
  const nameField = bind(task, "nameField", ["string", "text"], "task.nameField");
  const optional = (key: string, types: string[]) => task[key] === undefined ? undefined : bind(task, key, types, `task.${key}`);
  const descriptionField = optional("descriptionField", ["string", "text"]), subjectField = optional("subjectField", ["person", "record", "entity_ref"]), assigneePersonField = optional("assigneePersonField", ["person", "person_list"]);
  const core = [ruleField, firstDueDateField, statusField, ...(endDateField ? [endDateField] : [])];
  if (new Set(core).size !== core.length) issue("", "Core bindings must be distinct");
  return { issues, ...(!issues.length ? { definition: { ruleField, firstDueDateField, statusField, ...(endDateField ? { endDateField } : {}), task: { nameField, ...(descriptionField ? { descriptionField } : {}), ...(subjectField ? { subjectField } : {}), ...(assigneePersonField ? { assigneePersonField } : {}) } } } : {}) };
}

export function validateRecurrenceData(binding: RecurrenceCapabilityDefinition | undefined, data: Record<string, unknown>): void {
  if (!binding || data[binding.ruleField] == null) return;
  try { parseRecurrenceDate(data[binding.firstDueDateField]); } catch { throw new ApiError("INVALID_RESOURCE", "firstDueDate is required when recurrence is set", 400); }
  if (binding.endDateField && data[binding.endDateField] != null) {
    parseRecurrenceDate(data[binding.endDateField]);
    if (String(data[binding.endDateField]) < String(data[binding.firstDueDateField])) throw new ApiError("INVALID_RESOURCE", "endDate must not precede firstDueDate", 400);
  }
  const rule = data[binding.ruleField] as RecurrenceRule;
  if (!rule.mode) throw new ApiError("INVALID_RESOURCE", "Recurrence rule must be validated before binding", 400);
}
