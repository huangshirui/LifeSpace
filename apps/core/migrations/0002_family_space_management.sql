PRAGMA foreign_keys = ON;

ALTER TABLE spaces ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE space_memberships ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);

CREATE TABLE space_invites (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
  expires_at TEXT NOT NULL,
  max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 100),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count BETWEEN 0 AND max_uses),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_by_user_id TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_space_invites_space ON space_invites(space_id,created_at DESC);
CREATE INDEX idx_space_invites_active ON space_invites(status,expires_at);

CREATE TABLE space_invite_redemptions (
  id TEXT PRIMARY KEY,
  invite_id TEXT NOT NULL REFERENCES space_invites(id),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  user_id TEXT NOT NULL,
  redeemed_at TEXT NOT NULL,
  UNIQUE(invite_id,user_id)
);
CREATE INDEX idx_space_invite_redemptions_user ON space_invite_redemptions(user_id,redeemed_at);

CREATE TRIGGER increment_space_invite_use_count
AFTER INSERT ON space_invite_redemptions
BEGIN
  UPDATE space_invites
  SET used_count=used_count+1,updated_at=NEW.redeemed_at
  WHERE id=NEW.invite_id;
END;

UPDATE schema_metadata SET value='2' WHERE key='schema_version';
