'use strict';

// Account deletion against Postgres: what the cascade takes, what it must leave
// behind, and that a sweep can't outlive the account it was reviewing for.
// Skips unless TEST_DATABASE_URL is set.
process.env.MOCK_DATA = '1';

const h = require('./helpers/db'); // sets DATABASE_URL before src/ loads
const test = require('node:test');
const assert = require('node:assert/strict');
const skip = h.skip;

const users = require('../src/users');
const gpt = require('../src/gpt');

test.before(async () => { if (h.dbAvailable) await h.initDb(); });

// Give a user a row in every table that hangs off the account.
async function fill(userId) {
  await h.query('INSERT INTO rules (user_id, doc) VALUES ($1, $2)', [userId, { categories: [] }]);
  await h.query('INSERT INTO overrides (user_id, tx_id, entry) VALUES ($1, $2, $3)', [userId, 'tx-1', '"excluded"']);
  await h.query('INSERT INTO ai_reviews (user_id, tx_id, review) VALUES ($1, $2, $3)', [userId, 'tx-1', { verdict: 'ok' }]);
  await h.query('INSERT INTO ai_usage (user_id, stats) VALUES ($1, $2)', [userId, { totalReviews: 3 }]);
  await h.query(
    'INSERT INTO transactions_cache (user_id, cached_at, accounts, txs) VALUES ($1, $2, $3, $4)',
    [userId, Date.now(), JSON.stringify([]), JSON.stringify([])]
  );
  await h.query(
    "INSERT INTO user_sessions (sid, sess, expire) VALUES ($1, $2, now() + interval '1 day')",
    [`sid-${userId}`, { userId, email: 'x@example.com' }]
  );
}

const PER_USER_TABLES = ['rules', 'overrides', 'ai_reviews', 'ai_usage', 'transactions_cache'];

async function counts(userId) {
  const out = {};
  for (const t of PER_USER_TABLES) {
    const { rows } = await h.query(`SELECT count(*)::int AS n FROM ${t} WHERE user_id = $1`, [userId]);
    out[t] = rows[0].n;
  }
  const { rows } = await h.query(
    "SELECT count(*)::int AS n FROM user_sessions WHERE (sess->>'userId')::bigint = $1",
    [userId]
  );
  out.sessions = rows[0].n;
  return out;
}

test('deleting an account removes every row it owns', { skip }, async () => {
  const id = await h.freshUser();
  await fill(id);
  assert.deepEqual(await counts(id),
    { rules: 1, overrides: 1, ai_reviews: 1, ai_usage: 1, transactions_cache: 1, sessions: 1 });

  assert.equal(await users.deleteAccount(id), true);

  assert.deepEqual(await counts(id),
    { rules: 0, overrides: 0, ai_reviews: 0, ai_usage: 0, transactions_cache: 0, sessions: 0 });
  assert.equal(await users.byId(id), null);
});

test('deleting an account leaves other accounts untouched', { skip }, async () => {
  const mine = await h.freshUser();
  const theirs = await h.freshUser();
  await fill(mine);
  await fill(theirs);

  await users.deleteAccount(mine);

  assert.deepEqual(await counts(theirs),
    { rules: 1, overrides: 1, ai_reviews: 1, ai_usage: 1, transactions_cache: 1, sessions: 1 });
});

// A session is only reachable by its sid, so nothing else would ever clean it
// up — it would keep authenticating requests as a user id that no longer exists.
test('deleting an account revokes its sessions on every device', { skip }, async () => {
  const id = await h.freshUser();
  await h.query(
    "INSERT INTO user_sessions (sid, sess, expire) VALUES ($1, $2, now() + interval '1 day'), ($3, $4, now() + interval '1 day')",
    [`phone-${id}`, { userId: id }, `laptop-${id}`, { userId: id }]
  );

  await users.deleteAccount(id);

  const { rows } = await h.query('SELECT count(*)::int AS n FROM user_sessions WHERE sid IN ($1, $2)',
    [`phone-${id}`, `laptop-${id}`]);
  assert.equal(rows[0].n, 0);
});

// fx_rates is a shared cache keyed by currency+date, not by user. One account
// leaving must not cost everyone else their rate history.
test('deleting an account keeps the shared FX rate cache', { skip }, async () => {
  const id = await h.freshUser();
  const pair = `ZZZ|2026-01-0${(id % 9) + 1}`;
  await h.query('INSERT INTO fx_rates (pair, rate, rate_date) VALUES ($1, 1.5, $2) ON CONFLICT DO NOTHING',
    [pair, '2026-01-01']);

  await users.deleteAccount(id);

  const { rows } = await h.query('SELECT count(*)::int AS n FROM fx_rates WHERE pair = $1', [pair]);
  assert.equal(rows[0].n, 1);
});

test('deleting an unknown account reports that nothing was removed', { skip }, async () => {
  assert.equal(await users.deleteAccount(2147483600), false);
});

// The delete races requests already in flight: a sweep that starts *after* the
// account is gone has no state to cancel, so the guard has to be a tombstone
// rather than a flag on the running sweep.
test('a sweep started after deletion does no work', { skip }, async () => {
  const id = await h.freshUser();
  gpt.forgetUser(id);

  const status = await gpt.sweep(id);

  assert.equal(status.running, false);
  assert.equal(status.total, 0);
});

test('a review requested after deletion is refused rather than billed', { skip }, async () => {
  const id = await h.freshUser();
  gpt.forgetUser(id);

  await assert.rejects(() => gpt.review(id, 'tx-1'), /deleted/i);
});
