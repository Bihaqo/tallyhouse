'use strict';

// Pure unit tests for the review helpers. No database or network: the OpenAI
// plumbing and per-user persistence are covered by test/gpt.db.test.js.
process.env.MOCK_DATA = '1';
delete process.env.OPENAI_API_KEY;

const test = require('node:test');
const assert = require('node:assert/strict');
const analytics = require('../src/analytics');
const { classify } = analytics;
const { _internal } = require('../src/gpt');

// A fabricated document, not the shipped defaults, which carry no patterns on
// purpose -- see test/helpers/rules.js.
const { fixtureRules } = require('./helpers/rules');
const DEFAULTS = fixtureRules();
const CATS = DEFAULTS.categories.map((c) => c.name);
analytics.classify([], {}, DEFAULTS);

const tx = (id, date, amount, merchant = 'SMALLABLE', currency = 'GBP') => ({
  id, date, amount, merchant, currency, account_id: 1, is_pending: false,
});

test('amountStats computes count/mean/std/min/max', () => {
  assert.equal(_internal.amountStats([]), null);
  assert.deepEqual(_internal.amountStats([10, 20]), { count: 2, mean: 15, std: 5, min: 10, max: 20 });
  assert.deepEqual(_internal.amountStats([7, 7, 7]), { count: 3, mean: 7, std: 0, min: 7, max: 7 });
});

test('categoryStats groups spend by category, ignoring income and internal rows', () => {
  const classified = classify([
    tx('a', '2026-06-01', -10, 'Freshmart Local'),
    tx('b', '2026-06-02', -30, 'Freshmart Local'),
    tx('c', '2026-06-03', 500, 'ACME SALARY'), // income: excluded
    tx('d', '2026-06-04', -100, 'Brokerbox Savings'), // investment: excluded
  ]);
  const stats = _internal.categoryStats(classified);
  const groceries = stats.find((s) => s.category === 'Groceries');
  assert.deepEqual(groceries, { category: 'Groceries', count: 2, mean: 20, std: 10, min: 10, max: 30 });
  assert.ok(!stats.some((s) => s.category === null));
});

test('merchantStats summarizes the merchant history excluding the reviewed transaction', () => {
  const txs = [
    tx('t1', '2026-06-01', -10, 'Borough Wine Rooms'),
    tx('t2', '2026-06-08', -20, 'Borough Wine Rooms'),
    tx('t3', '2026-06-15', -90, 'Borough Wine Rooms'),
    tx('t4', '2026-06-20', -5, 'Freshmart Local'),
  ];
  const classified = classify(txs);
  const stats = _internal.merchantStats(classified, txs[2]);
  assert.equal(stats.count, 2); // t3 itself excluded
  assert.equal(stats.mean, 15);
  assert.equal(stats.lastDate, '2026-06-08');
});

test('recentTransactions returns only preceding transactions, capped, oldest first', () => {
  const txs = [];
  for (let i = 1; i <= 120; i++) {
    txs.push(tx(`t${i}`, `2026-${String(1 + Math.floor(i / 40)).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, -i, 'Freshmart Local'));
  }
  const target = tx('target', '2026-12-31', -50, 'Freshmart Local');
  txs.push(target);
  const classified = classify(txs);
  const accountName = new Map([[1, 'Main']]);

  const lines = _internal.recentTransactions(classified, target, accountName);
  assert.equal(lines.length, 100); // capped
  assert.ok(!lines.some((l) => l.includes('target')));
  const firstDate = lines[0].slice(0, 10);
  const lastDate = lines[lines.length - 1].slice(0, 10);
  assert.ok(firstDate <= lastDate);

  const none = _internal.recentTransactions(classified, tx('early', '2020-01-01', -1), accountName);
  assert.equal(none.length, 0); // nothing precedes it
});

test('buildInput contains the transaction, stats and preceding transactions', () => {
  const txs = [
    tx('prev', '2026-06-01', -10, 'Freshmart Local'),
    tx('subject', '2026-06-10', -55.5, 'Borough Wine Rooms'),
  ];
  const classified = classify(txs);
  const item = classified.find((c) => c.tx.id === 'subject');
  const input = _internal.buildInput({ item, classified, accountName: new Map([[1, 'Main']]) });

  assert.match(input, /Borough Wine Rooms/);
  assert.match(input, /-55.5 GBP/);
  assert.match(input, /Current classification: Other/);
  assert.match(input, /Groceries: n=1/);
  assert.match(input, /Freshmart Local/);
});

test('buildInstructions lists the current categories', () => {
  const instructions = _internal.buildInstructions(CATS);
  assert.match(instructions, /Groceries/);
  assert.match(instructions, /Available categories/);
});

test('buildInstructions offers the non-spending categories and names the real accounts', () => {
  const instructions = _internal.buildInstructions([...CATS, 'Internal transfers'], {
    excludedNames: ['Internal transfers'],
    accountName: new Map([[1, 'Revolut ···0000 GBP'], [2, 'Barclays Personal Account 1']]),
  });
  // Withholding these left the reviewer unable to call a transfer a transfer.
  assert.match(instructions, /not spending/);
  assert.match(instructions, /Internal transfers/);
  assert.match(instructions, /Revolut ···0000 GBP/);
  assert.match(instructions, /Barclays Personal Account 1/);
});

test('turning the merchant search off takes the tool away and stops asking for it', () => {
  const on = _internal.buildInstructions(CATS, { webSearch: true });
  const off = _internal.buildInstructions(CATS, { webSearch: false });
  assert.match(on, /web search/i);
  assert.match(on, /scam/i);
  // The model cannot search without the tool, so the prompt must not send it
  // looking — and must not ask for a scam verdict it has no way to reach.
  assert.doesNotMatch(off, /web search/i);
  assert.match(off, /no web access/i);
  assert.doesNotMatch(off, /widely reported as a scam/i);
  // The rest of the job is unchanged either way.
  for (const instructions of [on, off]) {
    assert.match(instructions, /Available categories/);
    assert.match(instructions, /preview_rule/);
  }

  const named = (tools) => tools.map((t) => t.name || t.type);
  assert.deepEqual(named(_internal.buildTools()), ['web_search', 'preview_rule']);
  assert.deepEqual(named(_internal.buildTools({ webSearch: true })), ['web_search', 'preview_rule']);
  assert.deepEqual(named(_internal.buildTools({ webSearch: false })), ['preview_rule']);
});

test('the setup estimate prices the search separately from the tokens', () => {
  const { estimateCost, costBasis } = require('../src/gpt');
  const basis = costBasis();
  assert.ok(basis.tokensPerReviewUsd > 0);
  // The search is the expensive half, and it is the half a user can switch off —
  // which is the whole reason the estimate is split in two.
  assert.ok(basis.webSearchPerReviewUsd > basis.tokensPerReviewUsd);

  const withSearch = estimateCost({ transactions: 1000, webSearch: true });
  const without = estimateCost({ transactions: 1000, webSearch: false });
  assert.equal(withSearch.perReviewUsd, basis.tokensPerReviewUsd + basis.webSearchPerReviewUsd);
  assert.equal(without.perReviewUsd, basis.tokensPerReviewUsd);
  assert.ok(withSearch.totalUsd > without.totalUsd);
  assert.equal(without.totalUsd, Math.round(basis.tokensPerReviewUsd * 1000 * 100) / 100);
  assert.equal(estimateCost({ transactions: 0 }).totalUsd, 0);
});

test('a rule is not proposed for a transaction that is already classified correctly', () => {
  const [item] = classify([tx('r1', '2026-06-01', -20, 'Some Vendor')]);
  const parsed = {
    assessment: 'correct', suggested_category: null, confidence: 0.9, reasoning: 'r',
    proposed_rule: { pattern: 'some vendor', category: 'Groceries' }, is_outlier: false, outlier_reason: null,
  };
  assert.equal(_internal.normalizeResult(parsed, item, null, CATS).proposedRule, null);
});

test('normalizeResult drops suggestions and rules pointing at unknown categories', () => {
  const [item] = classify([tx('n1', '2026-06-01', -20, 'Some Vendor')]);
  const base = {
    assessment: 'unclassified', suggested_category: 'Nonexistent', confidence: 0.9,
    reasoning: 'r', proposed_rule: { pattern: 'x', category: 'Nope' }, is_outlier: false, outlier_reason: null,
  };
  const result = _internal.normalizeResult(base, item, null, CATS);
  assert.equal(result.suggestedCategory, null);
  assert.equal(result.proposedRule, null);
  assert.equal(result.reviewedCategory, 'Other');

  const good = _internal.normalizeResult(
    { ...base, suggested_category: 'Travel', proposed_rule: { pattern: 'some vendor', category: 'Travel' }, confidence: 0.9 },
    item, null, CATS
  );
  assert.equal(good.suggestedCategory, 'Travel');
  assert.deepEqual(good.proposedRule, { pattern: 'some vendor', category: 'Travel' });

  const correct = _internal.normalizeResult({ ...base, assessment: 'correct', suggested_category: 'Travel' }, item, null, CATS);
  assert.equal(correct.suggestedCategory, null);
});

test('mock reviewer flags unclassified transactions and proposes a rule', () => {
  const classified = classify([tx('m1', '2026-06-01', -20, 'Borough Wine Rooms')]);
  const parsed = _internal.mockReview({ item: classified[0], classified, categoryNames: CATS });
  assert.equal(parsed.assessment, 'unclassified');
  assert.equal(parsed.proposed_rule.pattern, 'borough');
  assert.equal(typeof parsed.is_outlier, 'boolean');
});

test('a proposed rule is dropped unless it matches other transactions, and carries the count', () => {
  const txs = [
    tx('r1', '2026-06-01', -20, 'Borough Wine Rooms'),
    tx('r2', '2026-06-08', -25, 'Borough Wine Rooms'),
    tx('r3', '2026-06-09', -30, 'Borough Wine Rooms'),
    tx('r4', '2026-06-10', -99, 'One Off Vendor'),
  ];
  const classified = classify(txs);
  const context = { accounts: [{ id: 1, name: 'Main' }], txs, overrides: {}, rulesDoc: DEFAULTS };
  const base = {
    assessment: 'unclassified', suggested_category: 'Travel', confidence: 0.9,
    reasoning: 'r', is_outlier: false, outlier_reason: null,
  };

  const kept = _internal.normalizeResult(
    { ...base, proposed_rule: { pattern: 'borough wine', category: 'Travel' } },
    classified[0], context, CATS
  );
  assert.deepEqual(kept.proposedRule, { pattern: 'borough wine', category: 'Travel', matchCount: 2 });

  const dropped = _internal.normalizeResult(
    { ...base, proposed_rule: { pattern: 'one off vendor', category: 'Travel' } },
    classified[3], context, CATS
  );
  assert.equal(dropped.proposedRule, null);

  // Without context (older cache entries / direct calls) the rule passes through untouched.
  const noContext = _internal.normalizeResult(
    { ...base, proposed_rule: { pattern: 'one off vendor', category: 'Travel' } },
    classified[3], null, CATS
  );
  assert.deepEqual(noContext.proposedRule, { pattern: 'one off vendor', category: 'Travel' });
});

test('similarTransactions ranks by merchant edit-distance, then date proximity', () => {
  const txs = [
    tx('exact-far', '2026-01-05', -20, 'Borough Wine Rooms'),
    tx('exact-near', '2026-06-05', -25, 'Borough Wine Rooms'),
    tx('variant', '2026-06-01', -30, 'Borough Wine Rooms*X1'),
    tx('typo', '2026-06-02', -35, 'Borough Wine Room'),
    tx('unrelated', '2026-06-03', -40, 'Freshmart Local'),
    tx('subject', '2026-06-10', -55, 'Borough Wine Rooms'),
  ];
  const classified = classify(txs);
  const subject = txs.find((t) => t.id === 'subject');
  const lines = _internal.similarTransactions(classified, subject, new Map([[1, 'Main']]));

  assert.ok(!lines.some((l) => l.includes('Tesco')), 'unrelated merchants excluded');
  assert.ok(!lines.some((l) => l.includes('-55')), 'the reviewed transaction itself excluded');
  assert.match(lines[0], /-25/);
  assert.match(lines[1], /Borough Wine Rooms\*X1|-20|-35/);
  assert.ok(lines.length >= 4);
});

test('a manual category is treated as ground truth on review', () => {
  const [item] = classify(
    [tx('m1', '2026-06-01', -20, 'Some Vendor')],
    { m1: { category: 'Travel' } }
  );
  assert.equal(item.categoryOverride, 'Travel');
  const result = _internal.normalizeResult({
    assessment: 'wrong_category',
    suggested_category: 'Groceries',
    confidence: 0.9,
    reasoning: 'r',
    proposed_rule: null,
    is_outlier: false,
    outlier_reason: null,
  }, item, null, CATS);
  assert.equal(result.assessment, 'correct');
  assert.equal(result.suggestedCategory, null);
});

test('mock reviewer flags IKEA as miscategorized (Shopping -> Home)', () => {
  const classified = classify([tx('ikea', '2026-06-01', -120, 'IKEA London')]);
  assert.equal(classified[0].category, 'Shopping');
  const parsed = _internal.mockReview({ item: classified[0], classified, categoryNames: CATS });
  assert.equal(parsed.assessment, 'wrong_category');
  assert.equal(parsed.suggested_category, 'Home');
  const result = _internal.normalizeResult(parsed, classified[0], null, CATS);
  assert.equal(result.suggestedCategory, 'Home');
});

test('token usage converts to dollars at the configured prices', () => {
  const cost = _internal.computeCostUsd({ inputTokens: 1000000, cachedInputTokens: 0, outputTokens: 0 });
  assert.ok(Math.abs(cost - 0.25) < 1e-9);
  const cached = _internal.computeCostUsd({ inputTokens: 1000000, cachedInputTokens: 1000000, outputTokens: 0 });
  assert.ok(Math.abs(cached - 0.025) < 1e-9);
  const mixed = _internal.computeCostUsd({ inputTokens: 10000, cachedInputTokens: 4000, outputTokens: 2000 });
  assert.ok(Math.abs(mixed - 0.0056) < 1e-9);

  const total = { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  _internal.addUsage(total, { usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 20 } });
  _internal.addUsage(total, { usage: { input_tokens: 50, output_tokens: 5 } });
  _internal.addUsage(total, {});
  assert.deepEqual(total, { calls: 3, inputTokens: 150, cachedInputTokens: 40, outputTokens: 25 });
});

test('billable tool calls are counted and priced on top of tokens', () => {
  // Web search is billed per call; preview_rule runs locally and is free.
  const searchOnly = _internal.computeCostUsd({ webSearches: 1000 });
  assert.ok(Math.abs(searchOnly - 10.0) < 1e-9);
  const withTokens = _internal.computeCostUsd({ inputTokens: 1000000, webSearches: 5 });
  assert.ok(Math.abs(withTokens - (0.25 + 0.05)) < 1e-9);
  assert.equal(_internal.computeCostUsd({ functionCalls: 12 }), 0);

  // Tool invocations are items in the response output, not fields on `usage`.
  const total = { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, webSearches: 0, functionCalls: 0 };
  _internal.addUsage(total, {
    usage: { input_tokens: 10, output_tokens: 2 },
    output: [{ type: 'web_search_call' }, { type: 'function_call' }, { type: 'message' }],
  });
  _internal.addUsage(total, { usage: { input_tokens: 5 }, output: [{ type: 'web_search_call' }] });
  assert.equal(total.webSearches, 2);
  assert.equal(total.functionCalls, 1);
});

test('model concurrency is limited per API key, not globally', async () => {
  const { withModelSlot } = _internal;
  let running = 0;
  let peakPerKey = 0;
  let peakOverall = 0;
  const perKey = { a: 0, b: 0 };

  // Two keys, three calls each, limit 2 per key: each key must stay within its
  // own limit while the two keys still overlap each other.
  const call = (key) => withModelSlot(`sk-${key}`, 2, async () => {
    perKey[key]++;
    running++;
    peakPerKey = Math.max(peakPerKey, perKey[key]);
    peakOverall = Math.max(peakOverall, running);
    await new Promise((r) => setTimeout(r, 10));
    perKey[key]--;
    running--;
  });

  await Promise.all(['a', 'a', 'a', 'b', 'b', 'b'].map(call));
  assert.ok(peakPerKey <= 2, `one key exceeded its limit: ${peakPerKey}`);
  assert.ok(peakOverall > 2, `keys did not overlap: ${peakOverall}`);
});
