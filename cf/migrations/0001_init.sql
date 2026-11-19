-- Cloudflare D1 schema for NFSU2 Web Free-Tier Serverless Backend

CREATE TABLE IF NOT EXISTS vault_saves (
  token_hash TEXT PRIMARY KEY,
  rev TEXT NOT NULL,
  size INTEGER NOT NULL,
  saved_at INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  earlier_rev TEXT,
  earlier_size INTEGER,
  earlier_saved_at INTEGER,
  earlier_r2_key TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vault_saves_updated_at ON vault_saves (updated_at);

CREATE TABLE IF NOT EXISTS name_claims (
  canon TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  changed_at INTEGER NOT NULL,
  used_at INTEGER NOT NULL,
  old_name TEXT,
  old_canon TEXT,
  old_until INTEGER
);

CREATE INDEX IF NOT EXISTS idx_name_claims_owner ON name_claims (owner);
CREATE INDEX IF NOT EXISTS idx_name_claims_old_canon ON name_claims (old_canon);

CREATE TABLE IF NOT EXISTS leaderboards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_hash INTEGER NOT NULL,
  mode INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  owner TEXT,
  car_name TEXT NOT NULL,
  time_ms INTEGER NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leaderboards_track_mode ON leaderboards (track_hash, mode, time_ms ASC, score DESC);

CREATE TABLE IF NOT EXISTS rooms (
  room_id TEXT PRIMARY KEY,
  room_hash INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  player_count INTEGER NOT NULL DEFAULT 0,
  roam_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
