'use strict';

// Integration tests for the per-user AI review flows against Postgres. Uses the
// deterministic mock reviewer (MOCK_DATA=1). Skips unless TEST_DATABASE_URL is set.
process.env.MOCK_DATA = '1';
delete process.env.OPENAI_API_KEY;

const h = require('./helpers/db'); // sets DATABASE_URL before src/ loads
const test = require('node:test');
const assert = require('node:assert/strict');
const skip = h.skip;

const analytics = require('../src/analytics');
const { classify } = analytics;
const gpt = require('../src/gpt');
const { getConverted } = require('../src/summary');
const DEFAULTS = require('../config/settings.json');
analytics.classify([], {}, DEFAULTS); // prime rules for the classify() calls below

test.before(async () => { if (h.dbAvailable) await h.initDb(); });

async function reviewCount(userId) {
  const { rows } = await h.query('SELECT count(*)::int AS n FROM ai_reviews WHERE user_id = $1', [userId]);
  return rows[0].n;
}

async function drainSweep(userId, ticks = 600) {
  for (let i = 0; i < ticks && gpt.sweepStatus(userId).running; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('light-mode sweep only targets the 10 most recent "Other" transactions', { skip }, async () => {
  process.env.OPENAI_SWEEP_LIGHT = '1';
  const userId = await h.freshUser();
  try {
    const status = await gpt.sweep(userId);
    assert.ok(status.total <= 10, `expected <= 10, got ${status.total}`);
    await drainSweep(userId, 200);
    const finished = gpt.sweepStatus(userId);
    assert.equal(finished.running, false);
    assert.equal(finished.done, finished.total);
    assert.equal(finished.failed, 0);
    assert.ok((await reviewCount(userId)) >= finished.total);
  } finally {
    delete process.env.OPENAI_SWEEP_LIGHT;
  }
});

test('outlier inbox lists flagged transactions and marking reviewed dismisses them', { skip }, async () => {
  const userId = await h.freshUser();
  const { txs } = await getConverted(userId, { preferCached: true });
  const big = txs.filter((t) => t.merchant === 'Tesco Stores' && t.amount < -700)
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  assert.ok(big, 'mock data should contain an anomalous Tesco charge');

  const review = await gpt.review(userId, String(big.id));
  assert.equal(review.isOutlier, true);

  const inbox = await gpt.listOutliers(userId);
  const entry = inbox.byMerchant.flatMap((g) => g.outliers).find((o) => o.id === String(big.id));
  assert.ok(entry, 'flagged transaction appears in the inbox');
  assert.ok(entry.reason);
  assert.equal(entry.merchant, 'Tesco Stores');
  assert.ok(inbox.reviewedCount >= 1);
  assert.ok(inbox.flaggedCount >= 1);
  for (let i = 1; i < inbox.byMerchant.length; i++) {
    assert.ok(inbox.byMerchant[i - 1].total >= inbox.byMerchant[i].total, 'sorted by flagged total');
  }
  const weekCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assert.ok(inbox.recent.every((o) => o.date >= weekCutoff));

  assert.equal(await gpt.ackOutlier(userId, big.id), true);
  const after = await gpt.listOutliers(userId);
  assert.ok(!after.byMerchant.flatMap((g) => g.outliers).some((o) => o.id === String(big.id)),
    'reviewed outlier leaves the inbox');
  assert.ok(after.flaggedCount >= 1, 'acked outliers still count as flagged');
  assert.equal(await gpt.ackOutlier(userId, 'no-such-tx'), false);
});

test('the sweep fills gaps in its window without redoing cached reviews', { skip }, async () => {
  process.env.OPENAI_SWEEP_MONTHS = '1';
  const userId = await h.freshUser();
  try {
    const { txs } = await getConverted(userId, { preferCached: true });
    const from = new Date();
    const cutoff = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}`;
    const eligible = classify(txs).filter((item) =>
      !item.tx.is_pending && item.kind === 'spend' && item.tx.amount < 0 && !item.returnOf);
    const inWindow = eligible.filter((item) => item.tx.date.slice(0, 7) >= cutoff);
    assert.ok(inWindow.length > 1, 'current month has eligible transactions');

    const seedId = String(inWindow[0].tx.id);
    const seeded = await gpt.review(userId, seedId);
    const seededAt = seeded.at;

    const status = await gpt.sweep(userId);
    assert.deepEqual(status.config, { light: false, months: 1 });
    await drainSweep(userId);
    assert.equal(gpt.sweepStatus(userId).running, false);

    assert.ok(status.total < inWindow.length, 'only uncached transactions queued');
    const cachedInWindow = await gpt.cached(userId, inWindow.map((item) => String(item.tx.id)));
    assert.equal(Object.keys(cachedInWindow).length, inWindow.length, 'window fully covered afterwards');
    assert.equal(cachedInWindow[seedId].at, seededAt, 'cached review not redone');
  } finally {
    delete process.env.OPENAI_SWEEP_MONTHS;
  }
});

test('re-reviews keep human decisions; a stale prompt version does not auto-recompute', { skip }, async () => {
  const userId = await h.freshUser();
  const { txs } = await getConverted(userId, { preferCached: true });
  const big = txs.filter((t) => t.merchant === 'Tesco Stores' && t.amount < -700)
    .sort((a, b) => (a.date < b.date ? 1 : -1))[1];
  assert.ok(big, 'mock data has a second anomalous Tesco charge');

  const first = await gpt.review(userId, String(big.id));
  assert.equal(first.isOutlier, true);
  await gpt.ackOutlier(userId, big.id);

  // A cached review is served regardless of prompt version.
  const cachedAgain = await gpt.review(userId, String(big.id));
  assert.equal(cachedAgain.at, first.at, 'cached review served');

  // An explicit force recomputes but keeps the human ack.
  const second = await gpt.review(userId, String(big.id), { force: true });
  assert.equal(second.isOutlier, true);
  assert.equal(second.outlierReviewed, true, 'human outlier ack survives the re-review');
  const inbox = await gpt.listOutliers(userId);
  assert.ok(!inbox.byMerchant.flatMap((g) => g.outliers).some((o) => o.id === String(big.id)));
});

test('usageSummary reports zero for a brand-new user', { skip }, async () => {
  const userId = await h.freshUser();
  const usage = await gpt.usageSummary(userId);
  assert.equal(usage.totalReviews, 0);
  assert.equal(usage.costUsd, 0);
  assert.ok(usage.model && usage.prices);
});

test('reported cost is one figure covering tokens and billable tools', { skip }, async () => {
  const tokensOnly = gpt._internal.computeCostUsd({ inputTokens: 1e6, outputTokens: 1e6 });
  const withSearches = gpt._internal.computeCostUsd({ inputTokens: 1e6, outputTokens: 1e6, webSearches: 100 });
  assert.ok(withSearches > tokensOnly, 'web searches are inside the total, not alongside it');
  assert.equal(
    round4(withSearches - tokensOnly),
    round4((100 * gpt._internal.PRICE_WEB_SEARCH_PER_1K) / 1000),
    'the tool share is exactly the search price, so nothing is double counted'
  );
  // The split field is deliberately gone: one number, not two budgets.
  const userId = await h.freshUser();
  assert.ok(!('webSearchCostUsd' in await gpt.usageSummary(userId)));
});

const round4 = (n) => Math.round(n * 10000) / 10000;
