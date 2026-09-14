import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings, Principal } from "../src/env";
import {
  createGenericResource,
  getGenericResource,
  listGenericResources,
  updateGenericResource,
  type GenericResource,
} from "../src/generic-resource";
import { getPublishedModel } from "../src/model-registry";
import {
  provenanceMutationExtension,
  validateInformationProvenance,
  type InformationProvenance,
} from "../src/resource-provenance";

type TestEnv = { DB: D1Database };
type ResourceWithProvenance = GenericResource & { provenance?: InformationProvenance };

function bindings(): Bindings {
  return { DB: (env as unknown as TestEnv).DB } as Bindings;
}

const actor: Principal = {
  type: "user",
  id: "usr_resource_provenance_test",
  clientId: "homemew-miniprogram",
  scopes: ["resources:read", "resources:write"],
  tokenId: "tok_resource_provenance_test",
};

async function fixture() {
  const db = (env as unknown as TestEnv).DB;
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const spaceId = `spc_${suffix}`;
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
    VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "family", "Provenance Test", actor.id, now, now, "Asia/Shanghai").run();
  const model = await getPublishedModel(bindings(), "task");
  if (!model) throw new Error("bootstrap Task model is missing");
  return { db, spaceId, model };
}

describe("Information Provenance", () => {
  it("validates structured record and external references", () => {
    expect(validateInformationProvenance({
      source: "document_extraction",
      sourceRef: { type: "external", system: "medical-report", ref: "report-2026-09-11#p12" },
      derivedFrom: [{ type: "record", recordId: "rec_upstream", version: 2 }],
    })).toEqual({
      source: "document_extraction",
      sourceRef: { type: "external", system: "medical-report", ref: "report-2026-09-11#p12" },
      derivedFrom: [{ type: "record", recordId: "rec_upstream", version: 2 }],
    });

    expect(() => validateInformationProvenance({ source: "", sourceRef: { type: "url", ref: "x" } }))
      .toThrowError(expect.objectContaining({ code: "INVALID_PROVENANCE" }));
  });

  it("returns effective provenance from single GET, inherits it across ordinary updates, and replaces it explicitly", async () => {
    const { db, spaceId, model } = await fixture();
    const initial: InformationProvenance = {
      source: "ai_estimation",
      sourceRef: { type: "external", system: "aloha", ref: "upload/img_001" },
    };
    const created = await createGenericResource(
      bindings(),
      actor,
      spaceId,
      model,
      { name: "Provenance task" },
      false,
      provenanceMutationExtension(initial),
    );

    const first = await getGenericResource(bindings(), spaceId, model, created.id) as ResourceWithProvenance;
    expect(first.provenance).toEqual(initial);

    await updateGenericResource(bindings(), actor, spaceId, model, created.id, 1, { name: "Inherited provenance" });
    const inherited = await getGenericResource(bindings(), spaceId, model, created.id) as ResourceWithProvenance;
    expect(inherited.version).toBe(2);
    expect(inherited.provenance).toEqual(initial);

    const replacement: InformationProvenance = {
      source: "user_correction",
      sourceRef: { type: "external", system: "aloha", ref: "conversation/correction-1" },
      derivedFrom: [{ type: "record", recordId: created.id, version: 2 }],
    };
    await updateGenericResource(
      bindings(),
      actor,
      spaceId,
      model,
      created.id,
      2,
      { name: "Replaced provenance" },
      "client",
      provenanceMutationExtension(replacement),
    );
    const replaced = await getGenericResource(bindings(), spaceId, model, created.id) as ResourceWithProvenance;
    expect(replaced.version).toBe(3);
    expect(replaced.provenance).toEqual(replacement);

    const provenanceVersions = await db.prepare(`SELECT record_version FROM resource_provenance
      WHERE record_id=? ORDER BY record_version`).bind(created.id).all<{ record_version: number }>();
    expect(provenanceVersions.results.map((row) => row.record_version)).toEqual([1, 3]);

    const listed = await listGenericResources(bindings(), spaceId, model);
    const listedResource = listed.find((resource) => resource.id === created.id) as ResourceWithProvenance | undefined;
    expect(listedResource).toBeDefined();
    expect(listedResource?.provenance).toBeUndefined();
  });
});
