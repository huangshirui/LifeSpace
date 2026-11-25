-- Schema 84: preserve explicit source and target Delegation-chain evidence
-- for one governed relation mutation. Historical rows retain source semantics.
-- Existing single-scope Delegations, record/Batch mutations and source attribution
-- are unchanged. Shared ancestors can appear in both endpoint chains, but are
-- consumed only once for the same Change.
CREATE TABLE semantic_relation_change_delegations_v84 (
  change_id TEXT NOT NULL REFERENCES semantic_relation_changes(id) ON DELETE CASCADE,
  delegation_id TEXT NOT NULL REFERENCES delegations(id),
  chain_position INTEGER NOT NULL CHECK(chain_position BETWEEN 0 AND 3),
  endpoint TEXT NOT NULL DEFAULT 'source' CHECK(endpoint IN ('source','target')),
  PRIMARY KEY(change_id,endpoint,chain_position),
  UNIQUE(change_id,endpoint,delegation_id)
);
INSERT INTO semantic_relation_change_delegations_v84(change_id,delegation_id,chain_position)
SELECT change_id,delegation_id,chain_position FROM semantic_relation_change_delegations;
DROP TABLE semantic_relation_change_delegations;
ALTER TABLE semantic_relation_change_delegations_v84 RENAME TO semantic_relation_change_delegations;
CREATE INDEX idx_semantic_relation_change_delegations_delegation
  ON semantic_relation_change_delegations(delegation_id,change_id);

CREATE TRIGGER trg_semantic_relation_change_delegation_consume_single_use
BEFORE INSERT ON semantic_relation_change_delegations
BEGIN
  -- Also enforce commit-time expiry/revocation for repeated-use leaves.
  SELECT (CASE WHEN NOT EXISTS(
    SELECT 1 FROM delegations WHERE id=NEW.delegation_id
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))
      AND (consumed_at IS NULL OR consumed_by_change_id=NEW.change_id)
  ) THEN RAISE(ABORT,'DELEGATION_SINGLE_USE_UNAVAILABLE') END);
  UPDATE delegations
  SET consumed_at=(SELECT occurred_at FROM semantic_relation_changes WHERE id=NEW.change_id),
      consumed_by_change_id=NEW.change_id
  WHERE id=NEW.delegation_id AND max_uses=1 AND consumed_at IS NULL;
END;

UPDATE schema_metadata SET value='84' WHERE key='schema_version';
