export const CREATION_KINDS = ["event", "task", "day_record", "wish"] as const;
export type CreationKind = (typeof CREATION_KINDS)[number];

export type DraftWarningCode =
  | "AMBIGUOUS_PERSON"
  | "UNRESOLVED_PERSON"
  | "INVALID_INFERRED_VALUE"
  | "UNSUPPORTED_DETAIL";

export type DraftWarning = { code: DraftWarningCode; field: string | null; message: string };

export type EventFormDraft = {
  summary: string | null;
  description: string | null;
  isAllDay: boolean | null;
  startDate: string | null;
  endDate: string | null;
  endDateExclusive: string | null;
  startTime: string | null;
  endTime: string | null;
  startTimezone: string | null;
  endTimezone: string | null;
  location: string | null;
  attendeePersonIds: string[];
};

export type TaskFormDraft = {
  name: string | null;
  description: string | null;
  dueDate: string | null;
  assigneePersonIds: string[];
};

export type DayRecordFormDraft = {
  dayRecordKind: "elapsed" | "countdown" | "cycle" | null;
  name: string | null;
  description: string | null;
  anchorDate: string | null;
  subjectPersonId: string | null;
  icon: string | null;
  attentionAfterDays: number | null;
  attentionBeforeDays: number | null;
  cycleDays: number | null;
};

export type WishFormDraft = {
  title: string | null;
  description: string | null;
  desiredDate: string | null;
};

export type NormalizedCreationDraft =
  | { status: "choose_kind"; candidateKinds: CreationKind[] }
  | { status: "ready"; kind: "event"; draft: EventFormDraft; missingFields: string[]; warnings: DraftWarning[] }
  | { status: "ready"; kind: "task"; draft: TaskFormDraft; missingFields: string[]; warnings: DraftWarning[] }
  | { status: "ready"; kind: "day_record"; draft: DayRecordFormDraft; missingFields: string[]; warnings: DraftWarning[] }
  | { status: "ready"; kind: "wish"; draft: WishFormDraft; missingFields: string[]; warnings: DraftWarning[] };

export type ActivePersonRef = { ref: string; personId: string; name: string };

export class CreationDraftInvalidResponseError extends Error {
  readonly code = "AI_INVALID_RESPONSE";
  constructor(message = "AI response does not match the creation draft schema") {
    super(message);
    this.name = "CreationDraftInvalidResponseError";
  }
}

const nullableString = { type: ["string", "null"] } as const;
const nullableInteger = { type: ["integer", "null"] } as const;
const closed = (required: readonly string[], properties: Record<string, unknown>) => ({
  type: "object", additionalProperties: false, required, properties,
});
const warningSchema = closed(["code", "field", "message"], {
  code: { type: "string", enum: ["AMBIGUOUS_PERSON", "UNRESOLVED_PERSON", "INVALID_INFERRED_VALUE", "UNSUPPORTED_DETAIL"] },
  field: nullableString,
  message: { type: "string", minLength: 1, maxLength: 500 },
});
const readyCommon = {
  status: { const: "ready" },
  missingFields: { type: "array", maxItems: 32, items: { type: "string" } },
  warnings: { type: "array", maxItems: 32, items: warningSchema },
};
const readySchema = (kind: CreationKind, draft: unknown) => closed(
  ["status", "kind", "draft", "missingFields", "warnings"],
  { ...readyCommon, kind: { const: kind }, draft },
);

export const CREATION_DRAFT_JSON_SCHEMA = {
  name: "lifespace_creation_draft",
  strict: true,
  schema: closed(["result"], {
    result: {
      anyOf: [
        closed(["status", "candidateKinds"], {
          status: { const: "choose_kind" },
          candidateKinds: { type: "array", minItems: 2, maxItems: 4, uniqueItems: true, items: { type: "string", enum: CREATION_KINDS } },
        }),
        readySchema("event", closed([
          "summary", "description", "isAllDay", "startDate", "endDate", "endDateExclusive",
          "startTime", "endTime", "startTimezone", "endTimezone", "location", "attendeeRefs",
        ], {
          summary: { type: ["string", "null"], maxLength: 100 },
          description: { type: ["string", "null"], maxLength: 5000 },
          isAllDay: { type: ["boolean", "null"] },
          startDate: nullableString, endDate: nullableString, endDateExclusive: nullableString,
          startTime: nullableString, endTime: nullableString, startTimezone: nullableString, endTimezone: nullableString,
          location: { type: ["string", "null"], maxLength: 500 },
          attendeeRefs: { type: "array", maxItems: 64, items: { type: "string" } },
        })),
        readySchema("task", closed(["name", "description", "dueDate", "assigneeRefs"], {
          name: { type: ["string", "null"], maxLength: 100 },
          description: { type: ["string", "null"], maxLength: 5000 },
          dueDate: nullableString,
          assigneeRefs: { type: "array", maxItems: 64, items: { type: "string" } },
        })),
        readySchema("day_record", closed([
          "dayRecordKind", "name", "description", "anchorDate", "subjectPersonRef", "icon",
          "attentionAfterDays", "attentionBeforeDays", "cycleDays",
        ], {
          dayRecordKind: { type: ["string", "null"], enum: ["elapsed", "countdown", "cycle", null] },
          name: { type: ["string", "null"], maxLength: 100 },
          description: { type: ["string", "null"], maxLength: 5000 },
          anchorDate: nullableString, subjectPersonRef: nullableString,
          icon: { type: ["string", "null"], maxLength: 50 },
          attentionAfterDays: nullableInteger, attentionBeforeDays: nullableInteger, cycleDays: nullableInteger,
        })),
        readySchema("wish", closed(["title", "description", "desiredDate"], {
          title: { type: ["string", "null"], maxLength: 100 },
          description: { type: ["string", "null"], maxLength: 5000 },
          desiredDate: nullableString,
        })),
      ],
    },
  }),
} as const;

type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CreationDraftInvalidResponseError();
  return value as ObjectValue;
}
function stringOrNull(value: unknown): string | null {
  if (value === null || typeof value === "string") return value;
  throw new CreationDraftInvalidResponseError();
}
function integerOrNull(value: unknown): number | null {
  if (value === null || (typeof value === "number" && Number.isInteger(value))) return value;
  throw new CreationDraftInvalidResponseError();
}
function stringArray(value: unknown, max = 64): string[] {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string")) throw new CreationDraftInvalidResponseError();
  return [...new Set(value)];
}
function validDate(value: string): boolean {
  const match = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!match) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function validTime(value: string): boolean { return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value); }
function validTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date(0)); return true; } catch { return false; }
}
function warning(code: DraftWarningCode, field: string | null): DraftWarning {
  const messages: Record<DraftWarningCode, string> = {
    AMBIGUOUS_PERSON: "The referenced person is ambiguous.",
    UNRESOLVED_PERSON: "The referenced person could not be resolved.",
    INVALID_INFERRED_VALUE: "An invalid inferred value was discarded.",
    UNSUPPORTED_DETAIL: "An explicit detail could not be represented.",
  };
  return { code, field, message: messages[code] };
}
function common(value: ObjectValue): { missingFields: string[]; warnings: DraftWarning[] } {
  const missingFields = stringArray(value.missingFields, 32);
  if (!Array.isArray(value.warnings) || value.warnings.length > 32) throw new CreationDraftInvalidResponseError();
  const warnings = value.warnings.map((raw): DraftWarning => {
    const item = object(raw);
    const code = item.code;
    if (!["AMBIGUOUS_PERSON", "UNRESOLVED_PERSON", "INVALID_INFERRED_VALUE", "UNSUPPORTED_DETAIL"].includes(String(code))) throw new CreationDraftInvalidResponseError();
    if (item.field !== null && typeof item.field !== "string") throw new CreationDraftInvalidResponseError();
    if (typeof item.message !== "string" || !item.message || item.message.length > 500) throw new CreationDraftInvalidResponseError();
    return { code: code as DraftWarningCode, field: item.field as string | null, message: item.message };
  });
  return { missingFields, warnings };
}
function markMissing(list: string[], field: string) { if (!list.includes(field)) list.push(field); }
function validateNullable(
  value: string | null, field: string, validator: (value: string) => boolean,
  warnings: DraftWarning[], missingFields: string[], required = false,
): string | null {
  if (value === null) { if (required) markMissing(missingFields, field); return null; }
  if (validator(value)) return value;
  warnings.push(warning("INVALID_INFERRED_VALUE", field));
  if (required) markMissing(missingFields, field);
  return null;
}
function resolvePerson(
  ref: string | null, field: string, people: ActivePersonRef[], warnings: DraftWarning[], missingFields: string[], required = false,
): string | null {
  if (ref === null) { if (required) markMissing(missingFields, field); return null; }
  const matches = people.filter((person) => person.ref === ref);
  if (matches.length === 1) return matches[0]!.personId;
  warnings.push(warning(matches.length > 1 ? "AMBIGUOUS_PERSON" : "UNRESOLVED_PERSON", field));
  if (required) markMissing(missingFields, field);
  return null;
}
function resolvePeople(refs: string[], field: string, people: ActivePersonRef[], warnings: DraftWarning[], missingFields: string[]): string[] {
  const result: string[] = [];
  for (const ref of refs) {
    const resolved = resolvePerson(ref, field, people, warnings, missingFields, false);
    if (resolved) result.push(resolved);
  }
  return [...new Set(result)];
}
function limit(value: string | null, max: number, field: string, warnings: DraftWarning[], missing: string[], required = false) {
  return validateNullable(value, field, (item) => item.length <= max, warnings, missing, required);
}
function nonNegative(value: number | null, field: string, warnings: DraftWarning[]): number | null {
  if (value === null || value >= 0) return value;
  warnings.push(warning("INVALID_INFERRED_VALUE", field));
  return null;
}

export function normalizeCreationDraftOutput(
  input: unknown,
  options: { people: ActivePersonRef[]; spaceToday: string; targetKind?: CreationKind; supportedKinds?: readonly CreationKind[] },
): NormalizedCreationDraft {
  if (!validDate(options.spaceToday)) throw new Error("spaceToday must be YYYY-MM-DD");
  const supported = new Set(options.supportedKinds ?? CREATION_KINDS);
  const envelope = object(input);

  if (envelope.status === "choose_kind") {
    if (options.targetKind) throw new CreationDraftInvalidResponseError();
    const candidates = stringArray(envelope.candidateKinds, 4) as CreationKind[];
    if (candidates.length < 2 || candidates.some((kind) => !CREATION_KINDS.includes(kind) || !supported.has(kind))) throw new CreationDraftInvalidResponseError();
    return { status: "choose_kind", candidateKinds: candidates };
  }

  if (envelope.status !== "ready" || !CREATION_KINDS.includes(envelope.kind as CreationKind)) throw new CreationDraftInvalidResponseError();
  const kind = envelope.kind as CreationKind;
  if (!supported.has(kind) || (options.targetKind && options.targetKind !== kind)) throw new CreationDraftInvalidResponseError();
  const draft = object(envelope.draft);
  const parsed = common(envelope);
  const missingFields = [...parsed.missingFields];
  const warnings = [...parsed.warnings];

  if (kind === "event") {
    if (draft.isAllDay !== null && typeof draft.isAllDay !== "boolean") throw new CreationDraftInvalidResponseError();
    const isAllDay = draft.isAllDay as boolean | null;
    if (isAllDay === null) markMissing(missingFields, "isAllDay");
    const result: EventFormDraft = {
      summary: limit(stringOrNull(draft.summary), 100, "summary", warnings, missingFields, true),
      description: limit(stringOrNull(draft.description), 5000, "description", warnings, missingFields),
      isAllDay,
      startDate: validateNullable(stringOrNull(draft.startDate), "startDate", validDate, warnings, missingFields, true),
      endDate: validateNullable(stringOrNull(draft.endDate), "endDate", validDate, warnings, missingFields, isAllDay === false),
      endDateExclusive: validateNullable(stringOrNull(draft.endDateExclusive), "endDateExclusive", validDate, warnings, missingFields, isAllDay === true),
      startTime: validateNullable(stringOrNull(draft.startTime), "startTime", validTime, warnings, missingFields, isAllDay === false),
      endTime: validateNullable(stringOrNull(draft.endTime), "endTime", validTime, warnings, missingFields, isAllDay === false),
      startTimezone: validateNullable(stringOrNull(draft.startTimezone), "startTimezone", validTimezone, warnings, missingFields, isAllDay === false),
      endTimezone: validateNullable(stringOrNull(draft.endTimezone), "endTimezone", validTimezone, warnings, missingFields, isAllDay === false),
      location: limit(stringOrNull(draft.location), 500, "location", warnings, missingFields),
      attendeePersonIds: resolvePeople(stringArray(draft.attendeeRefs), "attendeePersonIds", options.people, warnings, missingFields),
    };
    return { status: "ready", kind, draft: result, missingFields: missingFields.slice(-32), warnings: warnings.slice(-32) };
  }

  if (kind === "task") {
    const result: TaskFormDraft = {
      name: limit(stringOrNull(draft.name), 100, "name", warnings, missingFields, true),
      description: limit(stringOrNull(draft.description), 5000, "description", warnings, missingFields),
      dueDate: validateNullable(stringOrNull(draft.dueDate), "dueDate", validDate, warnings, missingFields),
      assigneePersonIds: resolvePeople(stringArray(draft.assigneeRefs), "assigneePersonIds", options.people, warnings, missingFields),
    };
    return { status: "ready", kind, draft: result, missingFields: missingFields.slice(-32), warnings: warnings.slice(-32) };
  }

  if (kind === "day_record") {
    const dayRecordKind = draft.dayRecordKind;
    if (dayRecordKind !== null && !["elapsed", "countdown", "cycle"].includes(String(dayRecordKind))) throw new CreationDraftInvalidResponseError();
    if (dayRecordKind === null) markMissing(missingFields, "dayRecordKind");
    let cycleDays = nonNegative(integerOrNull(draft.cycleDays), "cycleDays", warnings);
    if (dayRecordKind === "cycle" && (!cycleDays || cycleDays < 1)) { cycleDays = null; markMissing(missingFields, "cycleDays"); }
    const result: DayRecordFormDraft = {
      dayRecordKind: dayRecordKind as DayRecordFormDraft["dayRecordKind"],
      name: limit(stringOrNull(draft.name), 100, "name", warnings, missingFields, true),
      description: limit(stringOrNull(draft.description), 5000, "description", warnings, missingFields),
      anchorDate: validateNullable(stringOrNull(draft.anchorDate), "anchorDate", validDate, warnings, missingFields, true),
      subjectPersonId: resolvePerson(stringOrNull(draft.subjectPersonRef), "subjectPersonId", options.people, warnings, missingFields),
      icon: limit(stringOrNull(draft.icon), 50, "icon", warnings, missingFields),
      attentionAfterDays: nonNegative(integerOrNull(draft.attentionAfterDays), "attentionAfterDays", warnings),
      attentionBeforeDays: nonNegative(integerOrNull(draft.attentionBeforeDays), "attentionBeforeDays", warnings),
      cycleDays,
    };
    return { status: "ready", kind, draft: result, missingFields: missingFields.slice(-32), warnings: warnings.slice(-32) };
  }

  const result: WishFormDraft = {
    title: limit(stringOrNull(draft.title), 100, "title", warnings, missingFields, true),
    description: limit(stringOrNull(draft.description), 5000, "description", warnings, missingFields),
    desiredDate: validateNullable(stringOrNull(draft.desiredDate), "desiredDate", validDate, warnings, missingFields),
  };
  return { status: "ready", kind: "wish", draft: result, missingFields: missingFields.slice(-32), warnings: warnings.slice(-32) };
}
