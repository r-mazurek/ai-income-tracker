-- Users: PBKDF2-SHA256 password hashes, per-user random salt.
CREATE TABLE users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash   TEXT    NOT NULL,
  salt        TEXT    NOT NULL,
  iterations  INTEGER NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Sessions: only a SHA-256 of the cookie token is stored.
CREATE TABLE sessions (
  token_hash  TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Income entries. Money is stored as integers (USD cents, PLN grosze);
-- the NBP rate is stored x10000 (NBP publishes 4 decimals).
CREATE TABLE entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date        TEXT    NOT NULL,              -- payout date, YYYY-MM-DD
  platform    TEXT    NOT NULL,
  usd_cents   INTEGER NOT NULL CHECK (usd_cents > 0),
  rate_e4     INTEGER NOT NULL,              -- NBP table A mid rate x 10000
  rate_date   TEXT    NOT NULL,              -- effective date of that table
  rate_table  TEXT    NOT NULL,              -- e.g. 209/A/NBP/2026
  pln_grosze  INTEGER NOT NULL,
  note        TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_entries_user_date ON entries(user_id, date);

-- Cache of "which NBP rate applies to income received on for_date".
-- Published tables never change, so entries never need to expire.
CREATE TABLE rate_cache (
  currency    TEXT    NOT NULL,
  for_date    TEXT    NOT NULL,
  rate_date   TEXT    NOT NULL,
  mid_e4      INTEGER NOT NULL,
  table_no    TEXT    NOT NULL,
  PRIMARY KEY (currency, for_date)
);
