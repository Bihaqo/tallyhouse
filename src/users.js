'use strict';

// The users table: account identity (Google) plus each user's encrypted
// Lunchflow/OpenAI keys and onboarding state. Keys are stored as AES-GCM
// ciphertext and only ever decrypted in-process when a request needs them.

const db = require('./db');
const { encrypt, decrypt } = require('./crypto');

/**
 * How many accounts this deployment will create. 0 means no limit.
 *
 * Read per call rather than at load time so it can be changed without a code
 * edit, and so the tests can exercise both sides of the boundary.
 *
 * The ceiling is about this process, not about demand: every signed-in account's
 * raw Lunchflow pull is held in a Map in src/summary.js that is only ever
 * evicted on account deletion, and the sweep scheduler walks all of them hourly
 * on the single replica the in-process sweep state requires. Reviews bill each
 * user's own OpenAI key, so the shared, finite resource here is memory.
 */
const DEFAULT_MAX_USERS = 20;
function maxUsers() {
  const configured = process.env.MAX_USERS;
  if (configured === undefined || configured === '') return DEFAULT_MAX_USERS;
  const raw = Number(configured);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/**
 * How many accounts are using a place.
 *
 * Only accounts that finished setup, and never demo accounts. Both exclusions
 * follow from what the cap is actually rationing, which is this process's
 * memory: a place costs a cached transaction pull in src/summary.js and an
 * hourly visit from the sweep, and neither exists until an account has keys and
 * data. Someone who signed in with Google and never came back holds no memory
 * at all, so counting them would refuse a real user on behalf of a row that
 * costs nothing. A demo account is excluded for a different reason — it deletes
 * itself, and a passer-by should not be able to fill an instance.
 *
 * The consequence to keep in mind: rows in `users` can exceed the cap, and are
 * expected to. The cap is not a limit on sign-ins.
 */
async function countUsers() {
  const { rows } = await db.query(
    'SELECT count(*)::int AS n FROM users WHERE onboarded_at IS NOT NULL AND NOT is_demo'
  );
  return rows[0].n;
}

// Whether another account can still finish setup. Accounts that already have a
// place are never affected — the cap only ever refuses someone new.
async function atCapacity() {
  const cap = maxUsers();
  return cap > 0 && (await countUsers()) >= cap;
}

// Serializes first-time account creation so two people arriving together cannot
// both pass the count check and overshoot the cap. Signups are rare, so holding
// a transaction-scoped lock across the count and the insert costs nothing.
const SIGNUP_LOCK_KEY = 727275;

/**
 * The signup log.
 *
 * There is no mail transport in this deployment, so the log *is* the
 * notification channel: one line per new account, escalated to a WARN once the
 * cap is close or reached, so it stands out in the Railway log instead of being
 * something to notice by accident. Logged here rather than in the route because
 * this is the only place an account can come into existence.
 */
const APPROACHING_FRACTION = 0.8;
function announceSignup(total, cap) {
  if (!cap) {
    console.log(`Account set up (${total} total, no cap set)`);
    return;
  }
  const line = `Account set up (${total}/${cap})`;
  if (total >= cap) {
    console.warn(`${line} — SIGNUP CAP REACHED, further sign-ups now go to the waiting list`);
  } else if (total >= Math.ceil(cap * APPROACHING_FRACTION)) {
    console.warn(`${line} — approaching the signup cap`);
  } else {
    console.log(line);
  }
}

/**
 * Create the account on first Google login, or refresh the email on return.
 *
 * Returns the user row, or `null` when the cap refused a *new* account — the
 * caller turns that into the waiting-list offer. An existing account is looked
 * up and returned before the cap is consulted at all: someone who already has
 * data here must be able to reach it whether or not registration is open.
 */
async function upsertByGoogle({ sub, email }) {
  const normalized = String(email).trim().toLowerCase();
  const googleSub = String(sub);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'UPDATE users SET email = $2 WHERE google_sub = $1 RETURNING *',
      [googleSub, normalized]
    );
    if (existing.rows.length) {
      await client.query('COMMIT');
      return existing.rows[0];
    }

    await client.query('SELECT pg_advisory_xact_lock($1)', [SIGNUP_LOCK_KEY]);
    const cap = maxUsers();
    if (cap > 0) {
      const { rows } = await client.query(
        'SELECT count(*)::int AS n FROM users WHERE onboarded_at IS NOT NULL AND NOT is_demo'
      );
      if (rows[0].n >= cap) {
        await client.query('COMMIT');
        console.warn(`Sign-in refused: at the ${cap}-account cap — offering the waiting list to ${normalized}`);
        return null;
      }
    }

    const created = await client.query(
      `INSERT INTO users (email, google_sub) VALUES ($1, $2)
       ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email
       RETURNING *`,
      [normalized, googleSub]
    );
    await client.query('COMMIT');
    // Not announceSignup: no place has been taken yet. Setup is where that
    // happens, and where the cap is counted, so that is where the log escalates.
    console.log('New account created — not set up yet');
    return created.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* ---------- waiting list (only reached once the cap is hit) ---------- */

// Record a turned-away address. Idempotent, so refreshing the page or signing in
// again does not duplicate anyone. Returns the number now waiting.
async function addToWaitlist(email) {
  const address = String(email).trim().toLowerCase();
  const { rowCount } = await db.query(
    'INSERT INTO waitlist (email) VALUES ($1) ON CONFLICT (email) DO NOTHING',
    [address]
  );
  const waiting = await waitingCount();
  // Only the first time, so someone reloading the page does not pad the log.
  if (rowCount) console.warn(`Waiting list: added ${address} (${waiting} waiting)`);
  return waiting;
}

async function waitingCount() {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM waitlist');
  return rows[0].n;
}

// Dev-only: get-or-create an account by email (no Google). Used by the local
// email login when OAuth isn't configured.
function upsertByEmail(email) {
  return db
    .query(
      `INSERT INTO users (email) VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING *`,
      [String(email).trim().toLowerCase()]
    )
    .then((r) => r.rows[0]);
}

function byId(id) {
  return db.query('SELECT * FROM users WHERE id = $1', [id]).then((r) => r.rows[0] || null);
}

// Store one or both keys (encrypted). Pass only the keys you want to change.
async function setKeys(id, { lunchflow, openai } = {}) {
  const sets = [];
  const params = [id];
  if (lunchflow !== undefined) {
    params.push(lunchflow == null ? null : encrypt(lunchflow));
    sets.push(`lunchflow_key = $${params.length}`);
  }
  if (openai !== undefined) {
    params.push(openai == null ? null : encrypt(openai));
    sets.push(`openai_key = $${params.length}`);
  }
  if (!sets.length) return;
  await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, params);
}

// Decrypted keys for a user: { lunchflow, openai } (each null when unset).
async function getKeys(id) {
  const { rows } = await db.query('SELECT lunchflow_key, openai_key FROM users WHERE id = $1', [id]);
  if (!rows.length) return { lunchflow: null, openai: null };
  return { lunchflow: decrypt(rows[0].lunchflow_key), openai: decrypt(rows[0].openai_key) };
}

// Whether an account has an OpenAI key on file at all. Asked by /api/me so the
// app can leave the AI controls off the page entirely for an account that never
// gave one, rather than offering buttons that answer 503. Reads the null-ness of
// the column, so nothing is decrypted to find out.
async function hasOpenAiKey(id) {
  const { rows } = await db.query('SELECT openai_key IS NOT NULL AS present FROM users WHERE id = $1', [id]);
  return Boolean(rows.length && rows[0].present);
}

/* ---------- the one suggestion run on the deployment's key ---------- */

/**
 * Claim this account's single category suggestion on the instance's own OpenAI
 * key. Returns true when the claim was this call's.
 *
 * A conditional UPDATE rather than a read followed by a write: setup is a page
 * anyone can reload, and two requests arriving together must not both come back
 * "not used yet" and spend the operator's money twice. The row itself is the
 * lock, so this holds across processes as well as across requests.
 */
async function claimHostedSuggestion(id) {
  const { rowCount } = await db.query(
    'UPDATE users SET hosted_suggest_at = now() WHERE id = $1 AND hosted_suggest_at IS NULL',
    [id]
  );
  return rowCount > 0;
}

// Hand the claim back when the call it was taken for produced nothing. A failed
// request bills nobody, so spending someone's one free suggestion on a network
// hiccup would be a bug, not a policy.
function releaseHostedSuggestion(id) {
  return db.query('UPDATE users SET hosted_suggest_at = NULL WHERE id = $1', [id]);
}

async function hostedSuggestionUsed(id) {
  const { rows } = await db.query('SELECT hosted_suggest_at FROM users WHERE id = $1', [id]);
  return Boolean(rows.length && rows[0].hosted_suggest_at);
}

/**
 * Erase an account. Every table that holds user data declares
 * `REFERENCES users(id) ON DELETE CASCADE`, so removing the row takes the
 * rules, overrides, AI reviews, spend accounting and cached transactions with
 * it. Two things are deliberately outside that cascade:
 *
 * - `user_sessions` has no foreign key (it is express-session's table, keyed by
 *   sid), so a session on another device would otherwise survive the account it
 *   authenticates. Deleted here by the userId inside the session document.
 * - `fx_rates` is shared between users and holds no personal data — one
 *   account's departure must not cost everyone else their rate history.
 */
async function deleteAccount(id) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM user_sessions WHERE (sess->>'userId')::bigint = $1", [id]);
    const { rowCount } = await client.query('DELETE FROM users WHERE id = $1', [id]);
    await client.query('COMMIT');
    return rowCount > 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function markOnboarded(id) {
  return db.query('UPDATE users SET onboarded_at = now() WHERE id = $1', [id]);
}

/**
 * Take a place under the cap by finishing setup. Returns true when the account
 * has one, false when the instance is full.
 *
 * This is the enforcement point, not the sign-in check. A place costs memory
 * and it is finishing setup that spends it, so the count and the mark have to
 * happen together: without the lock, two people submitting setup at the same
 * moment both read "one place left" and both take it — the same race the signup
 * lock guards at account creation, moved to where the resource now is. The same
 * lock key is reused deliberately, because the two are counting the same thing.
 *
 * Idempotent for an account that already finished. Setup is a page that can be
 * submitted twice (a retry, a double click), and the second submission must not
 * be told the instance is full when the account it belongs to is already in.
 */
async function claimAccountPlace(id) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query(
      'SELECT onboarded_at, is_demo FROM users WHERE id = $1', [id]
    );
    if (!existing.length) {
      await client.query('COMMIT');
      return false;
    }
    if (existing[0].onboarded_at) {
      await client.query('COMMIT');
      return true; // already has its place; nothing to count
    }

    await client.query('SELECT pg_advisory_xact_lock($1)', [SIGNUP_LOCK_KEY]);
    const cap = maxUsers();
    let total = null;
    if (cap > 0) {
      const { rows } = await client.query(
        'SELECT count(*)::int AS n FROM users WHERE onboarded_at IS NOT NULL AND NOT is_demo'
      );
      if (rows[0].n >= cap) {
        await client.query('COMMIT');
        console.warn(`Setup refused: at the ${cap}-account cap`);
        return false;
      }
      total = rows[0].n + 1;
    }
    await client.query('UPDATE users SET onboarded_at = now() WHERE id = $1', [id]);
    await client.query('COMMIT');
    if (!existing[0].is_demo) {
      announceSignup(total === null ? await countUsers() : total, cap);
    }
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const isOnboarded = (user) => Boolean(user && user.onboarded_at);

// Ids of every account that finished onboarding and has an OpenAI key, oldest
// first — who the background sweep should review for. Filtering in SQL keeps
// the scheduler from decrypting keys just to discover there are none.
async function onboardedWithOpenAiKey() {
  // A demo account has no key, so `openai_key IS NOT NULL` already excludes it.
  // Named here anyway because the sweep is the one loop that spends money on a
  // schedule, and a later change to how demo reviews work must not be able to
  // put an unauthenticated account into it by accident.
  const { rows } = await db.query(
    `SELECT id FROM users
     WHERE onboarded_at IS NOT NULL AND openai_key IS NOT NULL AND NOT is_demo
     ORDER BY id`
  );
  return rows.map((r) => r.id);
}

module.exports = {
  upsertByGoogle, upsertByEmail, byId, setKeys, getKeys, hasOpenAiKey, markOnboarded, isOnboarded,
  claimAccountPlace,
  onboardedWithOpenAiKey, deleteAccount,
  claimHostedSuggestion, releaseHostedSuggestion, hostedSuggestionUsed,
  maxUsers, countUsers, atCapacity, addToWaitlist, waitingCount,
  // exported for tests: the log is this deployment's only cap notification, so
  // the escalation is behaviour worth pinning rather than an implementation detail
  _internal: { announceSignup },
};
