'use strict';

const h = require('./helpers/db'); // sets DATABASE_URL before src/ loads
const test = require('node:test');
const assert = require('node:assert/strict');
const skip = h.skip;

const rules = require('../src/rules');
const { classify } = require('../src/analytics');
const defaults = require('../config/settings.json');

test.before(async () => { if (h.dbAvailable) await h.initDb(); });

test('a new user gets the shipped defaults', { skip }, async () => {
  const userId = await h.freshUser();
  assert.deepEqual(await rules.get(userId), defaults);
});

// Patterns name the people and places a household pays, so shipping a real set
// would publish one family's private life to everyone who installs this. A new
// account starts empty and fills up from onboarding and the per-row AI review.
test('the shipped defaults carry no keyword patterns and no personal data', () => {
  for (const cat of defaults.categories) {
    assert.deepEqual(cat.patterns, [], `${cat.name} ships a pattern`);
  }
  // Exactly one category, and only so the transfer detector has somewhere to
  // put the pairs it finds.
  assert.deepEqual(defaults.categories.map((c) => c.id), ['internal-transfers']);
  assert.equal(defaults.categories[0].autoTransfers, true);
  assert.equal(rules.validate(defaults), null, 'and it is still a valid document');
});

test('replace validates and stays per-user', { skip }, async () => {
  const userId = await h.freshUser();
  assert.match((await rules.replace(userId, null)).error, /object/);
  assert.match((await rules.replace(userId, { ...defaults, currency: 'XYZ' })).error, /currency/);
  assert.match((await rules.replace(userId, { ...defaults, categories: 'nope' })).error, /categories/);
  assert.match((await rules.replace(userId, { ...defaults, categories: [{ id: 'a', name: '', patterns: ['x'] }] })).error, /name/);
  assert.match((await rules.replace(userId, { ...defaults, categories: [{ id: 'a', name: 'A', patterns: ['x', ''] }] })).error, /patterns/);
  assert.match(
    (await rules.replace(userId, { ...defaults, categories: [
      { id: 'a', name: 'A', patterns: ['x'] }, { id: 'b', name: 'a', patterns: ['y'] }] })).error,
    /duplicate/i
  );
  // ids must be unique too, since overrides resolve against them
  assert.match(
    (await rules.replace(userId, { ...defaults, categories: [
      { id: 'a', name: 'A', patterns: ['x'] }, { id: 'a', name: 'B', patterns: ['y'] }] })).error,
    /duplicate category id/i
  );
  // a failed replace leaves the current rules untouched
  assert.deepEqual(await rules.get(userId), defaults);
});

test('replace persists and reloads', { skip }, async () => {
  const userId = await h.freshUser();
  const doc = JSON.parse(JSON.stringify(defaults));
  doc.categories.push({ id: 'test-category', name: 'Test category', patterns: ['test merchant'] });
  const result = await rules.replace(userId, doc);
  assert.equal(result.error, undefined);
  const reloaded = await rules.get(userId);
  assert.ok(reloaded.categories.some((c) => c.name === 'Test category'));
});

test('addPattern appends without trimming and creates missing entries', { skip }, async () => {
  const userId = await h.freshUser();
  const added = await rules.addPattern(userId, { name: 'Pubs', pattern: 'pub2 ' });
  assert.equal(added.error, undefined);
  const entry = (await rules.get(userId)).categories.find((c) => c.name === 'Pubs');
  assert.deepEqual(entry.patterns, ['pub2 ']);

  // Re-adding is a no-op (name matching is case-insensitive).
  await rules.addPattern(userId, { name: 'pubs', pattern: 'pub2 ' });
  assert.deepEqual((await rules.get(userId)).categories.find((c) => c.name === 'Pubs').patterns, ['pub2 ']);

  // Existing categories are addressed by their stable id, names only create.
  await rules.addPattern(userId, { categoryId: 'internal-transfers', pattern: 'my own transfer' });
  const transfers = (await rules.get(userId)).categories.find((c) => c.id === 'internal-transfers');
  assert.ok(transfers.patterns.includes('my own transfer'));

  assert.match((await rules.addPattern(userId, { pattern: 'x' })).error, /categoryId or name/);
  assert.match((await rules.addPattern(userId, { name: 'X', pattern: '  ' })).error, /pattern/);
  assert.match((await rules.addPattern(userId, { group: 'categories', pattern: 'x' })).error, /name/);
});

test('rule edits are picked up by classification immediately', { skip }, async () => {
  const userId = await h.freshUser();
  const mystery = {
    id: 'm1', date: '2026-06-01', amount: -25, merchant: 'Mystery Vendor',
    currency: 'GBP', account_id: 1, is_pending: false,
  };
  assert.equal(classify([mystery], {}, await rules.get(userId))[0].category, 'Other');
  await rules.addPattern(userId, { group: 'categories', name: 'Test category', pattern: 'mystery vendor' });
  assert.equal(classify([mystery], {}, await rules.get(userId))[0].category, 'Test category');
});

test('two users have independent rules', { skip }, async () => {
  const a = await h.freshUser();
  const b = await h.freshUser();
  await rules.addPattern(a, { group: 'categories', name: 'OnlyA', pattern: 'only-a' });
  assert.ok((await rules.get(a)).categories.some((c) => c.name === 'OnlyA'));
  assert.ok(!(await rules.get(b)).categories.some((c) => c.name === 'OnlyA'));
});

test('legacy documents migrate to the unified category list on read', () => {
  const legacy = {
    currencySymbol: '£',
    transferPatterns: ['own account'],
    investments: [
      { name: 'Coinvault', patterns: ['coinvault', 'cvx'] },
      { name: 'Meridian Metals', patterns: ['meridian metals'] },
    ],
    renovations: [{ name: 'Airconco', patterns: ['airconco'] }],
    taxes: [{ name: 'HMRC', patterns: ['hmrc'] }],
    categories: [
      { name: 'Groceries', patterns: ['tesco'] },
      { name: 'Car', patterns: ['shell'], excludeFromChart: true },
    ],
  };
  const doc = rules.migrate(legacy);
  assert.equal(rules.validate(doc), null);
  // The display-only symbol becomes the currency the account is actually kept in.
  assert.equal(doc.currency, 'GBP');
  assert.ok(!('currencySymbol' in doc));

  const byId = Object.fromEntries(doc.categories.map((c) => [c.id, c]));
  // The per-payee entries collapse into one pattern list per group.
  assert.deepEqual(byId.investments.patterns, ['coinvault', 'cvx', 'meridian metals']);
  assert.ok(byId.investments.tracker && byId.investments.excludeFromSpending);
  assert.ok(byId.renovation.tracker);
  assert.ok(byId.taxes.tracker);

  // Transfers are excluded but get no tracker section, and absorb auto-detection.
  assert.equal(byId['internal-transfers'].excludeFromSpending, true);
  assert.equal(byId['internal-transfers'].tracker, false);
  assert.equal(byId['internal-transfers'].autoTransfers, true);

  // Ordinary categories keep their order after the four special ones.
  assert.equal(byId.groceries.excludeFromSpending, false);
  // Carried through from the source document. migrate() used to switch this on
  // for any category named "Car", which was one household's preference imposed
  // on every install; a document that does not ask for it must not get it.
  assert.equal(byId.car.excludeFromChart, true);
  assert.equal(byId.groceries.excludeFromChart, undefined);
  assert.deepEqual(doc.categories.map((c) => c.id).slice(0, 5),
    ['internal-transfers', 'investments', 'renovation', 'taxes', 'groceries']);

  // The ids legacy overrides resolve against must exist.
  for (const id of Object.values(rules.LEGACY_KIND_IDS)) assert.ok(byId[id], `missing ${id}`);
});

test('a tracker may still count as spending', { skip }, async () => {
  // The two flags are independent: this is a spotlight section for a category
  // that stays in the spending totals.
  const userId = await h.freshUser();
  const doc = { ...defaults, categories: [{ id: 'a', name: 'A', patterns: ['x'], tracker: true }] };
  assert.equal((await rules.replace(userId, doc)).error, undefined);
  const reloaded = await rules.get(userId);
  assert.equal(reloaded.categories[0].tracker, true);
  assert.ok(!reloaded.categories[0].excludeFromSpending);
});

test('openaiConcurrency is validated and falls back to the env default', () => {
  const doc = { ...defaults };
  assert.equal(rules.concurrencyOf(doc), rules.CONCURRENCY_DEFAULT); // unset
  assert.equal(rules.concurrencyOf({ ...doc, openaiConcurrency: 5 }), 5);
  // Clamped rather than trusted, in case a stored document predates the cap.
  assert.equal(rules.concurrencyOf({ ...doc, openaiConcurrency: 999 }), rules.CONCURRENCY_MAX);
  assert.equal(rules.concurrencyOf(null), rules.CONCURRENCY_DEFAULT);

  assert.equal(rules.validate({ ...doc, openaiConcurrency: 4 }), null);
  for (const bad of [0, -1, 2.5, '3', rules.CONCURRENCY_MAX + 1]) {
    assert.match(rules.validate({ ...doc, openaiConcurrency: bad }), /openaiConcurrency/, String(bad));
  }
});

/* ---------- the AI settings setup chooses ---------- */

test('the review window is per account, validated, and defaults to the deployment setting', () => {
  const doc = { ...defaults };
  const previous = process.env.OPENAI_SWEEP_MONTHS;
  try {
    // Read per call, not at load time, so a deployment can change it without a
    // restart — and so an account that has chosen is unaffected by the change.
    process.env.OPENAI_SWEEP_MONTHS = '6';
    assert.equal(rules.monthsOf(doc), 6);
    assert.equal(rules.monthsOf(null), 6);
    assert.equal(rules.monthsOf({ ...doc, aiMonths: 1 }), 1);
    delete process.env.OPENAI_SWEEP_MONTHS;
    assert.equal(rules.monthsOf(doc), 12, 'the shipped fallback');
    // Clamped rather than trusted, in case a stored document predates the cap.
    assert.equal(rules.monthsOf({ ...doc, aiMonths: 999 }), rules.MONTHS_MAX);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_SWEEP_MONTHS;
    else process.env.OPENAI_SWEEP_MONTHS = previous;
  }

  assert.equal(rules.validate({ ...doc, aiMonths: 3 }), null);
  for (const bad of [0, -1, 2.5, '3', rules.MONTHS_MAX + 1]) {
    assert.match(rules.validate({ ...doc, aiMonths: bad }), /aiMonths/, String(bad));
  }
});

test('the merchant web search is a per-account switch, on unless turned off', () => {
  const doc = { ...defaults };
  assert.equal(rules.webSearchOf(doc), true, 'unset accounts keep the behaviour they had');
  assert.equal(rules.webSearchOf({ ...doc, aiWebSearch: false }), false);
  const previous = process.env.OPENAI_WEB_SEARCH;
  try {
    process.env.OPENAI_WEB_SEARCH = '0';
    assert.equal(rules.webSearchOf(doc), false, 'a deployment can default it off');
    assert.equal(rules.webSearchOf({ ...doc, aiWebSearch: true }), true, 'an explicit choice still wins');
  } finally {
    if (previous === undefined) delete process.env.OPENAI_WEB_SEARCH;
    else process.env.OPENAI_WEB_SEARCH = previous;
  }

  assert.equal(rules.validate({ ...doc, aiWebSearch: false }), null);
  assert.match(rules.validate({ ...doc, aiWebSearch: 'no' }), /aiWebSearch/);
});

test('withAiSettings writes only what setup actually chose', () => {
  const doc = rules.documentFromSuggestions([{ name: 'Groceries' }], { currency: 'EUR' });
  const both = rules.withAiSettings(doc, { months: 3, webSearch: false });
  assert.equal(rules.validate(both), null);
  assert.equal(both.aiMonths, 3);
  assert.equal(both.aiWebSearch, false);
  assert.equal(both.currency, 'EUR', 'the rest of the document is untouched');
  assert.deepEqual(both.categories, doc.categories);

  // Nothing chosen leaves the fields absent, so the account keeps following the
  // deployment default rather than being pinned to today's value.
  const neither = rules.withAiSettings(doc, {});
  assert.equal('aiMonths' in neither, false);
  assert.equal('aiWebSearch' in neither, false);
  assert.deepEqual(rules.withAiSettings(doc), neither);
  // And the original is left alone.
  assert.equal('aiMonths' in doc, false);
});

/* ---------- currency ---------- */

test('the currency setting only accepts codes the rate source can quote', () => {
  assert.equal(rules.validate({ ...defaults, currency: 'EUR' }), null);
  for (const bad of ['', '£', 'gbp!', 'XYZ', 'BTC', null, 42]) {
    assert.match(rules.validate({ ...defaults, currency: bad }), /currency/, String(bad));
  }
});

// The setting used to be a free-text display symbol pasted in front of totals
// that were converted to GBP whatever it said. Reading it as a currency is a
// best interpretation of an intent that was never fully expressed, so an
// unreadable one has to land somewhere harmless rather than throw.
test('a document written before the currency setting existed is read on the way out', () => {
  const read = (currencySymbol) => rules.normalize({ currencySymbol, categories: [] }).currency;
  assert.equal(read('£'), 'GBP');
  assert.equal(read('€'), 'EUR');
  assert.equal(read('$'), 'USD', 'the likeliest of the dollars, and one dropdown to correct');
  assert.equal(read('USD'), 'USD', 'the field was three characters wide, so some hold a code');
  assert.equal(read('kr'), 'GBP', 'four currencies use it — falls back rather than guessing');
  assert.equal(read('~~'), 'GBP');

  const normalized = rules.normalize({ currencySymbol: '£', categories: [] });
  assert.ok(!('currencySymbol' in normalized), 'and the old field does not survive the read');
  assert.equal(rules.validate(normalized), null);
});

test('normalize leaves a current document alone', () => {
  const doc = { ...defaults, currency: 'SEK' };
  assert.equal(rules.normalize(doc), doc, 'same object, so reads stay cheap');
  // A currency a client got wrong is left for validate() to reject rather than
  // swapped for the default, which would redenominate every total in silence.
  assert.equal(rules.normalize({ ...defaults, currency: 'XYZ' }).currency, 'XYZ');
});

test('the stored currency is canonical whatever case it arrives in', { skip }, async () => {
  const userId = await h.freshUser();
  assert.equal((await rules.replace(userId, { ...defaults, currency: 'sek' })).error, undefined);
  assert.equal((await rules.get(userId)).currency, 'SEK');
});

/* ---------- onboarding suggestions -> a rules document ---------- */

test('documentFromSuggestions takes the currency setup detected', () => {
  assert.equal(rules.documentFromSuggestions([], { currency: 'eur' }).currency, 'EUR');
  // Nothing detected, or something the rate source cannot quote: the default,
  // which the user can change in settings.
  assert.equal(rules.documentFromSuggestions([], {}).currency, defaults.currency);
  assert.equal(rules.documentFromSuggestions([], { currency: 'XYZ' }).currency, defaults.currency);
});

test('documentFromSuggestions slugs ids, empties patterns and keeps one transfer home', () => {
  const doc = rules.documentFromSuggestions([
    { name: 'Internal transfers', excludeFromSpending: true, tracker: false, autoTransfers: true },
    { name: 'Eating out', excludeFromSpending: false, tracker: false, autoTransfers: false },
    { name: 'Bills & utilities', excludeFromSpending: false, tracker: false, autoTransfers: false },
  ]);
  assert.equal(rules.validate(doc), null);
  assert.deepEqual(doc.categories.map((c) => c.id),
    ['internal-transfers', 'eating-out', 'bills-utilities']);
  // Patterns come later, from the per-row review where they can be previewed.
  for (const cat of doc.categories) assert.deepEqual(cat.patterns, []);
  assert.equal(doc.categories.filter((c) => c.autoTransfers).length, 1);
});

test('documentFromSuggestions tolerates a model that proposes no transfer category', () => {
  const doc = rules.documentFromSuggestions([
    { name: 'Groceries', excludeFromSpending: false, tracker: false, autoTransfers: false },
  ]);
  assert.equal(rules.validate(doc), null);
  const auto = doc.categories.filter((c) => c.autoTransfers);
  assert.equal(auto.length, 1, 'one is added, or detected pairs have nowhere to go');
  assert.equal(auto[0].excludeFromSpending, true);
});

test('documentFromSuggestions drops a second transfer category rather than failing', () => {
  const doc = rules.documentFromSuggestions([
    { name: 'Transfers', excludeFromSpending: true, tracker: false, autoTransfers: true },
    { name: 'Moves', excludeFromSpending: true, tracker: false, autoTransfers: true },
  ]);
  assert.equal(rules.validate(doc), null, 'only one category may absorb transfers');
  assert.equal(doc.categories.filter((c) => c.autoTransfers).length, 1);
  assert.equal(doc.categories.length, 2, 'the second is kept, just not as the transfer home');
});

test('documentFromSuggestions ignores blanks and duplicate names', () => {
  const doc = rules.documentFromSuggestions([
    { name: 'Groceries' }, { name: '  ' }, { name: 'groceries' }, { name: null },
  ]);
  assert.deepEqual(doc.categories.filter((c) => !c.autoTransfers).map((c) => c.name), ['Groceries']);
});

test('an autoTransfers suggestion is forced out of spending', () => {
  const doc = rules.documentFromSuggestions([
    { name: 'Transfers', excludeFromSpending: false, tracker: false, autoTransfers: true },
  ]);
  assert.equal(doc.categories[0].excludeFromSpending, true);
});
