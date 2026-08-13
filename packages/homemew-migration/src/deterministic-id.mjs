import { createHash } from 'node:crypto';

const PREFIXES = Object.freeze({
  user: 'usr',
  space: 'spc',
  membership: 'mbr',
  person: 'per',
  resource: 'res',
  servicePrincipal: 'svc'
});

export function deterministicId(kind, migrationNamespace, sourceId) {
  const prefix = PREFIXES[kind];
  if (!prefix) throw new Error(`unsupported deterministic id kind: ${kind}`);
  if (!migrationNamespace || !sourceId) throw new Error('migrationNamespace and sourceId are required');

  const digest = createHash('sha256')
    .update(`lifespace-homemew-migration:v1:${migrationNamespace}:${kind}:${sourceId}`)
    .digest('hex')
    .slice(0, 24);

  return `${prefix}_${digest}`;
}

export function stableChecksum(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
