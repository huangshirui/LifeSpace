import { describe, expect, it } from "vitest";
import { ANNIVERSARY_MODEL_DEFINITION, ACTIVITY_MODEL_DEFINITION, GOAL_MODEL_DEFINITION, PERSON_PROFILE_MODEL_DEFINITION, HABIT_MODEL_DEFINITION } from "../src/builtin-models";
import { validateDefinition } from "../src/model-registry";
import { compilePhysicalSchema } from "../src/physical-schema";

const added = [ANNIVERSARY_MODEL_DEFINITION, ACTIVITY_MODEL_DEFINITION, GOAL_MODEL_DEFINITION, PERSON_PROFILE_MODEL_DEFINITION, HABIT_MODEL_DEFINITION];

describe("new shipped baseline domain models", () => {
  it("has valid descriptions and reproducible typed schemas", async () => {
    for (const definition of added) {
      const checked = await validateDefinition(definition);
      expect(checked.valid, definition.key).toBe(true);
      expect(definition.description?.length).toBeGreaterThan(50);
      for (const field of Object.values(definition.fields)) expect(field.description?.length).toBeGreaterThan(20);
      const plan = compilePhysicalSchema(definition);
      expect(plan.tableName).toBe("mdl_" + definition.key);
      expect(plan.createTableSql).toContain("resource_records(id)");
    }
  });
  it("retains documented domain semantics and Core-owned Check-in", () => {
    expect(ACTIVITY_MODEL_DEFINITION.semanticRelations?.outgoing).toContain("relates_to");
    expect(GOAL_MODEL_DEFINITION.fields.subjectPersonIds.type).toBe("person_list");
    expect(ANNIVERSARY_MODEL_DEFINITION.fields.year.nullable).toBe(true);
    expect(PERSON_PROFILE_MODEL_DEFINITION.fields.personId.immutable).toBe(true);
    expect(HABIT_MODEL_DEFINITION.capabilities?.checkIn).toEqual({ intervalDaysField: "intervalDays", lastCheckInDateField: "lastCheckInDate", streakStartDateField: "streakStartDate" });
    expect(HABIT_MODEL_DEFINITION.fields.intervalDays.immutable).toBe(true);
    expect(HABIT_MODEL_DEFINITION.fields.lastCheckInDate.readOnly).toBe(true);
    expect(HABIT_MODEL_DEFINITION.fields.streakStartDate.readOnly).toBe(true);
  });
});
