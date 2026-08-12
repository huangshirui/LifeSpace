import { describe, expect, it } from "vitest";
import type { ModelDefinition } from "../src/model-definition";
import { compileCompatiblePhysicalChange, compilePhysicalSchema } from "../src/physical-schema";

function taskDefinition(): ModelDefinition {
  return {
    definitionVersion: 1,
    key: "task",
    route: "tasks",
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
});
