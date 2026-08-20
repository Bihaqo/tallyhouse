'use strict';

// The signed-out demo. Two properties carry the weight here:
//
//   1. It is a *real* account — the dashboard, the categories and the AI review
//      all work through the ordinary code, because a demo that behaves
//      differently demonstrates the wrong thing.
//   2. It can never cost anything or become permanent. The endpoint that
//      creates it needs no sign-in, so anyone at all can reach whatever a demo
//      account can reach: no Lunchflow call, no OpenAI call, no stored key, no
//      place taken under the signup cap.
//
// Deliberately NOT run with MOCK_DATA=1: that would put the whole instance on
// generated data and prove nothing about the flag. This file runs the app as
// production runs it — live Lunchflow, no mock reviews — so a demo reading real
// data would show up as a failure rather than as a quiet success.

process.env.MAX_DEMO_ACCOUNTS = process.env.MAX_DEMO_ACCOUNTS || '25';
delete process.env.MOCK_DATA;
delete process.env.MOCK_REVIEWS;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

const h = require('./helpers/db'); // sets DATABASE_URL before src/ loads
const test = require('node:test');
const assert = require('node:assert/strict');
const skip = h.skip;

const demo = require('../src/demo');
const users = require('../src/users');

let base = null;

test.before(async () => {
  if (!h.dbAvailable) return;
  await h.initDb();
  await demo.load();
  const { app } = require('../server');
  await new Promise((resolve) => {
    const server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.unref();
  });
});

// Start a demo and return its session cookie.
async function startDemo() {
  const res = await fetch(`${base}/api/demo`, { method: 'POST' });
  assert.equal(res.status, 200, 'the demo is available');
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

const get = (path, cookie) => fetch(base + path, { headers: cookie ? { Cookie: cookie } : {} });
const post = (path, cookie, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body || {}),
  });

const userIdOf = async (cookie) => {
  const { rows } = await h.query(
    "SELECT (sess->>'userId')::bigint AS id FROM user_sessions WHERE sid = $1",
    [decodeURIComponent(cookie.replace('sid=s%3A', '').split('.')[0])]
  );
  return rows.length ? Number(rows[0].id) : null;
};

/* ---------- what a demo is ---------- */

test('a demo needs no sign-in and lands on a working dashboard', { skip }, async () => {
  const cookie = await startDemo();

  const me = await (await get('/api/me', cookie)).json();
  assert.equal(me.demo, true);
  assert.equal(me.onboarded, true, 'setup asks for keys a demo will never have, so it is skipped');
  assert.equal(me.email, null, 'the generated .invalid address is never shown to anyone');
  assert.equal(me.aiReview, true, 'the review is part of what there is to demonstrate');

  // The dashboard is the whole point: a demo that arrives at an empty page has
  // demonstrated nothing. These are the numbers the generator produces.
  const summary = await (await get('/api/summary', cookie)).json();
  assert.equal(summary.currency, 'GBP');
  assert.equal(summary.accounts.length, 3, 'three invented bank accounts');
  assert.ok(summary.months.length >= 12, 'a year of history to look at');
  assert.ok(summary.totals.avgMonthlySpend > 0, 'and spending in it');
  assert.ok(summary.totals.avgMonthlyIncome > 0,
    'and income — no excluded category may swallow the salaries');
  assert.ok(summary.categoriesThisMonth.length >= 4, 'sorted into categories, not one pile');
  assert.ok(summary.trackers.length >= 1, 'including a tracked category, which is a feature to show');
  assert.ok(summary.internalTransfersIgnored > 0, 'and transfers between its own accounts cancel out');

  // "Other" is not empty on purpose: two merchants in the generated data match
  // no rule, so there is something to classify and something to review.
  const other = summary.categoriesThisMonth.find((c) => c.category === 'Other');
  assert.ok(other && other.amount > 0, 'something is left for the visitor to sort out');
});

test('a demo has no keys, and reaches no third party to get its data', { skip }, async () => {
  const cookie = await startDemo();
  const id = await userIdOf(cookie);

  const { rows } = await h.query(
    'SELECT lunchflow_key, openai_key, is_demo FROM users WHERE id = $1', [id]
  );
  assert.equal(rows[0].is_demo, true);
  assert.equal(rows[0].lunchflow_key, null, 'no Lunchflow key exists to be spent');
  assert.equal(rows[0].openai_key, null, 'nor an OpenAI one');

  // The instance is on live Lunchflow (see the header of this file), so a
  // summary that answers at all proves the per-account switch, not the env.
  assert.equal(process.env.MOCK_DATA, undefined, 'this test would be vacuous otherwise');
  assert.equal((await get('/api/summary', cookie)).status, 200);
});

test('the AI review runs on the mock reviewer and bills nothing', { skip }, async () => {
  const cookie = await startDemo();
  const id = await userIdOf(cookie);

  const sweep = await post('/api/reviews/sweep', cookie);
  assert.equal(sweep.status, 200, 'no OpenAI key, and yet the sweep starts');

  // Wait for it to make at least one review; the mock reviewer is fast.
  let reviews = 0;
  for (let i = 0; i < 40 && reviews === 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const { rows } = await h.query('SELECT count(*)::int AS n FROM ai_reviews WHERE user_id = $1', [id]);
    reviews = rows[0].n;
  }
  assert.ok(reviews > 0, 'reviews are produced');

  const { rows: sample } = await h.query(
    'SELECT review FROM ai_reviews WHERE user_id = $1 LIMIT 1', [id]
  );
  assert.equal(sample[0].review.model, 'mock',
    'stored as what produced it, so a demo review is never mistaken for a paid one');

  const usage = await (await get('/api/ai-usage', cookie)).json();
  assert.equal(usage.costUsd, 0, 'nothing was billed');
  assert.equal(usage.calls, 0, 'because nothing was called');
});

/* ---------- what a demo may not do ---------- */

test('a demo cannot store keys, join the waiting list, or run setup', { skip }, async () => {
  const cookie = await startDemo();

  // Storing a key is the one that matters: it would turn an account anyone can
  // create into an account that spends money.
  const keys = await post('/api/keys', cookie, { openai: 'sk-not-a-real-key' });
  assert.equal(keys.status, 403);
  assert.match((await keys.json()).error, /sign in/i, 'and says what to do instead');

  assert.equal((await post('/api/waitlist', cookie)).status, 403);
  assert.equal((await post('/api/onboarding', cookie, { lunchflow: 'lf' })).status, 403);

  const id = await userIdOf(cookie);
  const { rows } = await h.query('SELECT openai_key FROM users WHERE id = $1', [id]);
  assert.equal(rows[0].openai_key, null, 'and nothing was written on the way to the 403');
});

test('a demo does not take a place under the signup cap', { skip }, async () => {
  const before = await users.countUsers();
  await startDemo();
  assert.equal(await users.countUsers(), before,
    'a click is not a signup; counting it would let passers-by fill the instance');
});

test('demo accounts are absent from every figure in the admin panel', { skip }, async () => {
  const cookie = await startDemo();
  await post('/api/reviews/sweep', cookie); // give it some activity to be counted by mistake

  const admin = require('../src/admin');
  const stats = await admin.stats();
  const totals = await users.countUsers();
  assert.equal(stats.totals.total, totals, 'the headline count is real accounts only');
  assert.equal(stats.funnel.find((s) => s.step === 'Signed in').count, totals);
  // A demo is onboarded at creation, so it would otherwise inflate exactly the
  // number an operator reads as "people who got through setup".
  assert.ok(stats.perAccount.accounts <= totals);
});

/* ---------- how a demo ends ---------- */

test('the account is deleted once no live session points at it', { skip }, async () => {
  const cookie = await startDemo();
  const id = await userIdOf(cookie);

  // Newly created accounts are left alone whatever their sessions say: the
  // grace period covers the gap between the INSERT and the session write.
  await h.query('DELETE FROM user_sessions WHERE (sess->>\'userId\')::bigint = $1', [id]);
  await demo.reap();
  assert.ok(await users.byId(id), 'still here, because it was made a moment ago');

  // Older than the grace period and with nobody using it: gone, and with it
  // everything it owned.
  await h.query("UPDATE users SET created_at = now() - interval '2 hours' WHERE id = $1", [id]);
  await demo.reap();
  assert.equal(await users.byId(id), null);
  const { rows } = await h.query('SELECT count(*)::int AS n FROM rules WHERE user_id = $1', [id]);
  assert.equal(rows[0].n, 0, 'the cascade took its categories with it');
  assert.equal(demo.isDemo(id), false, 'and this process stopped calling it a demo');
});

test('a demo in use is not reaped, however old it is', { skip }, async () => {
  const cookie = await startDemo();
  const id = await userIdOf(cookie);
  await h.query("UPDATE users SET created_at = now() - interval '30 days' WHERE id = $1", [id]);

  await demo.reap();
  assert.ok(await users.byId(id), 'the live session is what keeps it alive');
  assert.equal((await get('/api/summary', cookie)).status, 200, 'and it still works');
});

test('an expired session is not a live one', { skip }, async () => {
  const cookie = await startDemo();
  const id = await userIdOf(cookie);
  await h.query("UPDATE users SET created_at = now() - interval '2 hours' WHERE id = $1", [id]);
  await h.query(
    "UPDATE user_sessions SET expire = now() - interval '1 minute' WHERE (sess->>'userId')::bigint = $1",
    [id]
  );

  await demo.reap();
  assert.equal(await users.byId(id), null, 'the cookie outlived nothing');
});

/* ---------- switching it off ---------- */

test('MAX_DEMO_ACCOUNTS=0 turns the demo off entirely', { skip }, async () => {
  const original = process.env.MAX_DEMO_ACCOUNTS;
  process.env.MAX_DEMO_ACCOUNTS = '0';
  try {
    const res = await fetch(`${base}/api/demo`, { method: 'POST' });
    assert.equal(res.status, 404, 'not 403 — an instance without a demo has no such thing');
    const cfg = await (await get('/api/auth-config')).json();
    assert.equal(cfg.demo, false, 'and the login page does not offer it');
  } finally {
    process.env.MAX_DEMO_ACCOUNTS = original;
  }
});

test('the cap refuses politely rather than making unbounded accounts', { skip }, async () => {
  const original = process.env.MAX_DEMO_ACCOUNTS;
  // Already at or over the limit, whatever this database happens to hold.
  process.env.MAX_DEMO_ACCOUNTS = String(Math.max(1, demo.liveCount()));
  try {
    const res = await fetch(`${base}/api/demo`, { method: 'POST' });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /try again/i, 'a queue, not a fault');
  } finally {
    process.env.MAX_DEMO_ACCOUNTS = original;
  }
});

/* ---------- the starting categories ---------- */

test('the starting document is one the app will accept', { skip: false }, () => {
  // It is a constant in src/demo.js rather than something a user typed, so a
  // typo in it would only surface when somebody clicked the demo button.
  const rules = require('../src/rules');
  const doc = demo.demoDocument();
  assert.equal(rules.validate(doc), null);
  assert.equal(doc.categories.filter((c) => c.autoTransfers).length, 1);
  assert.ok(doc.categories.some((c) => c.tracker), 'a tracked category is a feature worth showing');
  assert.ok(doc.categories.every((c) => c.patterns.length || c.autoTransfers),
    'a category with no patterns catches nothing and shows an empty row');
});
