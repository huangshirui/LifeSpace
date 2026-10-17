import fs from 'node:fs';

const openapiPath = 'apps/core/openapi.yaml';
const externalOpenapiPath = 'apps/core/external-model.openapi.yaml';
const checkPath = 'apps/core/scripts/check-openapi.mjs';

const openapi = JSON.parse(fs.readFileSync(openapiPath, 'utf8'));
const schemas = openapi.components.schemas;
const responses = openapi.components.responses;

schemas.RuntimeDiscoveryFieldType.enum = [
  'string',
  'text',
  'integer',
  'number',
  'boolean',
  'date',
  'instant',
  'datetime',
  'range<date>',
  'range<instant>',
  'temporal_range',
  'recurrence_rule',
  'entity_ref',
  'timezone',
  'enum',
  'enum_list',
  'file',
  'file_list',
  'file_ref_list',
  'person',
  'person_list',
  'record',
  'record_list',
];

schemas.ExternalModelField = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'title', 'type', 'nullable', 'readable', 'writable', 'operators', 'sortable'],
  properties: {
    key: {
      type: 'string',
      pattern: '^[a-z][A-Za-z0-9]{0,62}$',
      description: 'Stable readable LifeSpace field key. Provider source-field identity remains internal.',
    },
    title: { type: 'string', minLength: 1, maxLength: 80 },
    type: {
      type: 'string',
      enum: [
        'string', 'text', 'integer', 'number', 'boolean', 'date', 'instant',
        'range<date>', 'range<instant>', 'temporal_range', 'recurrence_rule', 'entity_ref',
        'timezone', 'enum', 'enum_list', 'file_ref_list', 'person', 'person_list', 'record', 'record_list',
      ],
      description: 'Provider-neutral canonical LifeSpace field type. External provider files use file_ref_list; LifeSpace-owned file/file_list are Native-only.',
    },
    description: { type: 'string' },
    required: { type: 'boolean' },
    nullable: { type: 'boolean' },
    immutable: { type: 'boolean' },
    readOnly: { type: 'boolean' },
    minLength: { type: 'integer', minimum: 0 },
    maxLength: { type: 'integer', minimum: 0 },
    minimum: { type: 'number' },
    maximum: { type: 'number' },
    values: { type: 'array', uniqueItems: true, items: { type: 'string' } },
    targetModel: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,62}$' },
    valueSchema: { type: 'object', additionalProperties: true },
    readable: { const: true },
    writable: { type: 'boolean' },
    operators: {
      type: 'array',
      uniqueItems: true,
      items: { enum: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'isNull', 'isNotNull'] },
    },
    sortable: { type: 'boolean' },
    upload: {
      type: 'object',
      additionalProperties: false,
      required: ['supported', 'maxBytes'],
      properties: {
        supported: { const: true },
        maxBytes: { type: 'integer', minimum: 1, maximum: 104857600 },
      },
      description: 'Optional field-level upload capability. It does not make file_ref_list writable through ordinary Record mutation.',
    },
  },
};

responses.ServiceUnavailable = {
  description: 'Required platform transfer dependency is unavailable',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
};

for (const path of [
  '/api/v1/spaces/{spaceId}/file-uploads',
  '/api/v1/spaces/{spaceId}/file-uploads/{uploadId}/complete',
  '/api/v1/spaces/{spaceId}/file-downloads',
]) {
  const operation = openapi.paths[path]?.post;
  if (!operation) throw new Error(`missing file operation ${path}`);
  operation.parameters ??= [];
  if (!operation.parameters.some((parameter) => parameter?.$ref === '#/components/parameters/DelegationId')) {
    operation.parameters.push({ $ref: '#/components/parameters/DelegationId' });
  }
}

fs.writeFileSync(openapiPath, `${JSON.stringify(openapi, null, 2)}\n`);

const externalOpenapi = JSON.parse(fs.readFileSync(externalOpenapiPath, 'utf8'));
fs.writeFileSync(externalOpenapiPath, `${JSON.stringify(externalOpenapi, null, 2)}\n`);

let check = fs.readFileSync(checkPath, 'utf8');
const marker = 'File/Upload public contract drifted';
if (!check.includes(marker)) {
  const anchor = 'const atomicDelegations = document.paths?.["/api/v1/spaces/{spaceId}/delegations/batch"]?.post;';
  const block = `const requiredFileFieldTypes = ["enum_list", "file", "file_list", "file_ref_list"];\nfor (const type of requiredFileFieldTypes) {\n  if (!schemas.RuntimeDiscoveryFieldType?.enum?.includes(type)) {\n    throw new Error(\`${marker}: Runtime Discovery is missing \${type}\`);\n  }\n}\nconst externalField = schemas.ExternalModelField;\nif (externalField?.properties?.key?.pattern !== "^[a-z][A-Za-z0-9]{0,62}$"\n    || externalField?.properties?.type?.enum?.includes("file")\n    || externalField?.properties?.type?.enum?.includes("file_list")\n    || !externalField?.properties?.type?.enum?.includes("file_ref_list")\n    || externalField?.properties?.upload?.properties?.supported?.const !== true\n    || externalField?.properties?.upload?.properties?.maxBytes?.maximum !== 104857600) {\n  throw new Error("${marker}: External field identity/type/upload semantics are stale");\n}\nif (!document.components?.responses?.ServiceUnavailable) {\n  throw new Error("${marker}: ServiceUnavailable response is missing");\n}\nfor (const path of [\n  "/api/v1/spaces/{spaceId}/file-uploads",\n  "/api/v1/spaces/{spaceId}/file-uploads/{uploadId}/complete",\n  "/api/v1/spaces/{spaceId}/file-downloads",\n]) {\n  const operation = document.paths?.[path]?.post;\n  if (!operation?.parameters?.some((parameter) => parameter?.$ref === "#/components/parameters/DelegationId")) {\n    throw new Error(\`${marker}: \${path} must expose Delegation selection\`);\n  }\n}\n\n`;
  if (!check.includes(anchor)) throw new Error('check-openapi anchor not found');
  check = check.replace(anchor, block + anchor);
  fs.writeFileSync(checkPath, check);
}
