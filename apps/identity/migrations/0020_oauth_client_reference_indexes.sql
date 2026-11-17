-- Identity schema 20: bound OAuth Client orphan checks and child FK probes.
-- Retain all authorization history, cleanup predicates and existing by-auth indexes.
-- Additive migration; existing Identity runtime remains compatible.
CREATE INDEX oauth_requests_by_client ON oauth_authorization_requests(client_id);
CREATE INDEX oauth_authorizations_by_client ON oauth_authorizations(client_id);
CREATE INDEX oauth_codes_by_client ON oauth_authorization_codes(client_id);
CREATE INDEX oauth_access_by_client ON oauth_access_tokens(client_id);
CREATE INDEX oauth_refresh_by_client ON oauth_refresh_tokens(client_id);
UPDATE schema_metadata SET value='20' WHERE key='schema_version';
