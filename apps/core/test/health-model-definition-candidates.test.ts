import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateDefinition } from "../src/model-registry";
import { compilePhysicalSchema } from "../src/physical-schema";

const root = fileURLToPath(new URL("../../../examples/model-definitions/aloha-health/", import.meta.url));
const names = [
  "health_metric", "health_concern", "health_event", "health_document",
  "health_observation", "health_regimen", "health_assessment",
] as const;
const expectedFields: Record<string,string[]> = {
  health_metric:["name","valueType","defaultUnit","referenceLow","referenceHigh","referenceSource"],
  health_concern:["subjectPersonId","name","summary","status","onsetDate","resolvedDate","notes"],
  health_event:["subjectPersonId","eventType","summary","when","status","location","description"],
  health_document:["subjectPersonId","title","documentType","issuedDate","issuerName","eventId","artifactRef","notes"],
  health_observation:["subjectPersonId","metricId","observedDate","valueNumber","valueText","valueBoolean","unit","referenceLow","referenceHigh","referenceSource","observationGroupId","sourceDocumentId","notes"],
  health_regimen:["subjectPersonId","name","regimenType","instructions","startDate","endDate","status","sourceDocumentId","sourceNote","notes","recurrence","firstDueDate"],
  health_assessment:["subjectPersonId","title","content","assessedDate","status","sourceNote","notes"],
};
const load = (key:string) => JSON.parse(readFileSync(root + key + ".json", "utf8"));

describe("ALOHA Health draft model candidates (not published)", () => {
  it("passes Model Definition validation and compiles native typed schemas", async () => {
    for (const key of names) {
      const definition = load(key);
      const checked = await validateDefinition(definition);
      expect(checked.valid, key + ": " + JSON.stringify(checked)).toBe(true);
      expect(compilePhysicalSchema(definition).tableName).toBe("mdl_" + key);
    }
  });

  it("preserves seven published-contract candidates, structural fields and Agent semantics", () => {
    for (const key of names) {
      const definition = load(key);
      expect(Object.keys(definition.fields), key).toEqual(expectedFields[key]);
      expect(definition.description.length).toBeGreaterThan(30);
      expect(definition.description.length).toBeLessThanOrEqual(180);
      expect(definition.display.singular).toMatch(/[\u4e00-\u9fa5]/u);
      expect(definition.display.plural).toMatch(/[\u4e00-\u9fa5]/u);
      expect(definition.lifecycle).toBeUndefined(); // v1 Runtime invariants, not model-specific knobs
      for (const field of Object.values(definition.fields) as Array<{description?:string}>) {
        if (field.description) expect(field.description.length).toBeLessThanOrEqual(160);
      }
    }
    const observation = load("health_observation");
    expect(observation.fields).not.toHaveProperty("status");
    expect(observation.fields).not.toHaveProperty("interpretation");
    expect(observation.fields).not.toHaveProperty("sourceNote");
    expect(observation.fields.metricId.targetModel).toBe("health_metric");
    expect(observation.fields.sourceDocumentId.targetModel).toBe("health_document");
    expect(observation.fields.valueBoolean.description).toContain("false 是有效结果");
    expect(load("health_document").fields.artifactRef).toMatchObject({type:"file",required:true,immutable:true});
    expect(load("health_event").fields.when.type).toBe("temporal_range");
    expect(load("health_concern").semanticRelations.outgoing).toEqual(["monitors","relates_to"]);
    expect(load("health_assessment").semanticRelations.outgoing).toEqual(["based_on"]);
    const regimen = load("health_regimen");
    expect(regimen.fields.recurrence.type).toBe("recurrence_rule");
    expect(regimen.capabilities.recurrence).toEqual({
      ruleField:"recurrence",firstDueDateField:"firstDueDate",statusField:"status",
      endDateField:"endDate",
      task:{nameField:"name",descriptionField:"instructions",subjectField:"subjectPersonId"},
    });
  });
});
