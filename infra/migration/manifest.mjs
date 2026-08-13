export const ACCEPTED_TARGET = Object.freeze({
  coreKernelContract: '0.12.0',
  coreD1Schema: 24,
  modelContract: 'mct_9a3d9588da8591ab376ef000e5e661f670a64dd8b1ebc14fd146580f0ed1fa45',
  identityContract: '0.4.0',
  identityD1Schema: 4,
  integrationProfileVersion: 1,
  integrationProfileState: 'accepted'
});

export const SOURCE_CLASSIFICATION = Object.freeze({
  durable: [
    'users',
    'families',
    'family_members',
    'invitations',
    'events',
    'event_attendees',
    'tasks',
    'task_assignees',
    'day_records',
    'day_record_occurrences',
    'wishes',
    'external_system_integrations'
  ],
  objects: ['user avatars', 'family avatars'],
  ephemeral: ['creation_draft_jobs', 'queue messages', 'sessions', 'tokens', 'rate-limit counters', 'caches'],
  derived: ['attention/countdown values', 'aggregate counts/statistics', 'rebuildable search/index/cache state'],
  secrets: ['hmw_pat_*', 'secret hashes', 'signing keys', 'AI/provider keys', 'Cloudflare credentials', 'WeChat secrets']
});
