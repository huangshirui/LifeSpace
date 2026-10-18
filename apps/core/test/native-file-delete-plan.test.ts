import { describe, expect, it } from "vitest";
import type { Bindings, Principal } from "../src/env";
import type { PublishedModel } from "../src/model-registry";
import { planDeleteGenericMutation, type GenericResource } from "../src/generic-resource";

describe("Native File links on Record deletion", () => {
  it("atomically releases File links before clearing the Record mutation token", () => {
    const queries: string[] = [];
    const env = { DB: { prepare(sql: string) {
      queries.push(sql);
      return { bind: (..._args: unknown[]) => ({}) };
    } } } as unknown as Bindings;
    const principal = { type: "user", id: "usr_test", clientId: "app_test" } as Principal;
    const model = { key: "document", version: 1 } as PublishedModel;
    const previous = {
      id: "rec_test", spaceId: "spc_test", modelKey: "document", version: 1, data: {},
      createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T00:00:00Z",
    } as GenericResource;

    planDeleteGenericMutation(env, principal, "spc_test", model, previous, 1);
    const fileIndex = queries.findIndex(sql => sql.includes("DELETE FROM resource_file_links"));
    const tokenClearIndex = queries.findIndex(sql => sql.includes("SET mutation_token=NULL"));
    const softDeleteIndex = queries.findIndex(sql => sql.includes("deleted_at=?"));
    expect(fileIndex).toBeGreaterThan(softDeleteIndex);
    expect(fileIndex).toBeLessThan(tokenClearIndex);
    expect(queries[fileIndex]).toContain("mutation_token=?");
  });
});
