import YAML from "yaml";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);
const ANNOTATION_KEYS = new Set([
  "title", "description", "examples", "example", "default", "deprecated",
  "externalDocs", "xml", "$comment",
]);

export function parseContractDocument(text) {
  const document = YAML.parse(text);
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("OpenAPI document must be an object");
  }
  return document;
}

function decodePointerToken(value) {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function localRef(document, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) {
    throw new Error(`Only local OpenAPI references are supported by the Stable compatibility gate: ${String(ref)}`);
  }
  let current = document;
  for (const token of ref.slice(2).split("/").map(decodePointerToken)) {
    current = current?.[token];
  }
  if (current === undefined) throw new Error(`OpenAPI reference does not resolve: ${ref}`);
  return current;
}

function resolvedObject(document, value, stack = new Set()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (!value.$ref) return value;
  const ref = value.$ref;
  if (stack.has(ref)) return { $recursiveRef: ref };
  const nextStack = new Set(stack);
  nextStack.add(ref);
  const resolved = resolvedObject(document, localRef(document, ref), nextStack);
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) return resolved;
  const siblings = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref"));
  return { ...resolved, ...siblings };
}

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeLiteral(value) {
  if (Array.isArray(value)) return value.map(normalizeLiteral);
  if (!value || typeof value !== "object") return value;
  return sortedObject(Object.entries(value).map(([key, child]) => [key, normalizeLiteral(child)]));
}

export function normalizeSchema(document, raw, stack = new Set()) {
  if (typeof raw === "boolean") return raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  if (raw.$recursiveRef) return { $recursiveRef: raw.$recursiveRef };

  if (raw.$ref) {
    const ref = raw.$ref;
    if (stack.has(ref)) return { $recursiveRef: ref };
    const nextStack = new Set(stack);
    nextStack.add(ref);
    const resolved = localRef(document, ref);
    const siblings = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "$ref"));
    return normalizeSchema(document, { ...resolved, ...siblings }, nextStack);
  }

  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (ANNOTATION_KEYS.has(key) || key.startsWith("x-")) continue;
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      out.properties = sortedObject(Object.entries(value).map(([name, schema]) => [name, normalizeSchema(document, schema, stack)]));
      continue;
    }
    if (key === "items") {
      out.items = normalizeSchema(document, value, stack);
      continue;
    }
    if (["allOf", "anyOf", "oneOf", "prefixItems"].includes(key) && Array.isArray(value)) {
      out[key] = value.map((schema) => normalizeSchema(document, schema, stack));
      continue;
    }
    if (key === "not") {
      out.not = normalizeSchema(document, value, stack);
      continue;
    }
    if (key === "additionalProperties" && value && typeof value === "object") {
      out.additionalProperties = normalizeSchema(document, value, stack);
      continue;
    }
    if (key === "required" && Array.isArray(value)) {
      out.required = [...new Set(value.filter((entry) => typeof entry === "string"))].sort();
      continue;
    }
    out[key] = normalizeLiteral(value);
  }
  return sortedObject(Object.entries(out));
}

function normalizeContent(document, content) {
  if (!content || typeof content !== "object" || Array.isArray(content)) return {};
  return sortedObject(Object.entries(content).map(([mediaType, entry]) => {
    const resolved = resolvedObject(document, entry);
    return [mediaType, {
      schema: normalizeSchema(document, resolved?.schema ?? {}),
    }];
  }));
}

function normalizeHeaders(document, headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {};
  return sortedObject(Object.entries(headers).map(([name, raw]) => {
    const header = resolvedObject(document, raw);
    return [name.toLowerCase(), {
      schema: normalizeSchema(document, header?.schema ?? {}),
      required: Boolean(header?.required),
    }];
  }));
}

function normalizeParameter(document, raw) {
  const parameter = resolvedObject(document, raw);
  return {
    name: parameter.name,
    in: parameter.in,
    required: Boolean(parameter.required || parameter.in === "path"),
    schema: normalizeSchema(document, parameter.schema ?? {}),
    ...(parameter.style === undefined ? {} : { style: parameter.style }),
    ...(parameter.explode === undefined ? {} : { explode: parameter.explode }),
    ...(parameter.allowReserved === undefined ? {} : { allowReserved: parameter.allowReserved }),
  };
}

export function normalizeOperation(document, method, path) {
  const pathItem = document.paths?.[path];
  const operation = pathItem?.[method.toLowerCase()];
  if (!pathItem || !operation) throw new Error(`Operation is missing: ${method.toUpperCase()} ${path}`);

  const byKey = new Map();
  for (const raw of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]) {
    const parameter = normalizeParameter(document, raw);
    byKey.set(`${parameter.in}:${parameter.name}`, parameter);
  }

  const requestBody = operation.requestBody
    ? resolvedObject(document, operation.requestBody)
    : null;
  const responses = {};
  for (const [status, raw] of Object.entries(operation.responses ?? {})) {
    const response = resolvedObject(document, raw);
    responses[status] = {
      content: normalizeContent(document, response?.content),
      headers: normalizeHeaders(document, response?.headers),
    };
  }

  return {
    parameters: [...byKey.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value),
    requestBody: requestBody ? {
      required: Boolean(requestBody.required),
      content: normalizeContent(document, requestBody.content),
    } : null,
    responses: sortedObject(Object.entries(responses)),
  };
}

function operationMap(document) {
  const result = new Map();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.has(method.toLowerCase())) {
        result.set(`${method.toUpperCase()} ${path}`, { method: method.toUpperCase(), path });
      }
    }
  }
  return result;
}

export function buildStablePublicSchemaBaseline(classification, documentsBySource) {
  const snapshots = {};
  const classifiedGroups = [];

  for (const source of classification.contractSources ?? []) {
    const document = documentsBySource[source.source];
    if (!document) throw new Error(`Missing parsed OpenAPI source ${source.source}`);
    const operations = operationMap(document);
    for (const group of source.groups ?? []) {
      if (group.maturity !== "stable" || group.visibility !== "public") continue;
      const regex = new RegExp(group.operationPattern);
      const reference = `${source.id}/${group.id}`;
      const matched = [...operations.keys()].filter((operation) => regex.test(operation)).sort();
      if (matched.length === 0) throw new Error(`Stable Public group ${reference} matched no operations`);
      classifiedGroups.push(reference);
      for (const operation of matched) {
        const { method, path } = operations.get(operation);
        const key = `${source.id}::${operation}`;
        snapshots[key] = normalizeOperation(document, method, path);
      }
    }
  }

  return {
    schemaVersion: 1,
    classificationSource: "docs/contract-stability-baseline.json",
    classifiedGroups: classifiedGroups.sort(),
    operations: sortedObject(Object.entries(snapshots)),
  };
}

function schemaTypes(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  if (Array.isArray(schema.type)) return [...schema.type].sort();
  if (typeof schema.type === "string") return [schema.type];
  return [];
}

function setContainsAll(container, values) {
  const set = new Set(container);
  return values.every((value) => set.has(value));
}

function numericConstraint(before, after, key, direction, errors, path) {
  const oldValue = before?.[key];
  const newValue = after?.[key];
  if (oldValue === undefined && newValue === undefined) return;
  if (direction === "request") {
    if (oldValue === undefined && newValue !== undefined) {
      errors.push(`${path}: request schema added narrowing constraint ${key}=${newValue}`);
      return;
    }
    if (oldValue !== undefined && newValue === undefined) return;
    const narrows = ["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties"].includes(key)
      ? newValue > oldValue
      : newValue < oldValue;
    if (narrows) errors.push(`${path}: request schema narrowed ${key} from ${oldValue} to ${newValue}`);
  } else {
    if (oldValue !== undefined && newValue === undefined) {
      errors.push(`${path}: response schema widened by removing ${key}`);
      return;
    }
    if (oldValue === undefined && newValue !== undefined) return;
    const widens = ["minimum", "exclusiveMinimum", "minLength", "minItems", "minProperties"].includes(key)
      ? newValue < oldValue
      : newValue > oldValue;
    if (widens) errors.push(`${path}: response schema widened ${key} from ${oldValue} to ${newValue}`);
  }
}

function compareComplexKeyword(before, after, key, errors, path) {
  if (JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])) {
    errors.push(`${path}: complex schema keyword ${key} changed; Stable migration review is required`);
  }
}

export function compareSchemaCompatibility(before, after, direction, path = "$") {
  const errors = [];
  if (typeof before === "boolean" || typeof after === "boolean") {
    if (before !== after) errors.push(`${path}: boolean schema changed from ${String(before)} to ${String(after)}`);
    return errors;
  }
  before = before ?? {};
  after = after ?? {};

  const oldTypes = schemaTypes(before);
  const newTypes = schemaTypes(after);
  if (oldTypes.length || newTypes.length) {
    const compatible = direction === "request"
      ? setContainsAll(newTypes, oldTypes)
      : setContainsAll(oldTypes, newTypes);
    if (!compatible) {
      errors.push(`${path}: ${direction} type set changed incompatibly from [${oldTypes.join(",")}] to [${newTypes.join(",")}]`);
    }
  }

  if (Object.prototype.hasOwnProperty.call(before, "const")) {
    if (direction === "request") {
      if (Object.prototype.hasOwnProperty.call(after, "const") && JSON.stringify(before.const) !== JSON.stringify(after.const)) {
        errors.push(`${path}: request const changed`);
      }
    } else if (!Object.prototype.hasOwnProperty.call(after, "const") || JSON.stringify(before.const) !== JSON.stringify(after.const)) {
      errors.push(`${path}: response const changed or widened`);
    }
  } else if (direction === "request" && Object.prototype.hasOwnProperty.call(after, "const")) {
    errors.push(`${path}: request schema added a const restriction`);
  }

  const oldEnum = Array.isArray(before.enum) ? before.enum : null;
  const newEnum = Array.isArray(after.enum) ? after.enum : null;
  if (oldEnum) {
    if (!newEnum) {
      if (direction === "response") errors.push(`${path}: response enum restriction was removed/widened`);
    } else if (direction === "request") {
      const encoded = new Set(newEnum.map((value) => JSON.stringify(value)));
      for (const value of oldEnum) if (!encoded.has(JSON.stringify(value))) errors.push(`${path}: request enum removed ${JSON.stringify(value)}`);
    } else {
      const encoded = new Set(oldEnum.map((value) => JSON.stringify(value)));
      for (const value of newEnum) if (!encoded.has(JSON.stringify(value))) errors.push(`${path}: response enum added unsupported value ${JSON.stringify(value)}`);
    }
  } else if (newEnum && direction === "request") {
    errors.push(`${path}: request schema introduced an enum restriction`);
  }

  const oldRequired = new Set(Array.isArray(before.required) ? before.required : []);
  const newRequired = new Set(Array.isArray(after.required) ? after.required : []);
  if (direction === "request") {
    for (const key of newRequired) if (!oldRequired.has(key)) errors.push(`${path}: newly required request property ${key}`);
  } else {
    for (const key of oldRequired) if (!newRequired.has(key)) errors.push(`${path}: required response property ${key} is no longer required`);
  }

  const oldProperties = before.properties && typeof before.properties === "object" ? before.properties : {};
  const newProperties = after.properties && typeof after.properties === "object" ? after.properties : {};
  for (const [key, oldSchema] of Object.entries(oldProperties)) {
    if (!Object.prototype.hasOwnProperty.call(newProperties, key)) {
      errors.push(`${path}: documented ${direction} property ${key} was removed`);
      continue;
    }
    errors.push(...compareSchemaCompatibility(oldSchema, newProperties[key], direction, `${path}.properties.${key}`));
  }

  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]) {
    numericConstraint(before, after, key, direction, errors, path);
  }

  if (before.pattern !== after.pattern) {
    if (direction === "request") {
      if (after.pattern !== undefined) errors.push(`${path}: request pattern changed or was introduced`);
    } else if (before.pattern !== undefined) {
      errors.push(`${path}: response pattern changed or was removed`);
    }
  }
  if (before.format !== after.format) errors.push(`${path}: format changed from ${String(before.format)} to ${String(after.format)}`);

  if (before.items || after.items) {
    if (!before.items || !after.items) {
      errors.push(`${path}: array items schema was added or removed`);
    } else {
      errors.push(...compareSchemaCompatibility(before.items, after.items, direction, `${path}.items`));
    }
  }

  for (const key of ["allOf", "anyOf", "oneOf", "not", "prefixItems"]) {
    if (before[key] !== undefined || after[key] !== undefined) compareComplexKeyword(before, after, key, errors, path);
  }

  if (direction === "request" && before.additionalProperties === true && after.additionalProperties === false) {
    errors.push(`${path}: request object stopped accepting additional properties`);
  }
  if (before.additionalProperties && typeof before.additionalProperties === "object"
      && after.additionalProperties && typeof after.additionalProperties === "object") {
    errors.push(...compareSchemaCompatibility(before.additionalProperties, after.additionalProperties, direction, `${path}.additionalProperties`));
  }

  return errors;
}

function parameterKey(parameter) {
  return `${parameter.in}:${parameter.name}`;
}

export function compareOperationCompatibility(before, after, operationKey) {
  const errors = [];
  const oldParameters = new Map((before.parameters ?? []).map((parameter) => [parameterKey(parameter), parameter]));
  const newParameters = new Map((after.parameters ?? []).map((parameter) => [parameterKey(parameter), parameter]));

  for (const [key, parameter] of oldParameters) {
    const current = newParameters.get(key);
    if (!current) {
      errors.push(`${operationKey}: request parameter ${key} was removed or renamed`);
      continue;
    }
    if (!parameter.required && current.required) errors.push(`${operationKey}: request parameter ${key} became required`);
    if (parameter.style !== current.style || parameter.explode !== current.explode || parameter.allowReserved !== current.allowReserved) {
      errors.push(`${operationKey}: request parameter ${key} serialization changed`);
    }
    errors.push(...compareSchemaCompatibility(parameter.schema, current.schema, "request", `${operationKey}.parameters.${key}`));
  }
  for (const [key, parameter] of newParameters) {
    if (!oldParameters.has(key) && parameter.required) errors.push(`${operationKey}: new request parameter ${key} is required`);
  }

  if (before.requestBody && !after.requestBody) {
    errors.push(`${operationKey}: documented request body was removed`);
  } else if (!before.requestBody && after.requestBody?.required) {
    errors.push(`${operationKey}: a required request body was introduced`);
  } else if (before.requestBody && after.requestBody) {
    if (!before.requestBody.required && after.requestBody.required) errors.push(`${operationKey}: request body became required`);
    for (const [mediaType, content] of Object.entries(before.requestBody.content ?? {})) {
      const current = after.requestBody.content?.[mediaType];
      if (!current) {
        errors.push(`${operationKey}: request media type ${mediaType} was removed`);
        continue;
      }
      errors.push(...compareSchemaCompatibility(content.schema, current.schema, "request", `${operationKey}.requestBody.${mediaType}`));
    }
  }

  for (const [status, response] of Object.entries(before.responses ?? {})) {
    const current = after.responses?.[status];
    if (!current) {
      errors.push(`${operationKey}: response ${status} was removed`);
      continue;
    }
    for (const [mediaType, content] of Object.entries(response.content ?? {})) {
      const currentContent = current.content?.[mediaType];
      if (!currentContent) {
        errors.push(`${operationKey}: response ${status} media type ${mediaType} was removed`);
        continue;
      }
      errors.push(...compareSchemaCompatibility(content.schema, currentContent.schema, "response", `${operationKey}.responses.${status}.${mediaType}`));
    }
    for (const [name, header] of Object.entries(response.headers ?? {})) {
      const currentHeader = current.headers?.[name];
      if (!currentHeader) {
        errors.push(`${operationKey}: response ${status} header ${name} was removed`);
        continue;
      }
      errors.push(...compareSchemaCompatibility(header.schema, currentHeader.schema, "response", `${operationKey}.responses.${status}.headers.${name}`));
    }
  }

  return errors;
}

export function compareStablePublicBaselines(accepted, current) {
  const errors = [];
  if (accepted.schemaVersion !== 1 || current.schemaVersion !== 1) {
    return ["Stable Public schema baseline version is unsupported"];
  }
  if (JSON.stringify(accepted.classifiedGroups) !== JSON.stringify(current.classifiedGroups)) {
    errors.push("Stable Public classified group set changed; update classification/deprecation evidence explicitly");
  }
  for (const [operation, before] of Object.entries(accepted.operations ?? {})) {
    const after = current.operations?.[operation];
    if (!after) {
      errors.push(`${operation}: Stable Public operation was removed or renamed`);
      continue;
    }
    errors.push(...compareOperationCompatibility(before, after, operation));
  }
  return errors;
}
