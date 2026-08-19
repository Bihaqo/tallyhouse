'use strict';

// Manual per-transaction classification overrides, keyed by (user, Lunchflow
// transaction id) and stored in Postgres. An entry is either a bare kind string
// (the compact form, when there's no category) or an object carrying a manual
// spending category:
//
//   "spend" | "excluded"                                  (current)
//   "internal" | "invest" | "renovation" | "tax"           (legacy kinds)
//   | { "kind": "spend", "categoryId": "travel" }
//   | { "categoryId": "travel" }
//
// analytics.overrideFor() understands both shapes, so they're stored verbatim.

const db = require('./db');
const { OVERRIDE_STATES } = require('./analytics');

// The whole override map for a user: { [txId]: entry }.
async function getAll(userId) {
  const { rows } = await db.query('SELECT tx_id, entry FROM overrides WHERE user_id = $1', [userId]);
  const map = {};
  for (const row of rows) map[row.tx_id] = row.entry;
  return map;
}

function entryOf(raw) {
  if (typeof raw === 'string') return { kind: raw, categoryId: null };
  if (raw && typeof raw === 'object') {
    return {
      kind: OVERRIDE_STATES.includes(raw.kind) ? raw.kind : null,
      categoryId: typeof raw.categoryId === 'string' && raw.categoryId.trim() ? raw.categoryId : null,
    };
  }
  return { kind: null, categoryId: null };
}

async function current(userId, id) {
  const { rows } = await db.query('SELECT entry FROM overrides WHERE user_id = $1 AND tx_id = $2', [userId, id]);
  return entryOf(rows.length ? rows[0].entry : null);
}

async function store(userId, id, { kind, categoryId }) {
  let entry;
  if (!kind && !categoryId) {
    await db.query('DELETE FROM overrides WHERE user_id = $1 AND tx_id = $2', [userId, id]);
    return;
  }
  if (kind && !categoryId) entry = kind; // compact form
  else entry = { ...(kind ? { kind } : {}), categoryId };
  await db.query(
    `INSERT INTO overrides (user_id, tx_id, entry) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, tx_id) DO UPDATE SET entry = EXCLUDED.entry`,
    [userId, id, JSON.stringify(entry)]
  );
}

// Set (or clear, with null) the kind override; keeps any pinned category.
// Returns true if anything changed.
async function set(userId, txId, state) {
  const id = String(txId);
  const next = OVERRIDE_STATES.includes(state) ? state : null;
  const cur = await current(userId, id);
  if (cur.kind === next) return false;
  // 'excluded' is the one state that stands alone: it drops the transaction
  // from everything, so a pinned category alongside it would be meaningless.
  await store(userId, id, { kind: next, categoryId: next === 'excluded' ? null : cur.categoryId });
  return true;
}

// Pin a category for one transaction by id (null clears it). Returns true if
// anything changed. Pinning any category clears a 'spend' kind, which only
// exists to force a transaction back to uncategorised spending.
async function setCategory(userId, txId, categoryId) {
  const id = String(txId);
  const next = typeof categoryId === 'string' && categoryId.trim() ? categoryId.trim() : null;
  const cur = await current(userId, id);
  if (cur.categoryId === next) return false;
  await store(userId, id, { kind: next ? null : cur.kind, categoryId: next });
  return true;
}

// Bulk replace, used by the data import: wipes the user's overrides and loads
// the given { txId: entry } map.
async function replaceAll(userId, map) {
  await db.query('DELETE FROM overrides WHERE user_id = $1', [userId]);
  const entries = Object.entries(map || {});
  for (const [txId, entry] of entries) {
    await db.query('INSERT INTO overrides (user_id, tx_id, entry) VALUES ($1, $2, $3)', [
      userId,
      String(txId),
      JSON.stringify(entry),
    ]);
  }
}

module.exports = { getAll, set, setCategory, replaceAll };
