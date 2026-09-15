import { describe, expect, it } from "vitest";
import type { ModelDefinition } from "../src/model-definition";
import { physicalPublicationStatements } from "../src/model-physical-publication";
import { compileCompatiblePhysicalChange, compilePhysicalSchema } from "../src/physical-schema";

function taskDefinition(): ModelDefinition {
  return {
    definitionVersion: 1,
    key: "task",
    display: { singular: "Task", plural: "Tasks" },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
    fields: {
      name: { type: "string", required: true, maxLength: 100 },
      description: { type: "text", nullable: true, maxLength: 5000 },
      dueDate: { type: "date", nullable: true },
      status: { type: "enum", required: true, values: ["pending", "completed", "cancelled"] },
      assigneePersonIds: { type: "person_list" },
    },
    query: {
      searchable: ["name", "description"],
      filterable: ["status", "dueDate", "assigneePersonIds"],
      sortable: ["dueDate", "name"],
    },
  };
}

describe("Physical Schema Compiler", () => {
  it("builds a deterministic typed model table and indexes only scalar query fields", () => {
    const plan = compilePhysicalSchema(taskDefinition());
    expect(plan.tableName).toBe("mdl_task");
    expect(plan.columns.map((column) => [column.fieldKey, column.sqlType, column.nullable])).toEqual([
      ["name", "TEXT", false],
      ["description", "TEXT", true],
      ["dueDate", "TEXT", true],
      ["status", "TEXT", false],
    ]);
    expect(plan.relationFields).toEqual(["assigneePersonIds"]);
    expect(plan.indexes.map((index) => index.fieldKey)).toEqual(["dueDate", "name", "status"]);
    expect(plan.createTableSql).toContain('CREATE TABLE "mdl_task"');
    expect(plan.createTableSql).toContain('"status" TEXT NOT NULL CHECK("status" IS NULL OR "status" IN (\'pending\',\'completed\',\'cancelled\'))');
    expect(plan.createIndexSql).toContain('CREATE INDEX "idx_mdl_task_dueDate" ON "mdl_task"(space_id,"dueDate",record_id)');
  });

  it("allows additive nullable scalar fields and indexes", () => {
    const previous = taskDefinition();
    const next: ModelDefinition = {
      ...previous,
      fields: {
        ...previous.fields,
        priority: { type: "integer", nullable: true },
      },
      query: {
        ...previous.query,
        filterable: [...(previous.query?.filterable ?? []), "priority"],
      },
    };
    const plan = compileCompatiblePhysicalChange(previous, next);
    expect(plan.addedColumns.map((column) => column.fieldKey)).toEqual(["priority"]);
    expect(plan.addedIndexes.map((index) => index.fieldKey)).toEqual(["priority"]);
    expect(plan.statements).toEqual([
      'ALTER TABLE "mdl_task" ADD COLUMN "priority" INTEGER',
      'CREATE INDEX "idx_mdl_task_priority" ON "mdl_task"(space_id,"priority",record_id)',
    ]);
  });

  it("rejects required additions and type rewrites without an explicit migration plan", () => {
    const previous = taskDefinition();
    expect(() => compileCompatiblePhysicalChange(previous, {
      ...previous,
      fields: { ...previous.fields, priority: { type: "integer", required: true } },
    })).toThrow(/explicit backfill\/default migration plan/);

    expect(() => compileCompatiblePhysicalChange(previous, {
      ...previous,
      fields: { ...previous.fields, dueDate: { type: "datetime", nullable: true } },
    })).toThrow(/data-rewriting physical migration/);
  });

  it("maps temporal_range to deterministic internal columns with composite integrity checks", () => {
    const definition: ModelDefinition = {
      ...taskDefinition(),
      key: "appointment",
      fields: {
        name: { type: "string", required: true },
        when: { type: "temporal_range", nullable: true },
      },
      query: { searchable: ["name"] },
    };

    const plan = compilePhysicalSchema(definition);
    expect(plan.fieldMappings.map((mapping) => [
      mapping.fieldKey,
      mapping.storage,
      mapping.columns.map((column) => column.fieldKey),
    ])).toEqual([
      ["name", "scalar", ["name"]],
      ["when", "temporal_range", ["__tr_when_kind", "__tr_when_start", "__tr_when_end"]],
    ]);
    expect(plan.columns.map((column) => [
      column.fieldKey,
      column.logicalFieldKey,
      column.component,
      column.sqlType,
      column.nullable,
    ])).toEqual([
      ["name", "name", "value", "TEXT", false],
      ["__tr_when_kind", "when", "kind", "TEXT", true],
      ["__tr_when_start", "when", "start", "TEXT", true],
      ["__tr_when_end", "when", "end", "TEXT", true],
    ]);
    expect(plan.createTableSql).toContain(
      '"__tr_when_kind" TEXT CHECK("__tr_when_kind" IS NULL OR "__tr_when_kind" IN (\'date\',\'instant\'))',
    );
    expect(plan.createTableSql).toContain(
      '"__tr_when_end" TEXT CHECK(("__tr_when_kind" IS NULL AND "__tr_when_start" IS NULL AND "__tr_when_end" IS NULL) OR',
    );
  });

  it("adds an optional temporal_range as three columns and rejects required additions", () => {
    const previous = taskDefinition();
    const next: ModelDefinition = {
      ...previous,
      fields: {
        ...previous.fields,
        window: { type: "temporal_range", nullable: true },
      },
    };

    const plan = compileCompatiblePhysicalChange(previous, next);
    expect(plan.addedMappings.map((mapping) => [mapping.fieldKey, mapping.storage])).toEqual([
      ["window", "temporal_range"],
    ]);
    expect(plan.addedColumns.map((column) => column.fieldKey)).toEqual([
      "__tr_window_kind",
      "__tr_window_start",
      "__tr_window_end",
    ]);
    expect(plan.statements).toHaveLength(3);
    expect(plan.statements[2]).toContain('ALTER TABLE "mdl_task" ADD COLUMN "__tr_window_end" TEXT CHECK(');

    expect(() => compileCompatiblePhysicalChange(previous, {
      ...previous,
      fields: {
        ...previous.fields,
        window: { type: "temporal_range", required: true },
      },
    })).toThrow(/Required field window needs an explicit backfill\/default migration plan/);
  });

  it("keeps temporal_range query indexes and publication closed until their dependent slices", () => {
    const definition: ModelDefinition = {
      ...taskDefinition(),
      key: "appointment",
      fields: {
        when: { type: "temporal_range", nullable: true },
      },
      query: { filterable: ["when"] },
    };
    expect(() => compilePhysicalSchema(definition)).toThrow(
      "requires the temporal_range query/index implementation",
    );

    const publishableShape: ModelDefinition = {
      ...definition,
      query: undefined,
    };
    expect(() => physicalPublicationStatements(
      { DB: { prepare: () => { throw new Error("must not reach D1"); } } } as any,
      null,
      publishableShape,
    )).toThrow("cannot be published until temporal_range CRUD hydration is implemented");
  });

});

