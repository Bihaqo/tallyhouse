'use strict';

// The transaction cache now lives in Postgres (transactions_cache), so "survives
// a restart" becomes "survives a cold read": populate it, drop the in-memory
// per-user state by re-requiring is unnecessary — exportTransactions reads
// straight from the table.
process.env.MOCK_DATA = '1';

const h = require('./helpers/db'); // sets DATABASE_URL before src/ loads
const test = require('node:test');
const assert = require('node:assert/strict');
const skip = h.skip;

const summary = require('../src/summary');

test.before(async () => { if (h.dbAvailable) await h.initDb(); });

test('a fetched summary populates the per-user cache, readable afterwards', { skip }, async () => {
  const userId = await h.freshUser();
  const built = await summary.getSummary(userId);
  assert.ok(built.accounts.length, 'summary has accounts');

  // The raw pull was persisted and can be read back without re-fetching.
  const snapshot = await summary.exportTransactions(userId);
  assert.ok(snapshot && Number.isFinite(snapshot.cachedAt));
  assert.ok(Array.isArray(snapshot.accounts) && snapshot.accounts.length);
  assert.ok(Array.isArray(snapshot.txs) && snapshot.txs.length);
});

test('an expired cache is served immediately and refreshed behind the request', { skip }, async () => {
  const userId = await h.freshUser();
  // Past the 15-minute TTL, but inside the serve-stale ceiling.
  const cachedAt = Date.now() - 20 * 60 * 1000;
  await summary.importTransactions(userId, {
    cachedAt,
    accounts: [{ id: 991, name: 'Stale Account', currency: 'GBP' }],
    txs: [{ id: 's1', account_id: 991, amount: -5, currency: 'GBP', date: '2026-06-01', merchant: 'Stale Co' }],
  });

  // The request answers from the stale copy rather than waiting on the API.
  const served = await summary.getSummary(userId);
  assert.deepEqual(served.accounts.map((a) => a.name), ['Stale Account']);

  // ...while a refresh runs in the background and replaces it.
  const deadline = Date.now() + 5000;
  let refreshed = await summary.exportTransactions(userId);
  while (refreshed.cachedAt === cachedAt && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    refreshed = await summary.exportTransactions(userId);
  }
  assert.notEqual(refreshed.cachedAt, cachedAt, 'background refresh replaced the stale pull');
  assert.ok(!refreshed.accounts.some((a) => a.name === 'Stale Account'));
});

test('a long-abandoned cache waits for fresh data rather than showing old numbers', { skip }, async () => {
  const userId = await h.freshUser();
  // Older than STALE_SERVE_MINUTES (60 by default) — the "back after a week" case.
  await summary.importTransactions(userId, {
    cachedAt: Date.now() - 7 * 24 * 60 * 60 * 1000,
    accounts: [{ id: 993, name: 'Stale Account', currency: 'GBP' }],
    txs: [{ id: 's3', account_id: 993, amount: -5, currency: 'GBP', date: '2026-06-01', merchant: 'Stale Co' }],
  });
  const served = await summary.getSummary(userId);
  assert.ok(!served.accounts.some((a) => a.name === 'Stale Account'),
    'data past the serve-stale ceiling is refreshed before it is shown');
});

test('a forced refresh waits for fresh data instead of serving the stale copy', { skip }, async () => {
  const userId = await h.freshUser();
  await summary.importTransactions(userId, {
    cachedAt: 1700000000000,
    accounts: [{ id: 992, name: 'Stale Account', currency: 'GBP' }],
    txs: [{ id: 's2', account_id: 992, amount: -5, currency: 'GBP', date: '2026-06-01', merchant: 'Stale Co' }],
  });
  const forced = await summary.getSummary(userId, { force: true });
  assert.ok(!forced.accounts.some((a) => a.name === 'Stale Account'));
});

test('importTransactions seeds a user cache from a snapshot', { skip }, async () => {
  const userId = await h.freshUser();
  const snapshot = {
    cachedAt: 1700000000000,
    accounts: [{ id: 1, name: 'Imported', currency: 'GBP' }],
    txs: [{ id: 'x1', account_id: 1, amount: -5, currency: 'GBP', date: '2026-06-01', merchant: 'Imported Co' }],
  };
  await summary.importTransactions(userId, snapshot);
  const back = await summary.exportTransactions(userId);
  assert.equal(back.cachedAt, snapshot.cachedAt);
  assert.equal(back.txs[0].merchant, 'Imported Co');
});
