'use strict';

const h = require('./helpers/db'); // sets DATABASE_URL before src/ loads
const test = require('node:test');
const assert = require('node:assert/strict');
const skip = h.skip;

const { PgSessionStore } = require('../src/pg-session-store');

test.before(async () => { if (h.dbAvailable) await h.initDb(); });

const call = (store, method, ...args) =>
  new Promise((resolve, reject) => {
    store[method](...args, (err, val) => (err ? reject(err) : resolve(val)));
  });

test('sessions round-trip through Postgres and honour expiry', { skip }, async () => {
  const store = new PgSessionStore({ pruneIntervalMs: 60 * 60 * 1000 });
  const sid = `s-${process.pid}-${Date.now()}`;
  const sess = { cookie: { expires: new Date(Date.now() + 60_000).toISOString() }, userId: 42 };

  await call(store, 'set', sid, sess);
  const loaded = await call(store, 'get', sid);
  assert.equal(loaded.userId, 42);

  // Destroy removes it.
  await call(store, 'destroy', sid);
  assert.equal(await call(store, 'get', sid), null);

  // An already-expired session is not returned and gets pruned.
  const expiredSid = `e-${process.pid}-${Date.now()}`;
  await call(store, 'set', expiredSid, { cookie: { expires: new Date(Date.now() - 1000).toISOString() }, userId: 7 });
  assert.equal(await call(store, 'get', expiredSid), null);
  await store.prune();
  const { rows } = await h.query('SELECT 1 FROM user_sessions WHERE sid = $1', [expiredSid]);
  assert.equal(rows.length, 0);
});
