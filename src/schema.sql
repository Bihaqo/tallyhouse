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
  -- When this account used its one category suggestion run on the deployment's
  -- own OpenAI key (ONBOARDING_OPENAI_KEY), for accounts that never gave one of
  -- their own. Null until it does: the column is the whole enforcement of "once
  -- per account", so somebody else's bill cannot be run up by reloading setup.
  hosted_suggest_at TIMESTAMPTZ,
  -- A signed-out demo account: invented data, no keys, deleted once no live
  -- session points at it (see src/demo.js). Kept on `users` rather than in a
  -- table of its own so a demo is a normal account to every query that does not
  -- care — and so the ones that do care (the signup cap, the admin panel) opt
  -- out explicitly and visibly.
  is_demo       BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Added to a table that already existed everywhere, so an installation created
-- before the column gets it on the next boot. Additive and idempotent, like the
-- CREATE TABLEs above: a rollback simply stops reading it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS hosted_suggest_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS users_demo_idx ON users (is_demo) WHERE is_demo;

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

-- Feedback people chose to send, with an optional picture of the page they were
-- looking at. Nothing here is collected: a row exists only because somebody
-- typed a message and pressed send, and the picture only if they also ticked
-- the box for it.
--
-- ON DELETE SET NULL rather than CASCADE, with the account-deletion route
-- deleting these rows explicitly. The two callers want opposite things and a
-- constraint cannot tell them apart: someone deleting their account is promised
-- that everything of theirs goes, including a screenshot of their own finances,
-- while a demo account being reaped should leave its first impressions behind —
-- there is nothing personal in feedback about invented data, and it is the most
-- useful feedback there is.
CREATE TABLE IF NOT EXISTS feedback (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  from_demo  BOOLEAN NOT NULL DEFAULT false,
  message    TEXT NOT NULL,
  -- Which view they were on, so a report about "the chart" can be placed.
  page       TEXT,
  -- PNG bytes, null unless they asked for it to be sent.
  screenshot BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_created_idx ON feedback (created_at DESC);

-- express-session store (replaces the old JSON file store).
CREATE TABLE IF NOT EXISTS user_sessions (
  sid    TEXT PRIMARY KEY,
  sess   JSONB       NOT NULL,
  expire TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS user_sessions_expire_idx ON user_sessions (expire);

-- The demo reaper asks "which demo accounts have no live session?" every
-- fifteen minutes, and the lookup inside it is by the user id buried in the
-- session document, which no index on `sid` or `expire` can help with. Declared
-- here rather than beside the users table above because the table it indexes is
-- created further down this file, and this runs as one script in order.
CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions ((sess->>'userId'));
