-- Postgres schema for the multi-user finance dashboard. Applied idempotently at
-- boot by src/db.js (init). Everything a user owns is scoped by user_id and
-- cascades on account deletion; FX rates are shared across users.

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  google_sub    TEXT UNIQUE,
  -- AES-256-GCM ciphertext (iv ‖ tag ‖ data); null until onboarding stores them.
  lunchflow_key BYTEA,
  openai_key    BYTEA,
  onboarded_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One editable rules document per user (same shape as config/settings.json).
CREATE TABLE IF NOT EXISTS rules (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  doc     JSONB  NOT NULL
);

-- Manual per-transaction classification overrides. entry is the compact
-- string-or-object shape the classifier already understands.
CREATE TABLE IF NOT EXISTS overrides (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tx_id   TEXT   NOT NULL,
  entry   JSONB  NOT NULL,
  PRIMARY KEY (user_id, tx_id)
);

-- Cached AI reviews, one per reviewed transaction.
CREATE TABLE IF NOT EXISTS ai_reviews (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tx_id   TEXT   NOT NULL,
  review  JSONB  NOT NULL,
  PRIMARY KEY (user_id, tx_id)
);

-- Cumulative AI spend accounting.
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stats   JSONB  NOT NULL
);

-- The expensive raw Lunchflow pull, cached so derived views are cheap.
CREATE TABLE IF NOT EXISTS transactions_cache (
  user_id   BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cached_at BIGINT NOT NULL,
  accounts  JSONB  NOT NULL,
  txs       JSONB  NOT NULL
);

-- Historical FX rates, shared by every user. pair is "<CURRENCY>|<YYYY-MM-DD>".
CREATE TABLE IF NOT EXISTS fx_rates (
  pair      TEXT PRIMARY KEY,
  rate      DOUBLE PRECISION NOT NULL,
  rate_date TEXT NOT NULL
);

-- People who arrived after the signup cap was reached. The address is whatever
-- Google verified during the sign-in that got turned away, so there is no
-- user-supplied input here and no row without a completed OAuth round-trip.
-- Deliberately not tied to users(id): the whole point is that no account exists.
CREATE TABLE IF NOT EXISTS waitlist (
  email      TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- express-session store (replaces the old JSON file store).
CREATE TABLE IF NOT EXISTS user_sessions (
  sid    TEXT PRIMARY KEY,
  sess   JSONB       NOT NULL,
  expire TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS user_sessions_expire_idx ON user_sessions (expire);
