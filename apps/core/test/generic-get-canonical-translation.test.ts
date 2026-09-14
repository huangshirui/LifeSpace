import { describe, expect, it } from "vitest";
import { TASK_MODEL_DEFINITION } from "../src/builtin-models";
import { hasLegacyGenericCursor, translateGenericGetQuery } from "../src/generic-query";
import type { PublishedModel } from "../src/model-registry";

function taskModel(): PublishedModel {
  return {
    id: "mdl_task",
    key: "task",
    version: 1,
    state: "published",
    schemaHash: "a".repeat(64),
    compatibility: "initial",
    definition: TASK_MODEL_DEFINITION,
    publishedAt: "2026-01-01T00:00:00.000Z",
  };
}

function cursor(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

describe("legacy Generic GET to Canonical Query translation", () => {
  it("lowers search, enum sets, typed comparisons, relations, ordered sort and pagination", () => {
    const params = new URLSearchParams();
    params.set("q", "  school  ");
    params.set("status", "pending,completed");
    params.set("dueDateFrom", "2026-09-14");
    params.set("dueDate.lt", "2026-09-21");
    params.set("assigneePersonIds", "per_123");
    params.append("sort", "dueDate:asc");
    params.append("sort", "name:desc");
    params.set("limit", "20");

    expect(translateGenericGetQuery(taskModel(), params)).toEqual({
      search: { text: "school" },
      filter: {
        and: [
          { field: "dueDate", op: "gte", value: "2026-09-14" },
          { field: "dueDate", op: "lt", value: "2026-09-21" },
          {
            or: [
              { field: "status", op: "eq", value: "pending" },
              { field: "status", op: "eq", value: "completed" },
            ],
          },
          { field: "assigneePersonIds", op: "contains", value: "per_123" },
        ],
      },
      sort: [
        { field: "dueDate", direction: "asc" },
        { field: "name", direction: "desc" },
      ],
      page: { limit: 20, cursor: null },
    });
  });

  it("lowers an envelope local-date window without resolving away its viewing timezone", () => {
    const params = new URLSearchParams({
      "createdAt.dateStart": "2026-03-29",
      "createdAt.dateEndExclusive": "2026-03-30",
      "createdAt.timezone": "Europe/Amsterdam",
    });

    expect(translateGenericGetQuery(taskModel(), params).filter).toEqual({
      field: "createdAt",
      op: "within",
      value: {
        kind: "local_date_window",
        startDate: "2026-03-29",
        endDateExclusive: "2026-03-30",
        timezone: "Europe/Amsterdam",
      },
    });
  });

  it("keeps pre-canonical Generic cursor versions on the compatibility executor", () => {
    expect(hasLegacyGenericCursor(new URLSearchParams({
      cursor: cursor({ v: 1, model: "task", sort: "createdAt:desc", key: "x", id: "rec_1", signature: "[]" }),
    }))).toBe(true);
    expect(hasLegacyGenericCursor(new URLSearchParams({
      cursor: cursor({ v: 2, model: "task", sorts: ["createdAt:desc"], keys: ["x"], id: "rec_1", signature: "[]" }),
    }))).toBe(true);
    expect(hasLegacyGenericCursor(new URLSearchParams({
      cursor: cursor({ v: 3, model: "task", sorts: ["createdAt:desc"], keys: ["x"], id: "rec_1", signature: "[]" }),
    }))).toBe(false);
  });

  it("preserves legacy alias collision validation", () => {
    expect(() => translateGenericGetQuery(taskModel(), new URLSearchParams({
      dueDateFrom: "2026-09-14",
      "dueDate.gte": "2026-09-14",
    }))).toThrow(/aliases for the same gte operator/u);
  });
});
