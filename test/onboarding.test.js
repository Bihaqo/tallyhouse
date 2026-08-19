'use strict';

// Setup, over real HTTP, in the order the pages walk it: connect, price the AI
// review, confirm the categories.
//
// The shape matters more than any one assertion here. Step 1 pulls the user's
// transactions and refuses to go on if there are none, because everything after
// it is derived from that pull — what the review will cost, and which categories
// are worth suggesting — and because an account set up against a key with no
// bank connected to it lands on an empty dashboard with no way to tell that from
// a broken app.

process.env.MOCK_DATA = '1';
delete process.env.GOOGLE_CLIENT_ID; // lets the passwordless dev login stand in
delete process.env.GOOGLE_CLIENT_SECRET;

const h = require('./helpers/db'); // sets DATABASE_URL before src/ loads
const test = require('node:test');
const assert = require('node:assert/strict');
const skip = h.skip;

let base = null;
let rules = null;

test.before(async () => {
  if (!h.dbAvailable) return;
  await h.initDb();
  rules = require('../src/rules');
  const { app } = require('../server');
  await new Promise((resolve) => {
    const server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.unref();
  });
});

// One signed-in, not-yet-onboarded account, and a caller bound to its session.
async function newAccount(label) {
  let cookie = '';
  const call = async (path, body, method = 'POST') => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const login = await call('/api/dev-login', { email: `${label}-${Date.now()}@example.com` });
  assert.equal(login.status, 200, 'dev login available');
  return call;
}

test('step one reports what is behind the key, priced per review', { skip }, async () => {
  const call = await newAccount('scan');
  const { status, body } = await call('/api/onboarding/scan', { lunchflow: 'lf-key' });
  assert.equal(status, 200);
  assert.ok(body.accounts > 0, 'the connected accounts');
  assert.ok(body.transactions > 0, 'and what they hold');
  assert.ok(body.merchants > 0, 'the payees the category suggestion will read');
  assert.equal(typeof body.currency, 'string');

  // Newest month first, so the estimate can take the N months the user asks for
  // off the front of the list without knowing today's date.
  const months = body.months;
  assert.ok(months.length > 1);
  for (const m of months) assert.match(m.month, /^\d{4}-\d{2}$/);
  assert.deepEqual([...months].sort((a, b) => (a.month < b.month ? 1 : -1)), months);
  const counted = months.reduce((n, m) => n + m.transactions, 0);
  assert.ok(counted > 0 && counted <= body.transactions, 'money out is a subset of everything');

  // The two halves of a review, so the page can follow the web-search box
  // without asking the server again on every keystroke.
  assert.ok(body.cost.tokensPerReviewUsd > 0);
  assert.ok(body.cost.webSearchPerReviewUsd > 0);
});

test('a key with nothing behind it stops setup where it can still be fixed', { skip }, async () => {
  const call = await newAccount('empty');
  const mock = require('../src/mock');
  const accounts = mock.getAccounts;
  const transactions = mock.getTransactions;
  try {
    mock.getAccounts = async () => [];
    const none = await call('/api/onboarding/scan', { lunchflow: 'lf-key' });
    assert.equal(none.status, 400);
    assert.match(none.body.error, /no accounts are connected/);

    // Connected, but the first sync has not landed yet — a different problem,
    // and one that fixes itself, so it says so rather than blaming the key.
    mock.getAccounts = accounts;
    mock.getTransactions = async () => [];
    const quiet = await call('/api/onboarding/scan', { lunchflow: 'lf-key' });
    assert.equal(quiet.status, 400);
    assert.match(quiet.body.error, /no transactions/);
  } finally {
    mock.getAccounts = accounts;
    mock.getTransactions = transactions;
  }

  assert.equal((await call('/api/onboarding/scan', {})).status, 400, 'and the key is required');
});

test('the AI settings chosen during setup land in the rules document', { skip }, async () => {
  const call = await newAccount('ai-settings');
  assert.equal((await call('/api/onboarding/scan', { lunchflow: 'lf-key' })).status, 200);

  const suggested = await call('/api/onboarding/categories', { lunchflow: 'lf-key', openai: 'oa-key' });
  assert.equal(suggested.status, 200);
  assert.ok(suggested.body.categories.length, 'the mock reviewer proposes a starting list');

  const done = await call('/api/onboarding', {
    lunchflow: 'lf-key',
    openai: 'oa-key',
    currency: 'EUR',
    categories: suggested.body.categories,
    ai: { months: 3, webSearch: false },
  });
  assert.equal(done.status, 200);

  const doc = (await call('/api/rules', undefined, 'GET')).body;
  assert.equal(doc.aiMonths, 3);
  assert.equal(doc.aiWebSearch, false);
  assert.equal(doc.currency, 'EUR');
  assert.ok(doc.categories.length > 1, 'and the categories that were ticked');
  // The form shows these as placeholders, so it can say what an account that has
  // not chosen is currently getting.
  assert.equal(typeof doc.aiMonthsDefault, 'number');
  assert.equal(typeof doc.aiWebSearchDefault, 'boolean');
  assert.equal(doc.aiMonthsMax, rules.MONTHS_MAX);
});

test('an import brings its own categories, but not this account\'s AI settings', { skip }, async () => {
  const call = await newAccount('import');
  assert.equal((await call('/api/onboarding/scan', { lunchflow: 'lf-key' })).status, 200);

  const done = await call('/api/onboarding', {
    lunchflow: 'lf-key',
    openai: 'oa-key',
    ai: { months: 2, webSearch: true },
    data: {
      schemaVersion: 1,
      data: {
        rules: {
          currency: 'SEK',
          categories: [{ id: 'imported', name: 'Imported', patterns: ['tesco'], excludeFromSpending: false, tracker: false }],
        },
      },
    },
  });
  assert.equal(done.status, 200, done.body.error);

  const doc = (await call('/api/rules', undefined, 'GET')).body;
  assert.deepEqual(doc.categories.map((c) => c.id), ['imported'], 'the file decides the rules');
  assert.equal(doc.currency, 'SEK');
  // The settings step ran before the import and describes what this account will
  // spend on reviews, which a document exported from another one cannot know.
  assert.equal(doc.aiMonths, 2);
  assert.equal(doc.aiWebSearch, true);
});

test('a review window outside the allowed range is refused, and nothing is set up', { skip }, async () => {
  const call = await newAccount('bad-months');
  const bad = await call('/api/onboarding', {
    lunchflow: 'lf-key', openai: 'oa-key', ai: { months: 0 },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /between 1 and/);

  const nonsense = await call('/api/onboarding', {
    lunchflow: 'lf-key', openai: 'oa-key', ai: { webSearch: 'yes' },
  });
  assert.equal(nonsense.status, 400);

  // Rejected before anything was written: the account is still at setup.
  assert.equal((await call('/api/me', undefined, 'GET')).body.onboarded, false);

  // And saying nothing at all about the AI is fine — the account then follows
  // whatever this deployment defaults to.
  const quiet = await call('/api/onboarding', { lunchflow: 'lf-key', openai: 'oa-key' });
  assert.equal(quiet.status, 200);
  const doc = (await call('/api/rules', undefined, 'GET')).body;
  assert.equal('aiMonths' in doc, false);
  assert.equal('aiWebSearch' in doc, false);
});

test('the categories step still works when the scan has been forgotten', { skip }, async () => {
  // Setup left open for half an hour, or a restart between the two steps. The
  // merchant names have to come from somewhere, so it pays for the pull again
  // rather than failing in the middle of setup.
  const call = await newAccount('no-scan');
  const suggested = await call('/api/onboarding/categories', { lunchflow: 'lf-key', openai: 'oa-key' });
  assert.equal(suggested.status, 200);
  assert.ok(suggested.body.categories.length);
  assert.ok(suggested.body.merchantsTotal > 0);
});
