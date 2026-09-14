import type { ResourceMutationExtension } from "./generic-resource";
import { ApiError } from "./http";

type JsonObject = Record<string, unknown>;

export type ProvenanceRecordReference = {
  type: "record";
  recordId: string;
  version?: number;
};

export type ProvenanceExternalReference = {
  type: "external";
  system: string;
  ref: string;
};

export type ProvenanceReference = ProvenanceRecordReference | ProvenanceExternalReference;

export type InformationProvenance = {
  source: string;
  sourceRef?: ProvenanceReference;
  derivedFrom?: ProvenanceReference[];
};

export type StoredProvenanceColumns = {
  provenance_source?: string | null;
  provenance_source_ref_json?: string | null;
  provenance_derived_from_json?: string | null;
};

const RECORD_ID = /^rec_[A-Za-z0-9]+$/u;
const REFERENCE_LIMIT = 50;

function object(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_PROVENANCE", `${path} must be an object`, 400);
  }
  return value as JsonObject;
}

function boundedString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string") throw new ApiError("INVALID_PROVENANCE", `${path} must be a string`, 400);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new ApiError("INVALID_PROVENANCE", `${path} must contain 1-${maxLength} characters`, 400);
  }
  return normalized;
}

function onlyKeys(value: JsonObject, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new ApiError("INVALID_PROVENANCE", `${path}.${unknown} is not supported`, 400);
}

function provenanceReference(value: unknown, path: string): ProvenanceReference {
  const ref = object(value, path);
  const type = ref.type;
  if (type === "record") {
    onlyKeys(ref, ["type", "recordId", "version"], path);
    const recordId = boundedString(ref.recordId, `${path}.recordId`, 100);
    if (!RECORD_ID.test(recordId)) throw new ApiError("INVALID_PROVENANCE", `${path}.recordId must be a LifeSpace rec_* ID`, 400);
    if (ref.version !== undefined && (!Number.isInteger(ref.version) || Number(ref.version) < 1)) {
      throw new ApiError("INVALID_PROVENANCE", `${path}.version must be a positive integer`, 400);
    }
    return {
      type: "record",
      recordId,
      ...(ref.version === undefined ? {} : { version: Number(ref.version) }),
    };
  }
  if (type === "external") {
    onlyKeys(ref, ["type", "system", "ref"], path);
    return {
      type: "external",
      system: boundedString(ref.system, `${path}.system`, 100),
      ref: boundedString(ref.ref, `${path}.ref`, 2000),
    };
  }
  throw new ApiError("INVALID_PROVENANCE", `${path}.type must be record or external`, 400);
}

export function validateInformationProvenance(value: unknown): InformationProvenance {
  const input = object(value, "provenance");
  onlyKeys(input, ["source", "sourceRef", "derivedFrom"], "provenance");
  const source = boundedString(input.source, "provenance.source", 100);
  let sourceRef: ProvenanceReference | undefined;
  if (input.sourceRef !== undefined) sourceRef = provenanceReference(input.sourceRef, "provenance.sourceRef");

  let derivedFrom: ProvenanceReference[] | undefined;
  if (input.derivedFrom !== undefined) {
    if (!Array.isArray(input.derivedFrom) || input.derivedFrom.length > REFERENCE_LIMIT) {
      throw new ApiError("INVALID_PROVENANCE", `provenance.derivedFrom must be an array with at most ${REFERENCE_LIMIT} references`, 400);
    }
    derivedFrom = input.derivedFrom.map((entry, index) => provenanceReference(entry, `provenance.derivedFrom[${index}]`));
  }

  return {
    source,
    ...(sourceRef ? { sourceRef } : {}),
    ...(derivedFrom?.length ? { derivedFrom } : {}),
  };
}

export function splitProvenanceEnvelope(input: JsonObject): {
  data: JsonObject;
  provenance?: InformationProvenance;
  provenanceSupplied: boolean;
} {
  const provenanceSupplied = Object.prototype.hasOwnProperty.call(input, "provenance");
  const data = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "provenance"));
  return {
    data,
    ...(provenanceSupplied ? { provenance: validateInformationProvenance(input.provenance) } : {}),
    provenanceSupplied,
  };
}

function serialized(provenance: InformationProvenance) {
  return {
    sourceRef: provenance.sourceRef === undefined ? null : JSON.stringify(provenance.sourceRef),
    derivedFrom: JSON.stringify(provenance.derivedFrom ?? []),
  };
}

export function provenanceMutationExtension(provenance: InformationProvenance): ResourceMutationExtension {
  const encoded = serialized(provenance);
  return ({ env, recordId, timestamp, mutationToken }) => {
    const base = `INSERT INTO resource_provenance(
      record_id,record_version,source,source_ref_json,derived_from_json,recorded_at
    ) SELECT id,version,?,?,?,? FROM resource_records WHERE id=?`;
    if (!mutationToken) {
      return [env.DB.prepare(base).bind(
        provenance.source,
        encoded.sourceRef,
        encoded.derivedFrom,
        timestamp,
        recordId,
      )];
    }
    return [env.DB.prepare(`${base} AND mutation_token=?`).bind(
      provenance.source,
      encoded.sourceRef,
      encoded.derivedFrom,
      timestamp,
      recordId,
      mutationToken,
    )];
  };
}

function parseStoredReference(value: string | null | undefined, path: string): ProvenanceReference | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    return provenanceReference(JSON.parse(value) as unknown, path);
  } catch (error) {
    if (error instanceof ApiError) throw new ApiError("RESOURCE_STORAGE_CORRUPT", `Stored ${path} is invalid`, 500);
    throw new ApiError("RESOURCE_STORAGE_CORRUPT", `Stored ${path} JSON is invalid`, 500);
  }
}

export function provenanceFromStorage(row: StoredProvenanceColumns): InformationProvenance | undefined {
  if (row.provenance_source === null || row.provenance_source === undefined) return undefined;
  let derivedFrom: ProvenanceReference[] = [];
  try {
    const parsed = JSON.parse(row.provenance_derived_from_json ?? "[]") as unknown;
    if (!Array.isArray(parsed) || parsed.length > REFERENCE_LIMIT) throw new Error("invalid provenance array");
    derivedFrom = parsed.map((entry, index) => provenanceReference(entry, `derivedFrom[${index}]`));
  } catch (error) {
    if (error instanceof ApiError) throw new ApiError("RESOURCE_STORAGE_CORRUPT", "Stored provenance.derivedFrom is invalid", 500);
    throw new ApiError("RESOURCE_STORAGE_CORRUPT", "Stored provenance.derivedFrom JSON is invalid", 500);
  }
  const sourceRef = parseStoredReference(row.provenance_source_ref_json, "sourceRef");
  let source: string;
  try {
    source = boundedString(row.provenance_source, "source", 100);
  } catch {
    throw new ApiError("RESOURCE_STORAGE_CORRUPT", "Stored provenance.source is invalid", 500);
  }
  return {
    source,
    ...(sourceRef ? { sourceRef } : {}),
    ...(derivedFrom.length ? { derivedFrom } : {}),
  };
}
