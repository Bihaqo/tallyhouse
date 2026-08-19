'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const analytics = require('../src/analytics');
const { buildSummary, classify, listTransactions } = analytics;
const { fixtureRules } = require('./helpers/rules');

// Rules are per-user data now; the analytics helpers take the document as an
// argument, and calls below that omit it use whatever was primed last. The
// fixture is fabricated -- see test/helpers/rules.js for why.
const RULES = fixtureRules();
analytics.classify([], {}, RULES);

// buildSummary only counts the trailing twelve months, so anchor date-sensitive
// cases on the current one rather than a literal that ages out of the window.
const thisMonth = new Date().toISOString().slice(0, 7);
const dayIn = (n) => `${thisMonth}-${String(n).padStart(2, '0')}`;

const tx = (id, date, amount, merchant = 'SMALLABLE', currency = 'GBP') => ({
  id, date, amount, merchant, currency, account_id: 1, is_pending: false,
});

test('a return offsets the closest sufficient purchase from the same merchant', () => {
  const result = classify([
    tx('older', '2026-04-01', -100),
    tx('too-small', '2026-06-10', -50),
    tx('closest', '2026-05-20', -90),
    tx('return', '2026-06-16', 75),
  ]);

  const byId = Object.fromEntries(result.map((item) => [item.tx.id, item]));
  assert.equal(byId.closest.effectiveAmount, -15);
  assert.equal(byId.closest.refundAmount, 75);
  assert.equal(byId.older.effectiveAmount, -100);
  assert.equal(byId['too-small'].effectiveAmount, -50);
  assert.equal(byId.return.effectiveAmount, 0);
  assert.equal(byId.return.returnOf.id, 'closest');

  const listed = listTransactions([{ id: 1, name: 'Main' }], [
    tx('closest', '2026-05-20', -90),
    tx('return', '2026-06-16', 75),
  ], new Set(['2026-05', '2026-06']));
  const listedById = Object.fromEntries(listed.map((item) => [item.id, item]));
  assert.equal(listedById.closest.originalAmount, -90);
  assert.equal(listedById.closest.amount, -15);
  assert.deepEqual(listedById.closest.returnTransactions, [
    { id: 'return', date: '2026-06-16', amount: 75 },
  ]);
  assert.deepEqual(listedById.return.returnOf, { id: 'closest', date: '2026-05-20' });
  assert.equal(listedById.return.originalAmount, 75);
});

test('summary totals use converted base amounts for foreign transactions', () => {
  const usd = {
    ...tx('usd-spend', '2026-06-14', -100, 'Foreign merchant', 'USD'),
    base_currency: 'GBP',
    exchange_rate: 0.75,
    exchange_rate_date: '2026-06-12',
    base_amount: -75,
  };
  const summary = buildSummary([], [usd]);
  const june = summary.months.find((month) => month.month === '2026-06');
  assert.equal(june.spend, 75);

  const [listed] = listTransactions([], [usd], '2026-06');
  assert.equal(listed.originalAmount, -100);
  assert.equal(listed.baseAmount, -75);
  assert.equal(listed.exchangeRateDate, '2026-06-12');
});

test('returns do not match later, pending, other-currency, or other-merchant debits', () => {
  const result = classify([
    tx('later', '2026-06-17', -100),
    { ...tx('pending', '2026-06-15', -100), is_pending: true },
    tx('currency', '2026-06-15', -100, 'SMALLABLE', 'EUR'),
    tx('merchant', '2026-06-15', -100, 'OTHER'),
    tx('return', '2026-06-16', 75),
  ]);

  const refund = result.find((item) => item.tx.id === 'return');
  assert.equal(refund.effectiveAmount, 75);
  assert.equal(refund.returnOf, null);
});

test('explicit transfer patterns take precedence over return matching', () => {
  // Same payee on both legs would otherwise look like a purchase and its refund.
  const result = classify([
    tx('out', '2026-06-14', -49000, 'To Own Account'),
    tx('in', '2026-06-30', 2000, 'From Own Account'),
  ], {}, RULES);
  const byId = Object.fromEntries(result.map((item) => [item.tx.id, item]));

  assert.equal(byId.out.categoryId, 'internal-transfers');
  assert.equal(byId.in.categoryId, 'internal-transfers');
  assert.equal(byId.out.refundAmount, 0);
  assert.equal(byId.in.returnOf, null);
  assert.equal(byId.out.effectiveAmount, -49000);
  assert.equal(byId.in.effectiveAmount, 2000);
});

test('currency exchange transactions are treated as internal transfers', () => {
  const [exchange] = classify([
    tx('exchange', '2026-06-30', -39828.31, 'Exchanged to GBP', 'USD'),
  ]);

  assert.equal(exchange.kind, 'tracked');
  assert.equal(exchange.categoryId, 'internal-transfers');
  assert.equal(exchange.trackerId, null); // transfers have no tracker section
  assert.equal(exchange.category, null);
});

test('merchant references and small spelling differences still match returns', () => {
  const result = classify([
    tx('amazon', '2026-05-05', -120, 'Amazon* No81k2z54'),
    tx('amazon-return', '2026-05-22', 97.8, 'AMAZON* N61YY90P4'),
    tx('clinic', '2026-05-01', -90, 'Bodymatters Clinic'),
    tx('clinic-return', '2026-05-30', 30, 'Bodymaters Clinic'),
  ]);
  const byId = Object.fromEntries(result.map((item) => [item.tx.id, item]));

  assert.equal(byId.amazon.effectiveAmount, -22.2);
  assert.equal(byId['amazon-return'].returnOf.id, 'amazon');
  assert.equal(byId.clinic.effectiveAmount, -60);
  assert.equal(byId['clinic-return'].returnOf.id, 'clinic');
});

/* ---------- the pattern engine ---------- */

test('a pattern matches the description as well as the merchant', () => {
  const [item] = classify([{
    ...tx('dd', '2026-06-01', -50, 'Utility Co'),
    description: 'FRESHMART 8827461 DDR',
  }], {}, RULES);
  assert.equal(item.category, 'Groceries');
});

test('an "=" pattern matches the exact name only, not merchants containing it', () => {
  const byId = Object.fromEntries(classify([
    tx('exact', '2026-06-01', -20, 'Quicktrain'),
    tx('longer', '2026-06-01', -20, 'Quicktrain National'),
  ], {}, RULES).map((i) => [i.tx.id, i]));

  assert.equal(byId.exact.category, 'Subscriptions'); // =quicktrain, listed first
  assert.equal(byId.longer.category, 'Transport');    // plain substring, further down
});

test('a pattern ending in a space matches whole words only', () => {
  const byId = Object.fromEntries(classify([
    tx('word', '2026-06-01', -20, 'BP Fuel'),
    tx('suffix', '2026-06-01', -20, 'Payment in GBP'),
  ], {}, RULES).map((i) => [i.tx.id, i]));

  assert.equal(byId.word.category, 'Transport');
  // haystack() joins merchant and description with a space, so "...gbp" used to
  // end in "bp " and get filed as fuel.
  assert.equal(byId.suffix.category, 'Other');
});

test('a trailing "*" matches whatever follows it', () => {
  const [item] = classify([tx('topup', '2026-06-01', -20, 'Top-Up by *4416')], {}, RULES);
  assert.equal(item.categoryId, 'internal-transfers');
});

test('the first matching category in list order wins', () => {
  const [item] = classify([tx('both', '2026-06-01', -20, 'Streamly at Freshmart')], {}, RULES);
  assert.equal(item.category, 'Subscriptions');
});

/* ---------- the two category flags ---------- */

test('excludeFromSpending with a tracker gets its own section and leaves the totals', () => {
  const payment = tx('tax', dayIn(20), -2500, 'Revenue Office');
  const [item] = classify([payment], {}, RULES);
  assert.equal(item.kind, 'tracked');
  assert.equal(item.trackerName, 'Taxes');
  assert.equal(item.category, null, 'tracked rows carry no spending category');

  const summary = buildSummary([], [payment], {}, RULES);
  const month = summary.months.find((m) => m.month === thisMonth);
  assert.equal(month.spend, 0);
  assert.equal(month.chartSpend, 0);
  const taxes = summary.trackers.find((t) => t.id === 'taxes');
  assert.equal(taxes.total12m, 2500);
  assert.equal(taxes.breakdown[0].name, 'Revenue Office');
  assert.ok(!summary.categoriesYearAvg.some((c) => c.category === 'Taxes'));
});

test('excludeFromChart keeps a category in the totals but out of the bars', () => {
  const summary = buildSummary([], [
    tx('normal', dayIn(10), -50, 'Unmatched Vendor'),
    tx('car', dayIn(11), -1000, 'Motorworks Garage'),
  ], {}, RULES);
  const month = summary.months.find((m) => m.month === thisMonth);

  assert.equal(month.spend, 1050, 'the total includes it');
  assert.equal(month.chartSpend, 50, 'the bar does not');
  assert.deepEqual(summary.categoriesOffChart, ['Car'], 'and the chart says so');
});

test('a tracker excluded from spending reports its own merchants', () => {
  const summary = buildSummary([], [
    tx('reno', dayIn(12), -300, 'Plasterfix Ltd'),
    tx('invest', dayIn(13), -500, 'Brokerbox Savings'),
  ], {}, RULES);
  const month = summary.months.find((m) => m.month === thisMonth);
  assert.equal(month.spend, 0, 'neither counts as spending');

  const byId = Object.fromEntries(summary.trackers.map((t) => [t.id, t]));
  assert.equal(byId.renovation.total12m, 300);
  assert.equal(byId.renovation.breakdown[0].name, 'Plasterfix Ltd');
  assert.equal(byId.investments.total12m, 500);
});

test('a manual category override beats the keyword rules for spend rows', () => {
  const unknown = tx('t1', '2026-06-05', -20, 'Some Unknown Merchant');
  const [asOther] = classify([unknown]);
  assert.equal(asOther.category, 'Other');

  const [asTravel] = classify([unknown], { t1: { categoryId: 'travel' } });
  assert.equal(asTravel.kind, 'spend');
  assert.equal(asTravel.category, 'Travel');
  assert.equal(asTravel.categoryOverride, 'Travel');

  // Legacy bare-string overrides still work.
  const [asInternal] = classify([unknown], { t1: 'internal' });
  assert.equal(asInternal.categoryId, 'internal-transfers');

  // Combined kind + category object form.
  const [both] = classify([unknown], { t1: { kind: 'spend', category: 'Travel' } });
  assert.equal(both.kind, 'spend');
  assert.equal(both.category, 'Travel');

  // The category shows up as the label in transaction lists.
  const [listed] = listTransactions([{ id: 1, name: 'Main' }], [unknown], '2026-06', {
    t1: { category: 'Travel' },
  });
  assert.equal(listed.label, 'Travel');
  assert.equal(listed.categoryOverride, 'Travel');
});

test('similarMatches finds spelling variants of the same merchant', () => {
  const { similarMatches } = require('../src/analytics');
  const txs = [
    tx('target', '2026-06-01', -1704, 'AIRCONCO (UK) LTD'),
    tx('variant', '2026-05-02', -900, 'Airconco Ltd'),
    tx('exact', '2026-04-03', -600, 'AIRCONCO (UK) LTD'),
    tx('unrelated', '2026-06-12', -12, 'Tesco Stores'),
  ];
  const similar = similarMatches([{ id: 1, name: 'Main' }], txs, 'target');

  assert.equal(similar.count, 2); // the variant and the exact repeat, not Tesco
  assert.equal(similar.target.merchant, 'AIRCONCO (UK) LTD');
  assert.deepEqual(similar.matches.map((m) => m.id), ['exact', 'variant']); // closest first
  assert.ok(similar.matches[0].similarity > similar.matches[1].similarity);
  assert.equal(similar.totalBase, -1500); // converted total of the matches
  assert.ok(!similar.matches.some((m) => m.id === 'target')); // never itself
});

test('similarMatches returns an empty result for an unknown transaction', () => {
  const { similarMatches } = require('../src/analytics');
  const similar = similarMatches([], [tx('a', '2026-06-01', -30)], 'nope');
  assert.equal(similar.count, 0);
  assert.equal(similar.target, null);
});

test('previewMatches reports matches with their current classification', () => {
  const { previewMatches } = require('../src/analytics');
  const txs = [
    tx('a', '2026-06-01', -30, 'Borough Wine Rooms'),
    tx('b', '2026-06-10', -45, 'Borough Wine Rooms'),
    tx('c', '2026-06-12', -12, 'Tesco Stores'),
  ];
  const preview = previewMatches([{ id: 1, name: 'Main' }], txs, ['borough wine'], {}, 1);
  assert.equal(preview.count, 2);
  assert.deepEqual(preview.byLabel, { Other: 2 });
  assert.equal(preview.matches.length, 1); // respects the limit
  assert.equal(preview.matches[0].date, '2026-06-10'); // newest first
  assert.equal(preview.matches[0].label, 'Other');
});

test('an excluded transaction is dropped from all totals but stays listed', () => {
  const spend = tx('keep', '2026-06-10', -50, 'Unclassified merchant');
  const gone = tx('gone', '2026-06-11', -500, 'Unclassified merchant two');

  const summary = buildSummary([], [spend, gone], { gone: 'excluded' });
  const june = summary.months.find((month) => month.month === '2026-06');
  assert.equal(june.spend, 50);
  assert.equal(summary.manuallyExcluded, 1);

  const listed = listTransactions([{ id: 1, name: 'Main' }], [spend, gone], '2026-06', { gone: 'excluded' });
  const listedById = Object.fromEntries(listed.map((item) => [item.id, item]));
  assert.equal(listedById.gone.kind, 'excluded');
  assert.equal(listedById.gone.override, 'excluded');
  assert.equal(listedById.keep.kind, 'spend');

  // Excluded rows never absorb refunds as return matches.
  const purchase = tx('p', '2026-06-01', -100, 'Shop');
  const refund = tx('r', '2026-06-05', 100, 'Shop');
  const [p] = classify([purchase, refund], { p: 'excluded' });
  assert.equal(p.refundAmount, 0);
});

test('legacy override kinds resolve to the categories they became', () => {
  const unknown = tx('t1', '2026-06-05', -20, 'Some Unknown Merchant');
  const cases = {
    internal: ['internal-transfers', null],
    invest: ['investments', 'Investments'],
    renovation: ['renovation', 'Renovation'],
    tax: ['taxes', 'Taxes'],
  };
  for (const [kind, [categoryId, trackerName]] of Object.entries(cases)) {
    const [bare] = classify([unknown], { t1: kind });
    assert.equal(bare.kind, 'tracked', kind);
    assert.equal(bare.categoryId, categoryId, kind);
    assert.equal(bare.trackerName, trackerName, kind);
    // The object form carries the same legacy kind.
    const [obj] = classify([unknown], { t1: { kind } });
    assert.equal(obj.categoryId, categoryId, kind);
  }
  // 'excluded' is a separate axis and survives unification unchanged.
  const [dropped] = classify([unknown], { t1: 'excluded' });
  assert.equal(dropped.kind, 'excluded');
});

test('tracker and exclude-from-spending are independent flags', () => {
  // A spotlight on a category that still counts as spending.
  const doc = {
    currency: 'GBP',
    categories: [
      { id: 'groceries', name: 'Groceries', patterns: ['tesco'], tracker: true },
      { id: 'taxes', name: 'Taxes', patterns: ['hmrc'], excludeFromSpending: true, tracker: true },
      { id: 'transfers', name: 'Transfers', patterns: ['own account'], excludeFromSpending: true },
    ],
  };
  const txs = [
    tx('shop', '2026-06-02', -40, 'TESCO STORES'),
    tx('hmrc', '2026-06-03', -2500, 'HMRC SELF ASSESSMENT'),
    tx('move', '2026-06-04', -900, 'OWN ACCOUNT'),
  ];
  const summary = buildSummary([], txs, {}, doc);
  const june = summary.months.find((m) => m.month === '2026-06');

  // Groceries is tracked AND still in the spending total; the other two are not.
  assert.equal(june.spend, 40); // only Groceries counts towards spending
  assert.ok(summary.categoriesYearAvg.some((c) => c.category === 'Groceries'));
  assert.ok(!summary.categoriesYearAvg.some((c) => ['Taxes', 'Transfers'].includes(c.category)));

  const byId = Object.fromEntries(summary.trackers.map((t) => [t.id, t]));
  assert.equal(byId.groceries.total12m, 40);
  assert.equal(byId.groceries.excludeFromSpending, false);
  assert.equal(byId.taxes.total12m, 2500);
  assert.equal(byId.taxes.excludeFromSpending, true);
  assert.ok(!byId.transfers, 'excluded without the tracker flag gets no section');

  // classify still reports the tracker on a row that counts as spending.
  const [shop] = classify([txs[0]], {}, doc);
  assert.equal(shop.kind, 'spend');
  assert.equal(shop.trackerId, 'groceries');
  assert.equal(shop.category, 'Groceries');
});

/* ---------- the shared classification pass ---------- */

// classify() reuses the last result for a given transaction array so the several
// endpoints one page load hits don't each redo the work. These pin down that it
// only ever reuses a result computed from the same overrides and rules.

const memoDoc = {
  currency: 'GBP',
  categories: [
    { id: 'groceries', name: 'Groceries', patterns: ['tesco'], excludeFromSpending: false, tracker: false },
    { id: 'taxes', name: 'Taxes', patterns: ['hmrc'], excludeFromSpending: true, tracker: true },
  ],
};

test('the same inputs reuse one classification pass', () => {
  const txs = [tx('a', '2026-06-02', -40, 'TESCO STORES')];
  assert.equal(classify(txs, {}, memoDoc), classify(txs, {}, memoDoc));
});

test('changing an override recomputes rather than reusing the pass', () => {
  const txs = [tx('a', '2026-06-02', -40, 'TESCO STORES')];
  assert.equal(classify(txs, {}, memoDoc)[0].kind, 'spend');
  assert.equal(classify(txs, { a: 'excluded' }, memoDoc)[0].kind, 'excluded');
  // ...and back again, so the reuse is keyed on the inputs and not just on order.
  assert.equal(classify(txs, {}, memoDoc)[0].kind, 'spend');
});

test('editing the rules recomputes rather than reusing the pass', () => {
  const txs = [tx('a', '2026-06-02', -40, 'TESCO STORES')];
  assert.equal(classify(txs, {}, memoDoc)[0].category, 'Groceries');

  const renamed = JSON.parse(JSON.stringify(memoDoc));
  renamed.categories[0].name = 'Food';
  assert.equal(classify(txs, {}, renamed)[0].category, 'Food');

  const repointed = JSON.parse(JSON.stringify(memoDoc));
  repointed.categories[0].patterns = ['sainsbury'];
  assert.equal(classify(txs, {}, repointed)[0].category, 'Other');
});

test('override key order does not decide whether the pass is reused', () => {
  const txs = [tx('a', '2026-06-02', -40, 'TESCO STORES'), tx('b', '2026-06-03', -2500, 'HMRC')];
  const first = classify(txs, { a: 'excluded', b: 'spend' }, memoDoc);
  const reordered = {};
  reordered.b = 'spend';
  reordered.a = 'excluded';
  assert.equal(classify(txs, reordered, memoDoc), first);
});

/* ---------- the equal-amount transfer heuristic ---------- */

const transferDoc = {
  currency: 'GBP',
  categories: [
    { id: 'transfers', name: 'Internal transfers', patterns: ['top-up by'],
      excludeFromSpending: true, autoTransfers: true },
    { id: 'investments', name: 'Investments', patterns: ['trading 212'],
      excludeFromSpending: true, tracker: true },
    { id: 'fitness', name: 'Health & fitness', patterns: ['massage'] },
  ],
};

test('an equal amount does not erase a payment a rule already explains', () => {
  // A brokerage deposit and an unrelated top-up of the same size, same day.
  const result = classify([
    tx('deposit', '2026-05-03', -20000, 'TRADING 212'),
    tx('topup', '2026-05-03', 20000, 'Top-Up by *1016'),
  ], {}, transferDoc);
  const byId = Object.fromEntries(result.map((i) => [i.tx.id, i]));
  assert.equal(byId.deposit.categoryId, 'investments', 'the deposit stays an investment');
  assert.equal(byId.deposit.trackerId, 'investments');
  assert.equal(byId.topup.categoryId, 'transfers', 'the top-up is still a transfer by its own pattern');
});

test('an equal amount does not erase ordinary spending', () => {
  const result = classify([
    tx('massage', '2026-05-12', -50, 'Thu An Massage'),
    tx('frommyself', '2026-05-09', 50, 'From Own Account'),
  ], {}, transferDoc);
  const byId = Object.fromEntries(result.map((i) => [i.tx.id, i]));
  assert.equal(byId.massage.kind, 'spend');
  assert.equal(byId.massage.category, 'Health & fitness');
});

test('two unexplained equal amounts across accounts are still paired as a transfer', () => {
  // Different payees, or the refund matcher claims the pair first (and should).
  const out = tx('out', '2026-05-03', -750, 'SENDING SIDE LTD');
  const inn = { ...tx('in', '2026-05-04', 750, 'ARRIVING BANK PLC'), account_id: 2 };
  const result = classify([out, inn], {}, transferDoc);
  for (const item of result) {
    assert.equal(item.kind, 'tracked', 'still detected without any rule naming it');
    assert.equal(item.categoryId, 'transfers');
  }
});

test('money excluded from spending without a tracker is reported, not swallowed', () => {
  const doc = {
    currency: 'GBP',
    categories: [
      { id: 'transfers', name: 'Internal transfers', patterns: ['own account'],
        excludeFromSpending: true, autoTransfers: true },
      { id: 'renovation', name: 'Renovation', patterns: ['builder'], excludeFromSpending: true },
    ],
  };
  const month = new Date().toISOString().slice(0, 7);
  const s = buildSummary([], [
    tx('r1', `${month}-05`, -1000, 'BUILDER LTD'),
    tx('t1', `${month}-06`, -500, 'OWN ACCOUNT'),
  ], {}, doc);

  assert.equal(s.internalTransfersIgnored, 2);
  const byId = Object.fromEntries(s.hiddenFromSpending.map((h) => [h.id, h]));
  assert.equal(byId.renovation.total, 1000, 'renovation money is named, not lumped into transfers');
  assert.equal(byId.renovation.count, 1);
  assert.equal(byId.transfers.total, 500);
});
