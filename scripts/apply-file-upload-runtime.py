from pathlib import Path
import json


def replace(path, old, new, count=1):
    p=Path(path); s=p.read_text(); n=s.count(old)
    if n < count: raise SystemExit(f'{path}: expected {count} occurrences, found {n}: {old[:120]!r}')
    p.write_text(s.replace(old,new,count))

# Migration 0066
Path('apps/core/migrations/0066_file_upload_capability.sql').write_text(r'''-- First-class LifeSpace-owned File metadata and bounded upload sessions.
CREATE TABLE files (
  id TEXT PRIMARY KEY CHECK(length(id)=36 AND id GLOB 'fil_[0-9a-f]*'),
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 512),
  content_type TEXT NOT NULL CHECK(length(content_type) BETWEEN 1 AND 255),
  size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
  object_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('ready')),
  application_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_files_space_created ON files(space_id, created_at DESC);

CREATE TABLE resource_file_links (
  source_record_id TEXT NOT NULL REFERENCES resource_records(id) ON DELETE CASCADE,
  source_space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  source_model_key TEXT NOT NULL,
  field_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  PRIMARY KEY(source_record_id, field_key, ordinal),
  UNIQUE(source_record_id, field_key, file_id)
);
CREATE INDEX idx_resource_file_links_file ON resource_file_links(file_id);
CREATE INDEX idx_resource_file_links_source ON resource_file_links(source_space_id, source_model_key, source_record_id);

CREATE TRIGGER trg_resource_file_links_insert_guard
BEFORE INSERT ON resource_file_links
BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM resource_records r
    JOIN files f ON f.id=NEW.file_id
    WHERE r.id=NEW.source_record_id
      AND r.space_id=NEW.source_space_id
      AND r.model_key=NEW.source_model_key
      AND r.deleted_at IS NULL
      AND f.space_id=NEW.source_space_id
      AND f.status='ready'
  ) THEN RAISE(ABORT, 'FILE_REFERENCE_INVALID') END;
END;

CREATE TABLE file_upload_sessions (
  id TEXT PRIMARY KEY CHECK(length(id)=36 AND id GLOB 'upl_[0-9a-f]*'),
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  model_key TEXT NOT NULL,
  field_key TEXT NOT NULL,
  record_id TEXT,
  destination TEXT NOT NULL CHECK(destination IN ('native','external')),
  file_id TEXT,
  object_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 512),
  content_type TEXT NOT NULL CHECK(length(content_type) BETWEEN 1 AND 255),
  expected_size INTEGER NOT NULL CHECK(expected_size > 0),
  status TEXT NOT NULL CHECK(status IN ('pending','executing','completed','failed','unknown','expired')),
  error_code TEXT,
  application_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  cleaned_at TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_file_upload_sessions_cleanup ON file_upload_sessions(status, expires_at, cleaned_at);
CREATE INDEX idx_file_upload_sessions_space ON file_upload_sessions(space_id, created_at DESC);

UPDATE schema_metadata SET value='66' WHERE key='schema_version';
''')

# Env + app registration
replace('apps/core/src/env.ts','  ASSETS: R2Bucket;\n  CORS_ORIGINS?: string;', '''  ASSETS: R2Bucket;\n  R2_S3_ACCOUNT_ID?: string;\n  R2_S3_ACCESS_KEY_ID?: string;\n  R2_S3_SECRET_ACCESS_KEY?: string;\n  R2_S3_BUCKET?: string;\n  CORS_ORIGINS?: string;''')
replace('apps/core/src/app.ts','import { registerGrantRoutes } from "./grants";', 'import { registerGrantRoutes } from "./grants";\nimport { registerFileRoutes } from "./file-routes";')
replace('apps/core/src/app.ts','  registerSpaceAvatarRoutes(app);\n  registerGrantRoutes(app);', '  registerSpaceAvatarRoutes(app);\n  registerFileRoutes(app);\n  registerGrantRoutes(app);')

# Generic resource file projections and referential integrity.
replace('apps/core/src/generic-resource.ts', '''export type PreparedCreateMutation = {\n  data: JsonObject;\n  relations: RelationProjection[];\n};''', '''export type FileProjection = {\n  fieldKey: string;\n  fileId: string;\n  ordinal: number;\n};\n\nexport type PreparedCreateMutation = {\n  data: JsonObject;\n  relations: RelationProjection[];\n  files: FileProjection[];\n};''')
replace('apps/core/src/generic-resource.ts', '''export type PreparedUpdateMutation = {\n  data: JsonObject;\n  relations: RelationProjection[];\n  changedFields: string[];''', '''export type PreparedUpdateMutation = {\n  data: JsonObject;\n  relations: RelationProjection[];\n  files: FileProjection[];\n  changedFields: string[];''')
anchor='''export async function validateRelationProjections(\n  env: Bindings,\n  spaceId: string,\n  relations: readonly RelationProjection[],\n): Promise<void> {\n  const [error] = await validateRelationProjectionGroups(env, spaceId, [relations]);\n  if (error) throw error;\n}\n'''
addition=anchor+r'''
export function collectFileProjections(
  definition: ModelDefinition,
  data: JsonObject,
): FileProjection[] {
  const files: FileProjection[] = [];
  for (const [fieldKey, field] of Object.entries(definition.fields)) {
    const value = data[fieldKey];
    if (value === undefined || value === null || (field.type !== "file" && field.type !== "file_list")) continue;
    const ids = field.type === "file_list" ? value as string[] : [value as string];
    ids.forEach((fileId, ordinal) => files.push({ fieldKey, fileId, ordinal }));
  }
  return files;
}

export async function validateFileProjectionGroups(
  env: Bindings,
  spaceId: string,
  groups: readonly (readonly FileProjection[])[],
): Promise<(ApiError | null)[]> {
  const ids = [...new Set(groups.flatMap((group) => group.map((entry) => entry.fileId)))];
  if (!ids.length) return groups.map(() => null);
  const found = new Set<string>();
  const statements = chunkD1Values(ids, 1).map((chunk) => env.DB.prepare(`SELECT id FROM files
    WHERE space_id=? AND status='ready' AND id IN (${chunk.map(() => "?").join(",")})`).bind(spaceId, ...chunk));
  const results = await env.DB.batch<{ id: string }>(statements);
  for (const result of results) for (const row of result.results ?? []) found.add(row.id);
  return groups.map((group) => group.some((entry) => !found.has(entry.fileId))
    ? new ApiError("INVALID_FILE_REFERENCE", "Every File reference must be a ready File in the same Space", 400)
    : null);
}

export async function validateFileProjections(env: Bindings, spaceId: string, files: readonly FileProjection[]): Promise<void> {
  const [error] = await validateFileProjectionGroups(env, spaceId, [files]);
  if (error) throw error;
}
'''
replace('apps/core/src/generic-resource.ts',anchor,addition)
replace('apps/core/src/generic-resource.ts','''  return {\n    data,\n    relations: collectRelationProjections(model.definition, data),\n  };''','''  return {\n    data,\n    relations: collectRelationProjections(model.definition, data),\n    files: collectFileProjections(model.definition, data),\n  };''',1)
replace('apps/core/src/generic-resource.ts','''  return {\n    data,\n    relations: collectRelationProjections(model.definition, data),\n    changedFields:''','''  return {\n    data,\n    relations: collectRelationProjections(model.definition, data),\n    files: collectFileProjections(model.definition, data),\n    changedFields:''',1)
# insert fileStatements after relationStatements function by anchoring next resolveModel
resolve_anchor='''async function resolveModel(env: Bindings, modelOrKey: PublishedModel | string): Promise<PublishedModel | null> {'''
file_fn=r'''function fileStatements(
  env: Bindings,
  recordId: string,
  spaceId: string,
  model: PublishedModel,
  files: FileProjection[],
  mutationToken?: string,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (mutationToken) {
    statements.push(env.DB.prepare(`DELETE FROM resource_file_links WHERE source_record_id=?
      AND EXISTS(SELECT 1 FROM resource_records WHERE id=? AND mutation_token=?)`).bind(recordId, recordId, mutationToken));
  }
  for (const file of files) {
    if (mutationToken) {
      statements.push(env.DB.prepare(`INSERT INTO resource_file_links(
        source_record_id,source_space_id,source_model_key,field_key,ordinal,file_id
      ) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM resource_records WHERE id=? AND mutation_token=?)`).bind(
        recordId, spaceId, model.key, file.fieldKey, file.ordinal, file.fileId, recordId, mutationToken,
      ));
    } else {
      statements.push(env.DB.prepare(`INSERT INTO resource_file_links(
        source_record_id,source_space_id,source_model_key,field_key,ordinal,file_id
      ) VALUES(?,?,?,?,?,?)`).bind(recordId, spaceId, model.key, file.fieldKey, file.ordinal, file.fileId));
    }
  }
  return statements;
}

'''
replace('apps/core/src/generic-resource.ts',resolve_anchor,file_fn+resolve_anchor)
replace('apps/core/src/generic-resource.ts','''    typedInsertStatement(env, model, id, spaceId, prepared.data),\n    ...relationStatements(env, id, spaceId, model, prepared.relations),''','''    typedInsertStatement(env, model, id, spaceId, prepared.data),\n    ...relationStatements(env, id, spaceId, model, prepared.relations),\n    ...fileStatements(env, id, spaceId, model, prepared.files),''')
replace('apps/core/src/generic-resource.ts','''    typedUpdateStatement(env, model, previous.id, spaceId, prepared.data, mutationToken),\n    ...relationStatements(env, previous.id, spaceId, model, prepared.relations, mutationToken),''','''    typedUpdateStatement(env, model, previous.id, spaceId, prepared.data, mutationToken),\n    ...relationStatements(env, previous.id, spaceId, model, prepared.relations, mutationToken),\n    ...fileStatements(env, previous.id, spaceId, model, prepared.files, mutationToken),''')
replace('apps/core/src/generic-resource.ts','''  await validateRelationProjections(env, spaceId, prepared.relations);\n  const plan = await planCreateGenericMutation(''','''  await validateRelationProjections(env, spaceId, prepared.relations);\n  await validateFileProjections(env, spaceId, prepared.files);\n  const plan = await planCreateGenericMutation(''')
replace('apps/core/src/generic-resource.ts','''  await validateRelationProjections(env, spaceId, prepared.relations);\n  const plan = await planUpdateGenericMutation(''','''  await validateRelationProjections(env, spaceId, prepared.relations);\n  await validateFileProjections(env, spaceId, prepared.files);\n  const plan = await planUpdateGenericMutation(''')

# Batch/Bulk/recurrence set-wise validation with no N+1.
for path in ['apps/core/src/generic-bulk-routes.ts','apps/core/src/native-model-batch.ts','apps/core/src/recurrence-runtime.ts']:
    p=Path(path); s=p.read_text()
    s=s.replace('validateRelationProjectionGroups,', 'validateRelationProjectionGroups, validateFileProjectionGroups,')
    # after a relationErrors.forEach line, derive parallel file groups from the same entry collection patterns below.
    p.write_text(s)

replace('apps/core/src/generic-bulk-routes.ts','''    relationErrors.forEach((error, offset) => { if (error) preparedItems[offset]!.error = error; });\n\n    await prepareRecurrenceMutations''','''    relationErrors.forEach((error, offset) => { if (error) preparedItems[offset]!.error = error; });\n    const fileGroups = preparedItems.map((item) => [\n      ...(item.prepared!.preparedCreate?.files ?? []),\n      ...(item.prepared!.preparedUpdate?.files ?? []),\n    ]);\n    const fileErrors = await validateFileProjectionGroups(context.env, spaceId, fileGroups);\n    fileErrors.forEach((error, offset) => { if (error) preparedItems[offset]!.error = error; });\n\n    await prepareRecurrenceMutations''')
# native-model-batch exact relation validation pattern
replace('apps/core/src/native-model-batch.ts','''  const relationErrors = await validateRelationProjectionGroups(env, spaceId, recordItems.map((item) =>\n    [...(item.prepared!.preparedCreate?.relations ?? []), ...(item.prepared!.preparedUpdate?.relations ?? [])]));\n  relationErrors.forEach((error, index) => { if (error) recordItems[index]!.error = error; });''','''  const relationErrors = await validateRelationProjectionGroups(env, spaceId, recordItems.map((item) =>\n    [...(item.prepared!.preparedCreate?.relations ?? []), ...(item.prepared!.preparedUpdate?.relations ?? [])]));\n  relationErrors.forEach((error, index) => { if (error) recordItems[index]!.error = error; });\n  const fileErrors = await validateFileProjectionGroups(env, spaceId, recordItems.map((item) =>\n    [...(item.prepared!.preparedCreate?.files ?? []), ...(item.prepared!.preparedUpdate?.files ?? [])]));\n  fileErrors.forEach((error, index) => { if (error) recordItems[index]!.error = error; });''')
# recurrence entries already calculate data; validate files alongside relation groups
replace('apps/core/src/recurrence-runtime.ts','''  const relationErrors = await validateRelationProjectionGroups(env, spaceId, relationGroups);\n  relationErrors.forEach((error, index) => { if (error) errors.set(relationEntries[index]!.recordId ?? "", error); });''','''  const relationErrors = await validateRelationProjectionGroups(env, spaceId, relationGroups);\n  relationErrors.forEach((error, index) => { if (error) errors.set(relationEntries[index]!.recordId ?? "", error); });\n  const fileGroups = relationEntries.map((entry) => collectFileProjections(entry.model.definition, entry.data));\n  const fileErrors = await validateFileProjectionGroups(env, spaceId, fileGroups);\n  fileErrors.forEach((error, index) => { if (error) errors.set(relationEntries[index]!.recordId ?? "", error); });''')
replace('apps/core/src/recurrence-runtime.ts','''collectRelationProjections, planCreateGenericMutation''','''collectRelationProjections, collectFileProjections, planCreateGenericMutation''')

# External field-level upload capability, adapter operation, audit semantics.
replace('apps/core/src/external-model.ts','''  sortable: boolean;\n};''','''  sortable: boolean;\n  upload?: { supported: true; maxBytes: number };\n};''',1)
replace('apps/core/src/external-model.ts','''  | "update"\n  | "delete";''','''  | "update"\n  | "delete"\n  | "upload";''')
replace('apps/core/src/external-model.ts','''      "operators",\n      "sortable",\n    ]);''','''      "operators",\n      "sortable",\n      "upload",\n    ]);''')
# validate optional upload before normalizedFields.push
replace('apps/core/src/external-model.ts','''    if (\n      canonical.definition.nullable !== true &&\n      f.operators.some((op) => op === "isNull" || op === "isNotNull")\n    )\n      throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);\n    normalizedFields.push({''','''    if (\n      canonical.definition.nullable !== true &&\n      f.operators.some((op) => op === "isNull" || op === "isNotNull")\n    )\n      throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);\n    let upload: ExternalField["upload"];\n    if (f.upload !== undefined) {\n      if (!f.upload || typeof f.upload !== "object" || Array.isArray(f.upload)\n        || Object.keys(f.upload as Record<string, unknown>).some((key) => !["supported", "maxBytes"].includes(key)))\n        throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);\n      const capability = f.upload as Record<string, unknown>;\n      if (capability.supported !== true || !Number.isInteger(capability.maxBytes)\n        || Number(capability.maxBytes) < 1 || Number(capability.maxBytes) > 100 * 1024 * 1024\n        || canonical.definition.type !== "file_ref_list")\n        throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);\n      upload = { supported: true, maxBytes: Number(capability.maxBytes) };\n    }\n    normalizedFields.push({''')
replace('apps/core/src/external-model.ts','''      operators: [...f.operators] as string[],\n      sortable: f.sortable,\n    });''','''      operators: [...f.operators] as string[],\n      sortable: f.sortable,\n      ...(upload ? { upload } : {}),\n    });''')
replace('apps/core/src/external-model.ts','''      ["create", "update", "delete"].includes(operation)''','''      ["create", "update", "delete", "upload"].includes(operation)''')

# External semantic projection hides upload without effective write authority.
replace('apps/core/src/external-runtime.ts','''  const readable = m.snapshot.fields.map(({ sourceFieldId: _id, ...f }) => ({\n    ...f,''','''  const readable = m.snapshot.fields.map(({ sourceFieldId: _id, upload, ...f }) => ({\n    ...f,\n    ...(upload?.supported && allowed.includes("write") && m.declared_access === "write" ? { upload } : {}),''')
# helpers and availability
insert='''function externalUploadAvailable(m: ExternalModel, input: Record<string, unknown>): boolean {\n  if (typeof input.fieldKey !== "string") return false;\n  return m.snapshot.fields.some((field) => field.key === input.fieldKey && field.type === "file_ref_list" && field.upload?.supported === true);\n}\n\n'''
replace('apps/core/src/external-runtime.ts','''export async function executeExternalOperation(''',insert+'''export async function executeExternalOperation(''')
replace('apps/core/src/external-runtime.ts','''  const write =\n    operation === "create" || operation === "update" || operation === "delete";''','''  const write =\n    operation === "create" || operation === "update" || operation === "delete" || operation === "upload";''')
replace('apps/core/src/external-runtime.ts','''  if (\n    !m.snapshot.capabilities[operation] ||\n    (write && m.declared_access !== "write")\n  )''','''  if (\n    !(operation === "upload" ? externalUploadAvailable(m, input) : m.snapshot.capabilities[operation]) ||\n    (write && m.declared_access !== "write")\n  )''',1)
replace('apps/core/src/external-runtime.ts','''      if (operation === "create" || operation === "update")\n        return validateData(m, input, operation);''','''      if (operation === "create" || operation === "update")\n        return validateData(m, input, operation);\n      if (operation === "upload") return input;''')
replace('apps/core/src/external-runtime.ts','''        !m.snapshot.capabilities[operation] ||\n        (write && m.declared_access !== "write")''','''        !(operation === "upload" ? externalUploadAvailable(m, input) : m.snapshot.capabilities[operation]) ||\n        (write && m.declared_access !== "write")''')

# Internal adapter contract additive operation/snapshot capability.
contract=Path('apps/core/external-adapter.contract.json')
data=json.loads(contract.read_text())
data['properties']['operation']['enum'].append('upload')
data['x-lifespace-response']['snapshot']='{ resourceId,displayName,fields:[{key,sourceFieldId,type,title,nullable,readable,writable,operators,sortable,values?,upload?}],capabilities,queryLimits:{maxDepth,maxNodes,maxSort,maxPageSize},adapterState }'
contract.write_text(json.dumps(data,indent=2)+"\n")

# Kernel version bump: additive File API = 0.53.0. Historical 0.52 feature prose remains historical.
replace('apps/core/src/kernel-contract.ts','"0.52.0"','"0.53.0"')
replace('apps/core/package.json','"version": "0.52.0"','"version": "0.53.0"')
replace('apps/core/scripts/check-openapi.mjs','document.info?.version !== "0.52.0"','document.info?.version !== "0.53.0"')
replace('apps/core/scripts/check-person-directory-openapi.mjs','document.info?.version !== "0.52.0"','document.info?.version !== "0.53.0"')
replace('apps/core/scripts/check-person-directory-openapi.mjs','Core Kernel 0.52.0','Core Kernel 0.53.0')
replace('apps/core/AGENTS.md','current Kernel version: 0.52.0','current Kernel version: 0.53.0')

# Tests for same-Space File projection integrity.
Path('apps/core/test/native-file-reference.integration.test.ts').write_text(r'''import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/env";
import { validateFileProjectionGroups } from "../src/generic-resource";

type TestEnv = { DB: D1Database };
function bindings(): Bindings { return { DB: (env as unknown as TestEnv).DB } as Bindings; }

describe("Native File reference integrity", () => {
  it("accepts only ready Files from the same Space", async () => {
    const db=(env as unknown as TestEnv).DB; const suffix=crypto.randomUUID().replaceAll("-","");
    const space=`spc_${suffix}`; const other=`spc_${crypto.randomUUID().replaceAll("-","")}`; const now=new Date().toISOString();
    const good=`fil_${crypto.randomUUID().replaceAll("-","")}`; const foreign=`fil_${crypto.randomUUID().replaceAll("-","")}`;
    await db.batch([
      db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)").bind(space,"Files","usr_test",now,now,"UTC"),
      db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)").bind(other,"Other","usr_test",now,now,"UTC"),
      db.prepare("INSERT INTO files(id,space_id,name,content_type,size_bytes,object_key,status,application_id,principal_type,principal_id,actor_type,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(good,space,"a.pdf","application/pdf",10,`files/${good}`,"ready","app_test","user","usr_test","user","usr_test",now),
      db.prepare("INSERT INTO files(id,space_id,name,content_type,size_bytes,object_key,status,application_id,principal_type,principal_id,actor_type,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(foreign,other,"b.pdf","application/pdf",10,`files/${foreign}`,"ready","app_test","user","usr_test","user","usr_test",now),
    ]);
    const errors=await validateFileProjectionGroups(bindings(),space,[
      [{fieldKey:"attachment",fileId:good,ordinal:0}],
      [{fieldKey:"attachment",fileId:foreign,ordinal:0}],
    ]);
    expect(errors[0]).toBeNull();
    expect(errors[1]?.code).toBe("INVALID_FILE_REFERENCE");
  });
});
''')
